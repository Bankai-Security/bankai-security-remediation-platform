import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RemediationCommand, RemediationRecord, RemediationRepository } from "./remediation-state.js";

const id = "00000000-0000-4000-8000-000000000001";
const base = { schema_version: "1.0", command_key: "command-1", remediation_id: id, expected_revision: 0 };
describe("remediation command contract", () => {
  it.each(["main", "a".repeat(39), "A".repeat(40)])("rejects mutable or malformed SHA %s", (sha) => {
    expect(() => RemediationCommand.parse({ ...base, action: "start_attempt", base_sha: sha, candidate_sha: "b".repeat(40), patch_digest: `sha256-${"c".repeat(64)}`, verification_profile: "security-v1" })).toThrow();
  });
  it("rejects equal SHAs and unsupported fields/version", () => {
    expect(() => RemediationCommand.parse({ ...base, action: "start_attempt", base_sha: "a".repeat(40), candidate_sha: "a".repeat(40), patch_digest: `sha256-${"c".repeat(64)}`, verification_profile: "security-v1" })).toThrow();
    expect(() => RemediationCommand.parse({ ...base, action: "transition", state: "TRIAGED", override: true })).toThrow();
    expect(() => RemediationCommand.parse({ ...base, schema_version: "2.0", action: "transition", state: "TRIAGED" })).toThrow();
  });
  it.each(["VERIFIED", "VERIFYING", "VERIFICATION_FAILED", "VERIFICATION_INCOMPLETE", "CANCELLED", "BLOCKED"])("requires evidence or diagnostics for %s", (state) => {
    expect(() => RemediationCommand.parse({ ...base, action: "transition", state })).toThrow();
  });
  it("forwards the exact validated idempotent command and fails closed on database errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "stale remediation revision" } });
    const repo = new RemediationRepository({ rpc } as unknown as SupabaseClient);
    const command = { ...base, action: "transition", state: "TRIAGED" };
    await expect(repo.command(command)).rejects.toThrow("stale remediation revision");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("remediation_command", { p_command: command });
  });
  it("rejects invalid commands before any database write", async () => {
    const rpc = vi.fn();
    await expect(new RemediationRepository({ rpc } as unknown as SupabaseClient).command({})).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("parses persisted terminal diagnosis fields", () => {
    expect(RemediationRecord.parse({
      id, schema_version: "1.0", project_id: id, finding_id: id, repository_id: "repo",
      state: "ESCALATED", retry_limit: 1, attempt_count: 2, revision: 7,
      current_attempt_id: id, failure_classification: "retry_exhausted",
      diagnostic: "Human review required", created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    }).failure_classification).toBe("retry_exhausted");
  });
});
