import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const RemediationState = z.enum([
  "DISCOVERED", "TRIAGED", "PATCH_GENERATED", "VERIFICATION_PENDING", "VERIFYING",
  "VERIFICATION_FAILED", "PATCH_REVISION", "VERIFIED", "PR_PUBLISHED", "CANCELLED",
  "ESCALATED", "BLOCKED", "VERIFICATION_INCOMPLETE",
]);
const common = { schema_version: z.literal("1.0"), command_key: z.string().min(1).max(128) };
const existing = { ...common, remediation_id: z.uuid(), expected_revision: z.number().int().nonnegative() };
const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const RemediationCommand = z.discriminatedUnion("action", [
  z.strictObject({ ...common, action: z.literal("create"), project_id: z.uuid(), finding_id: z.uuid(), repository_id: z.string().min(1).max(2048), retry_limit: z.number().int().min(0).max(20).default(2) }),
  z.strictObject({ ...existing, action: z.literal("start_attempt"), patch_digest: z.string().regex(/^sha256-[0-9a-f]{64}$/), base_sha: sha, candidate_sha: sha, verification_profile: z.string().min(1).max(128) })
    .refine((value) => value.base_sha !== value.candidate_sha, "Candidate must differ from baseline"),
  z.strictObject({ ...existing, action: z.literal("transition"), state: RemediationState,
    quincy_job_id: z.string().min(1).max(128).optional(), quincy_scan_execution_id: z.string().min(1).max(128).optional(), jenkins_build_id: z.string().min(1).max(256).optional(),
    verification_id: z.uuid().optional(),
    failure_classification: z.enum(["security", "build", "test", "timeout", "cancelled", "incomplete", "infrastructure", "policy", "retry_exhausted", "human"]).optional(),
    diagnostic: z.string().min(1).max(4096).optional(),
  }).superRefine((value, ctx) => {
    if (value.state === "VERIFYING" && !value.quincy_job_id) ctx.addIssue({ code: "custom", message: "Execution ID required" });
    if (value.state === "VERIFIED" && (!value.verification_id || !value.quincy_job_id || !value.quincy_scan_execution_id)) ctx.addIssue({ code: "custom", message: "Persisted verification reference required" });
    if (["VERIFICATION_FAILED", "VERIFICATION_INCOMPLETE", "CANCELLED", "ESCALATED", "BLOCKED"].includes(value.state) && (!value.failure_classification || !value.diagnostic)) ctx.addIssue({ code: "custom", message: "Structured failure required" });
  }),
]);
export const RemediationRecord = z.object({
  id: z.uuid(), schema_version: z.literal("1.0"), project_id: z.uuid(), finding_id: z.uuid(),
  repository_id: z.string(), state: RemediationState, retry_limit: z.number().int(), attempt_count: z.number().int(),
  revision: z.number().int(), current_attempt_id: z.uuid().nullable(),
  failure_classification: z.string().nullable(), diagnostic: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(),
});
export type RemediationRecord = z.infer<typeof RemediationRecord>;

/** The database serializes transitions, stores command receipts and checks evidence.
 * Retries MUST reuse the exact command key and payload; never retry with a new key.
 * Only a server-side service-role client may invoke commands. No remote execution
 * or automatic finding resolution is performed by this foundation.
 */
export class RemediationRepository {
  constructor(private readonly db: SupabaseClient) {}

  async command(input: unknown): Promise<RemediationRecord> {
    const command = RemediationCommand.parse(input);
    const { data, error } = await this.db.rpc("remediation_command", { p_command: command });
    if (error) throw new Error(`Remediation command rejected: ${error.message}`);
    return RemediationRecord.parse(data);
  }

  async get(id: string): Promise<RemediationRecord | null> {
    const { data, error } = await this.db.from("remediations").select("*").eq("id", z.uuid().parse(id)).maybeSingle();
    if (error) throw new Error(`Remediation read failed: ${error.message}`);
    return data ? RemediationRecord.parse(data) : null;
  }

  async attempts(id: string) {
    const { data, error } = await this.db.from("remediation_attempts").select("*").eq("remediation_id", z.uuid().parse(id)).order("attempt_number");
    if (error) throw new Error(`Attempt read failed: ${error.message}`);
    return data ?? [];
  }

  /** Read-only recovery: resume using persisted attempt/execution IDs and revision.
   * A stale delivery cannot transition state; infrastructure timeouts are explicitly
   * recorded by the orchestrator as VERIFICATION_INCOMPLETE, never as success.
   */
  async recover(limit = 100): Promise<RemediationRecord[]> {
    const pageSize = z.number().int().min(1).max(1000).parse(limit);
    const { data, error } = await this.db.from("remediations").select("*")
      .in("state", ["DISCOVERED", "TRIAGED", "PATCH_GENERATED", "VERIFICATION_PENDING", "VERIFYING", "VERIFICATION_FAILED", "PATCH_REVISION", "VERIFIED"])
      .order("updated_at").limit(pageSize);
    if (error) throw new Error(`Recovery read failed: ${error.message}`);
    return z.array(RemediationRecord).parse(data ?? []);
  }
}
