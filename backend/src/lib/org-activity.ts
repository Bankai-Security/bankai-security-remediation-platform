import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";

// Org-scope counterpart to lib/activity.ts — same best-effort contract: a
// failed audit write must never fail the mutation that triggered it.

export interface RecordOrgActivityInput {
  orgId: string;
  teamId?: string | null;
  actorId: string | null;
  actorLabel: string;
  eventType: "org" | "team" | "member" | "invite";
  summary: string;
  meta?: string | null;
}

export async function recordOrgActivity(supabase: SupabaseClient, input: RecordOrgActivityInput): Promise<void> {
  const { error } = await supabase.from("org_activity_events").insert({
    org_id: input.orgId,
    team_id: input.teamId ?? null,
    actor_id: input.actorId,
    actor_label: input.actorLabel,
    event_type: input.eventType,
    summary: input.summary,
    meta: input.meta ?? null,
  });

  if (error) {
    logger.error({ err: error, input }, "Failed to record org activity event");
  }
}

export interface OrgActivityEventRow {
  id: string;
  event_type: string;
  actor_label: string;
  summary: string;
  meta: string | null;
  created_at: string;
}

export function toPublicOrgActivityEvent(row: OrgActivityEventRow) {
  return {
    id: row.id,
    type: row.event_type,
    actor: row.actor_label,
    summary: row.summary,
    meta: row.meta,
    createdAt: row.created_at,
  };
}
