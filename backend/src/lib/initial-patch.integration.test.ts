import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordInitialPatch } from "./initial-patch.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const findingId = "00000000-0000-4000-8000-000000000002";
const remediationId = "00000000-0000-4000-8000-000000000003";
const attemptId = "00000000-0000-4000-8000-000000000004";
const baseSha = "a".repeat(40);
const candidateSha = "b".repeat(40);

describe("SCRUM-31 initial patch attempt integration", () => {
  it("links a known-vulnerable Schrift fixture finding, generated diff and candidate SHA", async () => {
    const vulnerable = await readFile(new URL("../../../e2e-fixture-repo/fixtures/vulnerable-command.js", import.meta.url), "utf8");
    const fixed = vulnerable.replace('import { exec } from \'node:child_process\';', 'import { execFile } from \'node:child_process\';')
      .replace("exec(`nslookup ${hostname}`, callback);", 'execFile("nslookup", [hostname], callback);');
    expect(fixed).not.toBe(vulnerable);
    expect(fixed).toContain('execFile("nslookup", [hostname], callback);');
    expect(fixed).not.toContain("exec(`nslookup ${hostname}`");
    const generatedDiff = `diff --git a/fixtures/vulnerable-command.js b/fixtures/vulnerable-command.js\n--- a/fixtures/vulnerable-command.js\n+++ b/fixtures/vulnerable-command.js\n-${vulnerable}+${fixed}`;

    const calls: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async (_name: string, args: { p_command: Record<string, unknown> }) => {
      const command = args.p_command;
      calls.push(command);
      const action = command.action;
      const state = action === "create" ? "DISCOVERED" : action === "start_attempt" ? "PATCH_GENERATED" : "TRIAGED";
      const revision = action === "create" ? 1 : action === "start_attempt" ? 3 : 2;
      return { error: null, data: {
        id: remediationId, schema_version: "1.0", project_id: projectId, finding_id: findingId,
        repository_id: "bankai/e2e-fixture-repo", state, retry_limit: 2,
        attempt_count: action === "start_attempt" ? 1 : 0, revision,
        current_attempt_id: action === "start_attempt" ? attemptId : null,
        failure_classification: null, diagnostic: null,
        created_at: new Date(0).toISOString(), updated_at: new Date(1).toISOString(),
      } };
    });
    const artifact: Record<string, unknown> = {};
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const insert = vi.fn(async (row: Record<string, unknown>) => { Object.assign(artifact, row); return { error: null }; });
    const from = vi.fn().mockReturnValue({ select, insert });
    const db = { rpc, from } as unknown as SupabaseClient;

    const result = await recordInitialPatch(db, {
      projectId, findingId, repositoryId: "bankai/e2e-fixture-repo", baseSha, candidateSha,
      diffRef: `https://github.com/bankai/e2e-fixture-repo/compare/${baseSha}...${candidateSha}.diff`,
      diffContent: generatedDiff,
    });

    expect(calls.map((command) => command.action)).toEqual(["create", "transition", "start_attempt"]);
    expect(calls[0]).toMatchObject({ project_id: projectId, finding_id: findingId, repository_id: "bankai/e2e-fixture-repo" });
    expect(calls[2]).toMatchObject({ base_sha: baseSha, candidate_sha: candidateSha, patch_digest: result.patchDigest });
    expect(artifact).toMatchObject({
      attempt_id: attemptId, finding_id: findingId, base_sha: baseSha, candidate_sha: candidateSha,
      patch_digest: result.patchDigest,
      diff_ref: `https://github.com/bankai/e2e-fixture-repo/compare/${baseSha}...${candidateSha}.diff`,
    });
  });
});
