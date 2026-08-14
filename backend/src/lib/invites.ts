import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http-error.js";

type InviteTable = "project_invites" | "org_invites" | "team_invites";

// Per-user creation throttle: at most 20 invites per table per hour. A plain
// DB count — no new infra — layered on top of the baseline Arcjet protection.
// Counts every invite the user created regardless of status, so revoke/resend
// churn can't be used to reset the window.
const INVITE_HOURLY_LIMIT = 20;

export async function assertInviteRateLimit(supabase: SupabaseClient, table: InviteTable, userId: string): Promise<void> {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("invited_by", userId)
    .gt("created_at", windowStart);

  if (error) {
    throw new HttpError(500, "Could not create this invite.");
  }
  if ((count ?? 0) >= INVITE_HOURLY_LIMIT) {
    throw new HttpError(429, "You're sending invites too quickly. Try again in an hour.");
  }
}

export interface ResendInviteInput {
  table: InviteTable;
  scopeColumn: "project_id" | "org_id" | "team_id";
  scopeId: string;
  inviteId: string;
  invitedBy: string;
}

export interface ResentInvite {
  id: string;
  token: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
}

// Re-issues a pending (possibly expired) invite: revokes the old row and
// creates a fresh one with the same email/role but a new token and expiry.
// This is the only path to a new link for an expired invite — the
// one-pending-per-email partial unique index still counts an expired pending
// row, so a plain re-invite would 409. Two writes, not a transaction: if the
// insert fails after the revoke the admin just invites again, which — unlike a
// project losing its teams — has no lasting cost.
export async function resendInvite(supabase: SupabaseClient, input: ResendInviteInput): Promise<ResentInvite> {
  const { data: revoked, error: revokeError } = await supabase
    .from(input.table)
    .update({ status: "revoked", responded_at: new Date().toISOString() })
    .eq("id", input.inviteId)
    .eq(input.scopeColumn, input.scopeId)
    .eq("status", "pending")
    .select("email, role");

  if (revokeError) {
    throw new HttpError(500, "Could not resend this invite.");
  }
  const old = revoked?.[0];
  if (!old) {
    throw new HttpError(404, "Invite not found");
  }

  const { data: fresh, error: insertError } = await supabase
    .from(input.table)
    .insert({ [input.scopeColumn]: input.scopeId, email: old.email, role: old.role, invited_by: input.invitedBy })
    .select("id, token, email, role, created_at, expires_at")
    .single();

  if (insertError || !fresh) {
    throw new HttpError(500, "The old invite was revoked, but a new one could not be created. Invite them again.");
  }

  return fresh as ResentInvite;
}
