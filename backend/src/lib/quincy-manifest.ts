import { createHash } from "node:crypto";
import { z } from "zod";

const sha256 = z.string().regex(/^sha256-[0-9a-f]{64}$/);
const artifact = z.object({ reference: z.string().min(1).max(2048), digest: sha256 }).strict();
const correlation = z.object({ remediation_id: z.uuid(), attempt_id: z.uuid(), finding_id: z.uuid(), base_sha: z.string().regex(/^[0-9a-f]{40}$/) }).strict().nullable();
export const QuincyVerificationManifestSchema = z.object({
  schema_version: z.literal("1.0"), manifest_id: z.string().min(1), execution_id: z.string().min(1),
  repository_id: z.string().min(1), repository: z.string().min(1), baseline_sha: z.string().regex(/^[0-9a-f]{40}$/),
  candidate_sha: z.string().regex(/^[0-9a-f]{40}$/), profile: z.string().min(1), policy_id: z.string().min(1),
  bankai_correlation: correlation, created_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true }),
  state: z.enum(["queued", "running", "passed", "failed", "cancelled", "timed_out", "incomplete", "infrastructure_failure"]),
  jenkins_build_id: z.string().nullable(), build_result: z.string().nullable(), test_result: z.string().nullable(), scanner_result: z.string().nullable(),
  baseline_evidence_digest: sha256.nullable(), candidate_evidence_digest: sha256.nullable(),
  scan_execution_id: z.string().min(1).nullable(),
  comparison_outcome: z.enum(["not_detected", "still_detected", "inconclusive", "not_comparable"]).nullable(),
  comparison_reason: z.string().nullable(),
  artifacts: z.object({ "build-log": artifact, "test-report": artifact, "scan-evidence": artifact }).strict(),
  integrity_algorithm: z.literal("sha-256"), integrity_version: z.literal("canonical-json-v1"), integrity_digest: sha256,
}).strict();
export type QuincyVerificationManifest = z.infer<typeof QuincyVerificationManifestSchema>;

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function quincyManifestDigest(value: Omit<QuincyVerificationManifest, "integrity_algorithm" | "integrity_version" | "integrity_digest">): string {
  return `sha256-${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

export function validateQuincyManifestContract(input: unknown, expected: {
  executionId: string; repositoryId: string; repository: string; candidateSha: string; baselineSha: string;
  profile: string; policyId: string; correlation: NonNullable<QuincyVerificationManifest["bankai_correlation"]>;
}, now = new Date()): QuincyVerificationManifest {
  const manifest = QuincyVerificationManifestSchema.parse(input);
  const { integrity_digest: digest, ...unsigned } = manifest;
  const covered = { ...unsigned };
  delete (covered as Partial<typeof covered>).integrity_algorithm;
  delete (covered as Partial<typeof covered>).integrity_version;
  if (manifest.execution_id !== expected.executionId || manifest.repository_id !== expected.repositoryId
      || manifest.repository !== expected.repository || manifest.candidate_sha !== expected.candidateSha
      || manifest.baseline_sha !== expected.baselineSha || manifest.profile !== expected.profile
      || manifest.policy_id !== expected.policyId
      || !manifest.bankai_correlation || Object.keys(expected.correlation).some((key) => manifest.bankai_correlation?.[key as keyof typeof expected.correlation] !== expected.correlation[key as keyof typeof expected.correlation])) {
    throw new Error("Quincy manifest identity does not match the remediation attempt.");
  }
  if (manifest.artifacts["build-log"].reference !== `/v1/verifications/${encodeURIComponent(manifest.execution_id)}/artifacts/build-log`
      || manifest.artifacts["test-report"].reference !== `/v1/verifications/${encodeURIComponent(manifest.execution_id)}/artifacts/test-report`
      || manifest.artifacts["scan-evidence"].reference !== `/v1/verifications/${encodeURIComponent(manifest.execution_id)}/artifacts/scan-evidence`) {
    throw new Error("Quincy manifest artifact references or scan identity are incomplete.");
  }
  if (digest !== quincyManifestDigest(covered)) throw new Error("Quincy manifest digest mismatch.");
  if (Date.parse(manifest.created_at) > now.getTime() || Date.parse(manifest.expires_at) <= now.getTime()) {
    throw new Error("Quincy manifest is stale or future-dated.");
  }
  return manifest;
}

export function validateQuincyManifest(input: unknown, expected: {
  executionId: string; repositoryId: string; repository: string; candidateSha: string; baselineSha: string;
  profile: string; policyId: string; correlation: NonNullable<QuincyVerificationManifest["bankai_correlation"]>;
}, now = new Date()): QuincyVerificationManifest {
  const manifest = validateQuincyManifestContract(input, expected, now);
  if (manifest.state !== "passed" || !manifest.jenkins_build_id || manifest.build_result !== "passed"
      || manifest.test_result !== "passed" || manifest.scanner_result !== "success"
      || manifest.comparison_outcome !== "not_detected" || !manifest.baseline_evidence_digest || !manifest.candidate_evidence_digest
      || !manifest.scan_execution_id || manifest.comparison_reason === null) {
    throw new Error("Quincy manifest is failed or incomplete.");
  }
  return manifest;
}

export function artifactDigest(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}
