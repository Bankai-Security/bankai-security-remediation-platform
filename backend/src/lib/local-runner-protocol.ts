import { z } from "zod";

/** Control-plane messages for a paired local runner. These schemas validate
 * transport payloads only; authorization and attempt binding remain server-side.
 */
const Id = z.string().min(1).max(200);
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Timestamp = z.string().datetime({ offset: true });
const Digest = z.string().regex(/^sha256-[0-9a-f]{64}$/);
const IdempotencyKey = z.string().min(16).max(200).regex(/^[A-Za-z0-9._:-]+$/);

export const LocalRunnerClaimSchema = z.object({
  protocol_version: z.literal("1"),
  capabilities: z.object({
    protocol_version: z.literal("1"),
    companion_version: z.string().min(1).max(64),
    platforms: z.array(z.enum(["windows"])).min(1),
    docker_ready: z.boolean(),
    jenkins_ready: z.boolean(),
    quincy_ready: z.boolean(),
    max_concurrent_jobs: z.number().int().min(1).max(4),
  }).strict(),
  idempotency_key: IdempotencyKey,
}).strict();

export const LocalRunnerCapabilitiesSchema = z.object({
  protocol_version: z.literal("1"),
  companion_version: z.string().min(1).max(64),
  platforms: z.array(z.enum(["windows"])).min(1),
  docker_ready: z.boolean(),
  jenkins_ready: z.boolean(),
  quincy_ready: z.boolean(),
  max_concurrent_jobs: z.number().int().min(1).max(4),
}).strict();

export const LocalRunnerTaskSchema = z.object({
  protocol_version: z.literal("1"),
  lease_id: Id,
  execution_id: Id,
  attempt_id: z.uuid(),
  remediation_id: z.uuid(),
  finding_id: z.uuid(),
  repository_id: Id,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseline_sha: Sha,
  candidate_sha: Sha,
  profile: z.string().min(1).max(100),
  policy_id: z.string().min(1).max(150),
  target: z.object({
    legacy_fingerprint: z.string().min(1).max(512),
    occurrence_id: z.string().min(1).max(512).nullable(),
    external_id: z.string().max(512).nullable(),
    file_path: z.string().max(2048).nullable(),
  }).strict(),
  issued_at: Timestamp,
  expires_at: Timestamp,
}).strict().refine((task) => Date.parse(task.expires_at) > Date.parse(task.issued_at), {
  message: "Lease expiry must follow its issue time.", path: ["expires_at"],
});

export const LocalRunnerStageSchema = z.enum([
  "preparing_environment", "checkout", "build", "tests", "baseline_scan",
  "candidate_scan", "comparison", "artifact_upload", "cleanup",
]);

export const LocalRunnerProgressSchema = z.object({
  protocol_version: z.literal("1"),
  lease_id: Id,
  execution_id: Id,
  sequence: z.number().int().nonnegative(),
  stage: LocalRunnerStageSchema,
  status: z.enum(["started", "completed", "failed"]),
  occurred_at: Timestamp,
  message: z.string().max(1000).optional(),
  idempotency_key: IdempotencyKey,
}).strict();

export const LocalRunnerHeartbeatSchema = z.object({
  protocol_version: z.literal("1"),
  lease_id: Id,
  execution_id: Id,
  heartbeat_id: IdempotencyKey,
  reported_at: Timestamp,
}).strict();

export const LocalRunnerCancellationSchema = z.object({
  protocol_version: z.literal("1"),
  lease_id: Id,
  execution_id: Id,
  reason: z.string().min(1).max(500),
  idempotency_key: IdempotencyKey,
}).strict();

export const LocalRunnerArtifactSchema = z.object({
  name: z.enum(["build-log", "test-report", "scan-evidence"]),
  size_bytes: z.number().int().nonnegative().max(100 * 1024 * 1024),
  digest: Digest,
  content_type: z.string().min(1).max(150),
}).strict();

export const LocalRunnerResultSchema = z.object({
  protocol_version: z.literal("1"),
  lease_id: Id,
  execution_id: Id,
  quincy_execution_id: z.string().uuid(),
  attempt_id: z.uuid(),
  idempotency_key: IdempotencyKey,
  outcome: z.enum(["passed", "failed", "cancelled", "incomplete", "infrastructure_failure"]),
  manifest: z.unknown(),
  artifacts: z.array(LocalRunnerArtifactSchema).max(3),
  completed_at: Timestamp,
}).strict();

/**
 * Classifies a reported sequence before persistence. Replays of the same
 * sequence and payload are safe; gaps and conflicting replays must be rejected.
 */
export function classifyLocalRunnerProgress(input: {
  lastSequence: number;
  lastEventDigest: string | null;
  sequence: number;
  eventDigest: string;
}): "accept" | "replay" | "reject" {
  if (input.sequence === input.lastSequence + 1) return "accept";
  if (input.sequence === input.lastSequence && input.lastEventDigest === input.eventDigest) return "replay";
  return "reject";
}

export type LocalRunnerCapabilities = z.infer<typeof LocalRunnerCapabilitiesSchema>;
export type LocalRunnerClaim = z.infer<typeof LocalRunnerClaimSchema>;
export type LocalRunnerTask = z.infer<typeof LocalRunnerTaskSchema>;
export type LocalRunnerProgress = z.infer<typeof LocalRunnerProgressSchema>;
export type LocalRunnerArtifact = z.infer<typeof LocalRunnerArtifactSchema>;
export type LocalRunnerResult = z.infer<typeof LocalRunnerResultSchema>;
