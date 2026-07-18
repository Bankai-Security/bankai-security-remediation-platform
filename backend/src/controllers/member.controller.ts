import type { Request, Response } from "express";
import { env } from "../env.js";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { requireRole } from "../lib/roles.js";
import { createUserScopedSupabaseClient, supabaseAdmin } from "../lib/supabase.js";
import type { InviteMemberInput, UpdateMemberRoleInput } from "../schemas/member.schema.js";

function userScopedClient(req: Request) {
  return createUserScopedSupabaseClient(req.accessToken as string);
}

interface MemberRow {
  id: string;
  user_id: string;
  role: "admin" | "editor" | "viewer";
  email: string;
  created_at: string;
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
}

function memberName(row: MemberRow): string {
  const rel = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  return rel?.full_name?.trim() || row.email;
}

// The owner isn't a project_members row (that table only holds
// admin/editor/viewer), so their entry is synthesized here — full_name
// from profiles, email from a single admin lookup (profiles has no email
// column; every other member's email is a denormalized snapshot captured
// at accept time, so this is the only per-request admin call needed).
export async function listMembers(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  const supabase = userScopedClient(req);

  const [{ data: ownerProfile }, { data: memberRows, error: membersError }, { data: inviteRows, error: invitesError }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", project.ownerId).maybeSingle(),
    // project_members has two FKs to profiles (user_id and invited_by), so
    // the embed must name which one — otherwise PostgREST can't tell which
    // relationship "profiles ( full_name )" is supposed to follow and
    // errors out entirely.
    supabase
      .from("project_members")
      .select("id, user_id, role, email, created_at, profiles!project_members_user_id_fkey ( full_name )")
      .eq("project_id", project.id)
      .order("created_at", { ascending: true }),
    // token included so an admin can re-copy a pending invite's link later
    // — safe, since this list is only ever visible to owners/admins of the
    // project (the invites SELECT RLS policy), i.e. exactly the people who
    // are meant to be sharing that link in the first place.
    supabase
      .from("project_invites")
      .select("id, email, role, token, created_at")
      .eq("project_id", project.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
  ]);

  if (membersError || invitesError) {
    logger.error({ membersError, invitesError, projectId: project.id }, "Could not load project members");
    throw new HttpError(500, "Could not load project members.");
  }

  const { data: ownerAuth } = await supabaseAdmin.auth.admin.getUserById(project.ownerId);
  const ownerEmail = ownerAuth?.user?.email ?? null;

  const members = [
    {
      id: "owner",
      userId: project.ownerId,
      name: ownerProfile?.full_name?.trim() || ownerEmail || "Owner",
      email: ownerEmail,
      role: "owner" as const,
    },
    ...((memberRows ?? []) as MemberRow[]).map((row) => ({
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

export async function inviteMember(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const { email, role } = req.body as InviteMemberInput;
  const supabase = userScopedClient(req);

  const { data: existingMember } = await supabase
    .from("project_members")
    .select("id")
    .eq("project_id", project.id)
    .eq("email", email)
    .maybeSingle();
  if (existingMember) {
    throw new HttpError(409, "This person is already a member of this project.");
  }

  const { data: invite, error } = await supabase
    .from("project_invites")
    .insert({ project_id: project.id, email, role, invited_by: req.user!.id })
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
    inviteUrl: `${env.FRONTEND_ORIGIN}/invites/${invite.token}`,
  });
}

export async function updateMemberRole(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const { role } = req.body as UpdateMemberRoleInput;
  const supabase = userScopedClient(req);

  const { data, error } = await supabase
    .from("project_members")
    .update({ role })
    .eq("id", req.params.memberId)
    .eq("project_id", project.id)
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

export async function removeMember(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  const { error, count } = await supabase
    .from("project_members")
    .delete({ count: "exact" })
    .eq("id", req.params.memberId)
    .eq("project_id", project.id);

  if (error) {
    throw new HttpError(500, "Could not remove this member.");
  }
  if (!count) {
    throw new HttpError(404, "Member not found");
  }

  res.status(204).send();
}

export async function revokeInvite(req: Request, res: Response): Promise<void> {
  const project = req.project!;
  requireRole(project.myRole, ["owner", "admin"]);
  const supabase = userScopedClient(req);

  const { error, count } = await supabase
    .from("project_invites")
    .update({ status: "revoked", responded_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", req.params.inviteId)
    .eq("project_id", project.id)
    .eq("status", "pending");

  if (error) {
    throw new HttpError(500, "Could not revoke this invite.");
  }
  if (!count) {
    throw new HttpError(404, "Invite not found");
  }

  res.status(204).send();
}
