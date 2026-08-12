import type { Request, Response } from "express";
import { env } from "../env.js";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient, supabaseAdmin } from "../lib/supabase.js";
import type { InviteOrgMemberInput, UpdateOrgMemberRoleInput } from "../schemas/org.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface OrgMemberRow {
  id: string;
  user_id: string;
  role: "admin" | "editor" | "viewer";
  email: string;
  created_at: string;
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
}

function memberName(row: OrgMemberRow): string {
  const rel = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  return rel?.full_name?.trim() || row.email;
}

// The owner isn't an org_members row (that table only holds
// admin/editor/viewer), so their entry is synthesized here — full_name from
// profiles, email from a single admin lookup (profiles has no email column;
// every other member's email is a denormalized snapshot captured at accept
// time, so this is the only per-request admin call needed). Same pattern as
// listMembers for projects.
export async function listOrgMembers(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  const supabase = userScopedClient(req);

  const [{ data: ownerProfile }, { data: memberRows, error: membersError }, { data: inviteRows, error: invitesError }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", org.ownerId).maybeSingle(),
    // org_members has two FKs to profiles (user_id and invited_by), so the
    // embed must name which one — otherwise PostgREST can't tell which
    // relationship "profiles ( full_name )" should follow and errors out.
    supabase
      .from("org_members")
      .select("id, user_id, role, email, created_at, profiles!org_members_user_id_fkey ( full_name )")
      .eq("org_id", org.id)
      .order("created_at", { ascending: true }),
    // token included so an admin can re-copy a pending invite's link later —
    // safe, since this list is only visible to owners/admins of the org (the
    // org_invites SELECT RLS policy), i.e. exactly the people meant to be
    // sharing that link.
    supabase
      .from("org_invites")
      .select("id, email, role, token, created_at")
      .eq("org_id", org.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
  ]);

  if (membersError || invitesError) {
    logger.error({ membersError, invitesError, orgId: org.id }, "Could not load organization members");
    throw new HttpError(500, "Could not load organization members.");
  }

  const { data: ownerAuth } = await supabaseAdmin.auth.admin.getUserById(org.ownerId);
  const ownerEmail = ownerAuth?.user?.email ?? null;

  const members = [
    {
      id: "owner",
      userId: org.ownerId,
      name: ownerProfile?.full_name?.trim() || ownerEmail || "Owner",
      email: ownerEmail,
      role: "owner" as const,
    },
    ...((memberRows ?? []) as OrgMemberRow[]).map((row) => ({
      id: row.id,
      userId: row.user_id,
      name: memberName(row),
      email: row.email,
      role: row.role,
    })),
  ];

  const invites = (inviteRows ?? []).map((row) => ({
    id: row.id,
    token: row.token,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
  }));

  res.status(200).json({ members, invites });
}

export async function inviteOrgMember(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  requireRole(org.myRole, ["owner", "admin"]);
  const { email, role } = req.body as InviteOrgMemberInput;
  const supabase = userScopedClient(req);

  const { data: existingMember } = await supabase
    .from("org_members")
    .select("id")
    .eq("org_id", org.id)
    .eq("email", email)
    .maybeSingle();
  if (existingMember) {
    throw new HttpError(409, "This person is already a member of this organization.");
  }

  const { data: invite, error } = await supabase
    .from("org_invites")
    .insert({ org_id: org.id, email, role, invited_by: req.user!.id })
    .select("id, token, email, role, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new HttpError(409, "There is already a pending invite for this email.");
    }
    throw new HttpError(500, "Could not create this invite.");
  }

  res.status(201).json({
    invite: { id: invite.id, email: invite.email, role: invite.role, createdAt: invite.created_at },
    inviteUrl: `${env.FRONTEND_ORIGIN}/org-invites/${invite.token}`,
  });
}

export async function updateOrgMemberRole(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  requireRole(org.myRole, ["owner", "admin"]);
  const { role } = req.body as UpdateOrgMemberRoleInput;
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("org_members")
    .update({ role })
    .eq("id", req.params.memberId)
    .eq("org_id", org.id)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Could not update this member's role.");
  }
  if (!data) {
    throw new HttpError(404, "Member not found");
  }

  res.status(200).json({ ok: true });
}

export async function removeOrgMember(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  requireRole(org.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  const { error, count } = await supabase
    .from("org_members")
    .delete({ count: "exact" })
    .eq("id", req.params.memberId)
    .eq("org_id", org.id);

  if (error) {
    throw new HttpError(500, "Could not remove this member.");
  }
  if (!count) {
    throw new HttpError(404, "Member not found");
  }

  res.status(204).send();
}

export async function revokeOrgInvite(req: Request, res: Response): Promise<void> {
  const org = req.org!;
  requireRole(org.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  const { error, count } = await supabase
    .from("org_invites")
    .update({ status: "revoked", responded_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", req.params.inviteId)
    .eq("org_id", org.id)
    .eq("status", "pending");

  if (error) {
    throw new HttpError(500, "Could not revoke this invite.");
  }
  if (!count) {
    throw new HttpError(404, "Invite not found");
  }

  res.status(204).send();
}
