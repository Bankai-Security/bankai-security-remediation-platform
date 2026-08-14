import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { recordOrgActivity } from "../lib/org-activity.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTokenParam(req: Request): string {
  const { token } = req.params;
  if (typeof token !== "string" || !UUID_RE.test(token)) {
    throw new HttpError(404, "Invite not found");
  }
  return token;
}

interface TeamRel {
  id: string;
  name: string;
  organizations: { id: string; name: string } | { id: string; name: string }[] | null;
}

interface TeamInviteRow {
  id: string;
  token?: string;
  role: "admin" | "editor" | "viewer";
  status: string;
  created_at: string;
  teams: TeamRel | TeamRel[] | null;
}

function teamOf(row: TeamInviteRow): TeamRel | null {
  return Array.isArray(row.teams) ? (row.teams[0] ?? null) : row.teams;
}

function orgOf(team: TeamRel | null) {
  if (!team) return null;
  return Array.isArray(team.organizations) ? (team.organizations[0] ?? null) : team.organizations;
}

// "My invites" — filter by the caller's own email explicitly, since the
// team_invites RLS select policy is an OR (team-admin OR invitee-by-email) and
// an admin would otherwise also see invites meant for other people. Same
// reasoning as listMyOrgInvites / listMyInvites.
export async function listMyTeamInvites(req: Request, res: Response): Promise<void> {
  const email = req.user!.email?.toLowerCase();
  if (!email) {
    res.status(200).json({ invites: [] });
    return;
  }

  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("team_invites")
    .select("id, token, role, status, created_at, teams ( id, name, organizations ( id, name ) )")
    .eq("email", email)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (error) {
    throw new HttpError(500, "Could not load your invites.");
  }

  const invites = (data as unknown as TeamInviteRow[]).map((row) => {
    const team = teamOf(row);
    const org = orgOf(team);
    return {
      id: row.id,
      token: row.token,
      teamId: team?.id ?? null,
      teamName: team?.name ?? "Unknown team",
      orgId: org?.id ?? null,
      orgName: org?.name ?? "Unknown organization",
      role: row.role,
      createdAt: row.created_at,
    };
  });

  res.status(200).json({ invites });
}

export async function getTeamInviteByToken(req: Request, res: Response): Promise<void> {
  const token = requireTokenParam(req);
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("team_invites")
    .select("id, role, status, created_at, teams ( id, name, organizations ( id, name ) )")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not load this invite.");
  }
  if (!data) {
    throw new HttpError(404, "Invite not found");
  }

  const row = data as unknown as TeamInviteRow;
  const team = teamOf(row);
  const org = orgOf(team);
  res.status(200).json({
    id: row.id,
    teamId: team?.id ?? null,
    teamName: team?.name ?? "Unknown team",
    orgId: org?.id ?? null,
    orgName: org?.name ?? "Unknown organization",
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  });
}

export async function acceptTeamInvite(req: Request, res: Response): Promise<void> {
  const token = requireTokenParam(req);
  const supabase = userScopedClient(req);
  const { data, error } = await supabase.rpc("accept_team_invite", { p_token: token });

  if (error || !data) {
    if (error?.code === "P0002") {
      throw new HttpError(404, "Invite not found");
    }
    if (error?.code === "42501") {
      throw new HttpError(403, `This invite was sent to a different email address (you're signed in as ${req.user!.email ?? "an account with no email"}).`);
    }
    if (error?.code === "22023") {
      // "no longer pending" vs "expired" — the RPC's message says which.
      throw new HttpError(409, error.message);
    }
    throw new HttpError(500, "Could not accept this invite.");
  }

  // Resolve the org for redirect. The RPC just made the caller at least an org
  // viewer, so this team row is now visible to them.
  const teamId = (data as { team_id: string }).team_id;
  const { data: team } = await supabase.from("teams").select("org_id, name").eq("id", teamId).maybeSingle();

  // The accepter is an org member as of the RPC above, so the append policy
  // passes. Declines are deliberately not recorded (a decliner never becomes
  // a member, so they have no write access to the org's trail).
  if (team?.org_id) {
    await recordOrgActivity(supabase, {
      orgId: team.org_id,
      teamId,
      actorId: req.user!.id,
      actorLabel: req.user!.email ?? "Unknown",
      eventType: "member",
      summary: `joined team "${team.name}"`,
    });
  }

  res.status(200).json({ teamId, orgId: team?.org_id ?? null });
}

export async function declineTeamInvite(req: Request, res: Response): Promise<void> {
  const token = requireTokenParam(req);
  const supabase = userScopedClient(req);
  const { error, count } = await supabase
    .from("team_invites")
    .update({ status: "declined", responded_at: new Date().toISOString() }, { count: "exact" })
    .eq("token", token)
    .eq("status", "pending");

  if (error) {
    throw new HttpError(500, "Could not decline this invite.");
  }
  if (!count) {
    throw new HttpError(404, "Invite not found");
  }

  res.status(204).send();
}
