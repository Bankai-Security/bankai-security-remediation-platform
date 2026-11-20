import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { quincyManifestDigest, validateQuincyManifest } from "./quincy-manifest.js";

const sha = (char: string) => `sha256-${char.repeat(64)}`;
const baseSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const repoId = `quincy-repository-${createHash("sha256").update("github_url:https://github.com/org/repo").digest("hex")}`;
const correlation = { remediation_id: "00000000-0000-4000-8000-000000000001", attempt_id: "00000000-0000-4000-8000-000000000002", finding_id: "00000000-0000-4000-8000-000000000003", base_sha: baseSha };
const input = {
  schema_version: "1.0" as const, manifest_id: "exec-1:1", execution_id: "exec-1", repository_id: repoId,
  repository: "https://github.com/org/repo", baseline_sha: baseSha, candidate_sha: candidateSha,
  profile: "jenkins-schrift-comparison-v1", policy_id: "bankai-complete-repository-differential-v1", bankai_correlation: correlation,
  created_at: "2026-11-15T00:00:00Z", expires_at: "2026-11-16T00:00:00Z", state: "passed" as "passed" | "failed",
  jenkins_build_id: "42", build_result: "passed", test_result: "passed", scanner_result: "success",
  baseline_evidence_digest: sha("a"), candidate_evidence_digest: sha("b"), comparison_outcome: "not_detected" as const,
  scan_execution_id: "scan-1",
  comparison_reason: "complete", artifacts: {
    "build-log": { reference: "/v1/verifications/exec-1/artifacts/build-log", digest: sha("d") },
    "test-report": { reference: "/v1/verifications/exec-1/artifacts/test-report", digest: sha("e") },
    "scan-evidence": { reference: "/v1/verifications/exec-1/artifacts/scan-evidence", digest: sha("f") },
  },
};
function signed(value = input) { return { ...value, integrity_algorithm: "sha-256" as const, integrity_version: "canonical-json-v1" as const, integrity_digest: quincyManifestDigest(value) }; }
const expected = { executionId: "exec-1", repositoryId: input.repository_id, repository: input.repository, candidateSha, baselineSha: baseSha, profile: input.profile, policyId: input.policy_id, correlation };

describe("Quincy verification manifest", () => {
  it("accepts the finalized v1 Quincy contract and exact attempt correlation", () => {
    expect(validateQuincyManifest(signed(), expected, new Date("2026-11-15T12:00:00Z")).manifest_id).toBe("exec-1:1");
    expect(quincyManifestDigest(input)).toBe("sha256-8930aec2a5ac18bca8b48133d8c88a9b2bb23616f035477377265fe59354fc16");
  });
  it("detects tampering and mismatched execution, repository, or SHA", () => {
    expect(() => validateQuincyManifest({ ...signed(), policy_id: "other" }, expected, new Date("2026-11-15T12:00:00Z"))).toThrow("identity");
    expect(() => validateQuincyManifest(signed(), { ...expected, executionId: "other" }, new Date("2026-11-15T12:00:00Z"))).toThrow("identity");
    expect(() => validateQuincyManifest(signed(), { ...expected, candidateSha: baseSha }, new Date("2026-11-15T12:00:00Z"))).toThrow("identity");
    expect(() => validateQuincyManifest({ ...signed(), comparison_reason: "altered" }, expected, new Date("2026-11-15T12:00:00Z"))).toThrow("digest");
  });
  it("rejects failed and stale manifests", () => {
    expect(() => validateQuincyManifest(signed({ ...input, state: "failed" }), expected, new Date("2026-11-15T12:00:00Z"))).toThrow("failed");
    expect(() => validateQuincyManifest(signed(), expected, new Date("2026-11-17T00:00:00Z"))).toThrow("stale");
  });
});
