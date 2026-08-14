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

interface OrgInviteRow {
  id: string;
  token?: string;
  role: "admin" | "editor" | "viewer";
  status: string;
  created_at: string;
  organizations: { id: string; name: string } | { id: string; name: string }[] | null;
}

function orgOf(row: OrgInviteRow) {
  return Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
}

// The RLS select policy on org_invites is an OR — admin-of-org OR
// invitee-by-email — so an admin who queries this table also sees their own
// org's invites (meant for other people). This endpoint is "my invites," so
// it must filter by the caller's own email explicitly rather than trusting
// RLS to have already scoped it correctly. Same reasoning as listMyInvites.
export async function listMyOrgInvites(req: Request, res: Response): Promise<void> {
  const email = req.user!.email?.toLowerCase();
  if (!email) {
    res.status(200).json({ invites: [] });
    return;
  }

  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("org_invites")
    .select("id, token, role, status, created_at, organizations ( id, name )")
    .eq("email", email)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    throw new HttpError(500, "Could not load your invites.");
  }

  const invites = (data as unknown as OrgInviteRow[]).map((row) => {
    const org = orgOf(row);
    return {
      id: row.id,
      token: row.token,
      orgId: org?.id ?? null,
      orgName: org?.name ?? "Unknown organization",
      role: row.role,
      createdAt: row.created_at,
    };
  });

  res.status(200).json({ invites });
}

export async function getOrgInviteByToken(req: Request, res: Response): Promise<void> {
  const token = requireTokenParam(req);
  const supabase = userScopedClient(req);
  const { data, error } = await supabase
    .from("org_invites")
    .select("id, role, status, created_at, organizations ( id, name )")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not load this invite.");
  }
  // RLS only returns this row if the caller's own email matches — a no-match
  // and a real 404 look identical to the caller either way.
  if (!data) {
    throw new HttpError(404, "Invite not found");
  }

  const row = data as unknown as OrgInviteRow;
  const org = orgOf(row);
  res.status(200).json({
    id: row.id,
    orgId: org?.id ?? null,
    orgName: org?.name ?? "Unknown organization",
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  });
}

export async function acceptOrgInvite(req: Request, res: Response): Promise<void> {
  const token = requireTokenParam(req);
  const supabase = userScopedClient(req);
  const { data, error } = await supabase.rpc("accept_org_invite", { p_token: token });

  if (error || !data) {
    if (error?.code === "P0002") {
      throw new HttpError(404, "Invite not found");
    }
    if (error?.code === "42501") {
      throw new HttpError(403, "This invite was sent to a different email address.");
    }
    if (error?.code === "22023") {
      throw new HttpError(409, "This invite is no longer pending.");
    }
    throw new HttpError(500, "Could not accept this invite.");
  }

  const orgId = (data as { org_id: string }).org_id;

  // The accepter is an org member as of the RPC above, so the append policy
  // passes. Declines are deliberately NOT recorded: a decliner never becomes a
  // member, so they have no write access to the org's trail.
  await recordOrgActivity(supabase, {
    orgId,
    actorId: req.user!.id,
    actorLabel: req.user!.email ?? "Unknown",
    eventType: "member",
    summary: "joined the organization",
  });

  res.status(200).json({ orgId });
}

export async function declineOrgInvite(req: Request, res: Response): Promise<void> {
  const token = requireTokenParam(req);
  const supabase = userScopedClient(req);
  const { error, count } = await supabase
    .from("org_invites")
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
