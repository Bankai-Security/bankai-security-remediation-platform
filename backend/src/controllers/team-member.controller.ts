import type { Request, Response } from "express";
import { env } from "../env.js";
import { HttpError } from "../lib/http-error.js";
import { assertInviteRateLimit, resendInvite } from "../lib/invites.js";
import { logger } from "../lib/logger.js";
import { recordOrgActivity } from "../lib/org-activity.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient } from "../lib/supabase.js";
import type { InviteTeamMemberInput, UpdateTeamMemberRoleInput } from "../schemas/team.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface TeamMemberRow {
  id: string;
  user_id: string;
  role: "admin" | "editor" | "viewer";
  email: string;
  created_at: string;
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
}

function memberName(row: TeamMemberRow): string {
  const rel = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  return rel?.full_name?.trim() || row.email;
}

// A team has no owner_id (ownership lives at the org), so — unlike listOrgMembers
// / listMembers — there's no synthesized owner row. The roster is exactly the
// explicit team_members plus pending team_invites. Org owners/admins can still
// manage the team (team_role grants them 'admin') even though they aren't rows
// here.
export async function listTeamMembers(req: Request, res: Response): Promise<void> {
  const team = req.team!;
  const supabase = userScopedClient(req);

  const [{ data: memberRows, error: membersError }, { data: inviteRows, error: invitesError }] = await Promise.all([
    // team_members has two FKs to profiles (user_id and invited_by), so the
    // embed must name which one.
    supabase
      .from("team_members")
      .select("id, user_id, role, email, created_at, profiles!team_members_user_id_fkey ( full_name )")
      .eq("team_id", team.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("team_invites")
      .select("id, email, role, token, created_at, expires_at")
      .eq("team_id", team.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
  ]);

  if (membersError || invitesError) {
    logger.error({ membersError, invitesError, teamId: team.id }, "Could not load team members");
    throw new HttpError(500, "Could not load team members.");
  }

  const members = ((memberRows ?? []) as TeamMemberRow[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    name: memberName(row),
    email: row.email,
    role: row.role,
  }));

  const invites = (inviteRows ?? []).map((row) => ({
    id: row.id,
    token: row.token,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));

  res.status(200).json({ members, invites });
}

export async function inviteTeamMember(req: Request, res: Response): Promise<void> {
  const team = req.team!;
  requireRole(team.myRole, ["owner", "admin"]);
  const { email, role } = req.body as InviteTeamMemberInput;
  const supabase = userScopedClient(req);

  await assertInviteRateLimit(supabase, "team_invites", req.user!.id);

  const { data: existingMember } = await supabase
    .from("team_members")
    .select("id")
    .eq("team_id", team.id)
    .eq("email", email)
    .maybeSingle();
  if (existingMember) {
    throw new HttpError(409, "This person is already a member of this team.");
  }

  const { data: invite, error } = await supabase
    .from("team_invites")
    .insert({ team_id: team.id, email, role, invited_by: req.user!.id })
    .select("id, token, email, role, created_at, expires_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new HttpError(409, "There is already a pending invite for this email.");
    }
    throw new HttpError(500, "Could not create this invite.");
  }

  await recordOrgActivity(supabase, {
    orgId: team.orgId,
    teamId: team.id,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "invite",
    summary: `invited ${invite.email} to team "${team.name}" as ${invite.role}`,
  });

  res.status(201).json({
    invite: { id: invite.id, email: invite.email, role: invite.role, createdAt: invite.created_at, expiresAt: invite.expires_at },
    inviteUrl: `${env.FRONTEND_ORIGIN}/team-invites/${invite.token}`,
  });
}

// POST .../teams/:teamId/members/invites/:inviteId/resend — same contract as
// resendOrgInvite, scoped to the team.
export async function resendTeamInvite(req: Request, res: Response): Promise<void> {
  const team = req.team!;
  requireRole(team.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  await assertInviteRateLimit(supabase, "team_invites", req.user!.id);

  const fresh = await resendInvite(supabase, {
    table: "team_invites",
    scopeColumn: "team_id",
    scopeId: team.id,
    inviteId: req.params.inviteId as string,
    invitedBy: req.user!.id,
  });

  await recordOrgActivity(supabase, {
    orgId: team.orgId,
    teamId: team.id,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "invite",
    summary: `resent the team "${team.name}" invite for ${fresh.email}`,
  });

  res.status(201).json({
    invite: { id: fresh.id, email: fresh.email, role: fresh.role, createdAt: fresh.created_at, expiresAt: fresh.expires_at },
    inviteUrl: `${env.FRONTEND_ORIGIN}/team-invites/${fresh.token}`,
  });
}

export async function updateTeamMemberRole(req: Request, res: Response): Promise<void> {
  const team = req.team!;
  requireRole(team.myRole, ["owner", "admin"]);
  const { role } = req.body as UpdateTeamMemberRoleInput;
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("team_members")
    .update({ role })
    .eq("id", req.params.memberId)
    .eq("team_id", team.id)
    .select("id, email")
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not update this member's role.");
  }
  if (!data) {
    throw new HttpError(404, "Member not found");
  }

  await recordOrgActivity(supabase, {
    orgId: team.orgId,
    teamId: team.id,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "member",
    summary: `changed ${data.email ?? "a member"}'s role in team "${team.name}" to ${role}`,
  });

  res.status(200).json({ ok: true });
}

export async function removeTeamMember(req: Request, res: Response): Promise<void> {
  const team = req.team!;
  requireRole(team.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  // DELETE ... RETURNING via .select() so the audit summary can name who was
  // removed without a separate lookup.
  const { data: removed, error } = await supabase
    .from("team_members")
    .delete()
    .eq("id", req.params.memberId)
    .eq("team_id", team.id)
    .select("email");

  if (error) {
    throw new HttpError(500, "Could not remove this member.");
  }
  if (!removed || removed.length === 0) {
    throw new HttpError(404, "Member not found");
  }

  await recordOrgActivity(supabase, {
    orgId: team.orgId,
    teamId: team.id,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "member",
    summary: `removed ${removed[0]?.email ?? "a member"} from team "${team.name}"`,
  });

  res.status(204).send();
}

export async function revokeTeamInvite(req: Request, res: Response): Promise<void> {
  const team = req.team!;
  requireRole(team.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  const { data: revoked, error } = await supabase
    .from("team_invites")
    .update({ status: "revoked", responded_at: new Date().toISOString() })
    .eq("id", req.params.inviteId)
    .eq("team_id", team.id)
    .eq("status", "pending")
    .select("email");

  if (error) {
    throw new HttpError(500, "Could not revoke this invite.");
  }
  if (!revoked || revoked.length === 0) {
    throw new HttpError(404, "Invite not found");
  }

  await recordOrgActivity(supabase, {
    orgId: team.orgId,
    teamId: team.id,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "invite",
    summary: `revoked the team "${team.name}" invite for ${revoked[0]?.email ?? "a pending member"}`,
  });

  res.status(204).send();
}
