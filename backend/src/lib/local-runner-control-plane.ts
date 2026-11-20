import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  LocalRunnerCapabilitiesSchema,
  LocalRunnerProgressSchema,
  LocalRunnerResultSchema,
  LocalRunnerTaskSchema,
  type LocalRunnerCapabilities,
  type LocalRunnerProgress,
  type LocalRunnerResult,
  type LocalRunnerTask,
} from "./local-runner-protocol.js";
import { validateQuincyManifest, validateQuincyManifestContract, artifactDigest } from "./quincy-manifest.js";
import { explicitQuincyTargetComparison, quincyEvidenceSupportsVerification, QuincyTriageEvidenceSchema, type QuincyTriageResult } from "./quincy.js";
import { env } from "../env.js";

const Uuid = z.uuid();
const Sha256 = z.string().regex(/^sha256-[0-9a-f]{64}$/);
const TaskRow = z.object({
  id: Uuid,
  project_id: Uuid,
  remediation_id: Uuid,
  attempt_id: Uuid,
  finding_id: Uuid,
  runner_id: Uuid.nullable(),
  execution_id: z.string(),
  repository_id: z.string(),
  repository: z.string(),
  baseline_sha: z.string(),
  candidate_sha: z.string(),
  profile: z.string(),
  policy_id: z.string(),
  target: z.object({
    legacy_fingerprint: z.string().min(1), occurrence_id: z.string().nullable(),
    external_id: z.string().nullable(), file_path: z.string().nullable(),
  }).strict(),
  state: z.enum(["queued", "leased", "running", "cancelling", "passed", "failed", "cancelled", "incomplete", "infrastructure_failure"]),
  idempotency_key: z.string(),
  lease_id: Uuid.nullable(),
  lease_expires_at: z.string().nullable(),
  last_sequence: z.number().int(),
  result: z.unknown().nullable().optional(),
}).passthrough();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256-${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

export interface LocalRunnerProvider {
  readonly kind: "local-runner";
  enqueue(task: { projectId: string; remediationId: string; attemptId: string; findingId: string; executionId: string; repositoryId: string; repository: string; baselineSha: string; candidateSha: string; profile: string; policyId: string; idempotencyKey: string }): Promise<unknown>;
  claim(runnerId: string, leaseSeconds?: number): Promise<LocalRunnerTask | null>;
  heartbeat(runnerId: string, leaseId: string, executionId: string, heartbeatId: string, leaseSeconds?: number): Promise<unknown>;
  progress(runnerId: string, leaseId: string, event: LocalRunnerProgress): Promise<unknown>;
  finalize(runnerId: string, leaseId: string, result: LocalRunnerResult): Promise<unknown>;
}

/**
 * Atomic persistence adapter for the local runner RPCs. Construct only with a
 * server-side service-role client. Authentication/pairing must authorize the
 * runnerId before calling claim/heartbeat/progress/finalize.
 */
export class LocalRunnerControlPlane implements LocalRunnerProvider {
  readonly kind = "local-runner" as const;

  constructor(private readonly db: SupabaseClient) {}

  async enqueue(input: Parameters<LocalRunnerProvider["enqueue"]>[0]): Promise<unknown> {
    if (!env.LOCAL_RUNNER_ENABLED) throw new Error("Local runner task dispatch is disabled by feature flag.");
    const value = z.object({
      projectId: Uuid, remediationId: Uuid, attemptId: Uuid, findingId: Uuid,
      executionId: z.string().min(1).max(128), repositoryId: z.string().min(1).max(200),
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      baselineSha: z.string().regex(/^[0-9a-f]{40}$/), candidateSha: z.string().regex(/^[0-9a-f]{40}$/),
      profile: z.string().min(1).max(100), policyId: z.string().min(1).max(150),
      idempotencyKey: z.string().min(16).max(200),
    }).parse(input);
    const { data, error } = await this.db.rpc("enqueue_local_runner_task", { p_task: {
      project_id: value.projectId, remediation_id: value.remediationId, attempt_id: value.attemptId,
      finding_id: value.findingId, execution_id: value.executionId, repository_id: value.repositoryId,
      repository: value.repository, baseline_sha: value.baselineSha, candidate_sha: value.candidateSha,
      profile: value.profile, policy_id: value.policyId, idempotency_key: value.idempotencyKey,
    } });
    if (error) throw new Error(`Local runner enqueue failed: ${error.message}`);
    return TaskRow.parse(data);
  }

  async claim(runnerId: string, leaseSeconds = 90): Promise<LocalRunnerTask | null> {
    if (!env.LOCAL_RUNNER_ENABLED) return null;
    const { data, error } = await this.db.rpc("claim_local_runner_task", { p_runner_id: Uuid.parse(runnerId), p_lease_seconds: leaseSeconds });
    if (error) throw new Error(`Local runner claim failed: ${error.message}`);
    if (!data) return null;
    const row = TaskRow.parse(data);
    if (!row.lease_id || !row.lease_expires_at) throw new Error("Claimed local runner task lacks a lease.");
    return LocalRunnerTaskSchema.parse({
      protocol_version: "1", lease_id: row.lease_id, execution_id: row.execution_id,
      attempt_id: row.attempt_id, remediation_id: row.remediation_id, finding_id: row.finding_id,
      repository_id: row.repository_id, repository: row.repository, baseline_sha: row.baseline_sha,
      candidate_sha: row.candidate_sha, profile: row.profile, policy_id: row.policy_id,
      target: row.target,
      issued_at: new Date().toISOString(), expires_at: row.lease_expires_at,
    });
  }

  async heartbeat(runnerId: string, leaseId: string, executionId: string, heartbeatId: string, leaseSeconds = 90): Promise<unknown> {
    const { data, error } = await this.db.rpc("heartbeat_local_runner_task", {
      p_runner_id: Uuid.parse(runnerId), p_lease_id: Uuid.parse(leaseId), p_execution_id: z.string().min(1).parse(executionId),
      p_heartbeat_id: z.string().min(16).max(200).parse(heartbeatId), p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(`Local runner heartbeat failed: ${error.message}`);
    return TaskRow.parse(data);
  }

  async progress(runnerId: string, leaseId: string, event: LocalRunnerProgress): Promise<unknown> {
    const progress = LocalRunnerProgressSchema.parse(event);
    const { data, error } = await this.db.rpc("record_local_runner_progress", {
      p_runner_id: Uuid.parse(runnerId), p_lease_id: Uuid.parse(leaseId), p_progress: progress,
      p_payload_digest: digest(progress),
    });
    if (error) throw new Error(`Local runner progress rejected: ${error.message}`);
    return TaskRow.parse(data);
  }

  async finalize(runnerId: string, leaseId: string, result: LocalRunnerResult): Promise<unknown> {
    const terminal = LocalRunnerResultSchema.parse(result);
    const { data: taskData, error: taskError } = await this.db.from("local_runner_tasks")
      .select("id, project_id, remediation_id, attempt_id, finding_id, execution_id, repository_id, repository, baseline_sha, candidate_sha, profile, policy_id, target, runner_id, lease_id")
      .eq("runner_id", Uuid.parse(runnerId)).eq("lease_id", Uuid.parse(leaseId)).eq("execution_id", terminal.execution_id)
      .maybeSingle();
    if (taskError || !taskData) throw new Error("Local runner result does not match a persisted lease.");
    const task = z.object({
      id: Uuid, project_id: Uuid, remediation_id: Uuid, attempt_id: Uuid, finding_id: Uuid,
      execution_id: z.string(), repository_id: z.string(), repository: z.string(),
      baseline_sha: z.string(), candidate_sha: z.string(), profile: z.string(), policy_id: z.string(),
      target: LocalRunnerTaskSchema.shape.target,
      runner_id: Uuid, lease_id: Uuid,
    }).parse(taskData);
    if (terminal.attempt_id !== task.attempt_id) throw new Error("Local runner result attempt does not match its lease.");
    const expectedManifest = {
      executionId: terminal.quincy_execution_id,
      repositoryId: `quincy-repository-${createHash("sha256").update(`github_url:https://github.com/${task.repository}`).digest("hex")}`,
      repository: `https://github.com/${task.repository}`,
      candidateSha: task.candidate_sha, baselineSha: task.baseline_sha, profile: task.profile,
      policyId: task.policy_id,
      correlation: { remediation_id: task.remediation_id, attempt_id: task.attempt_id, finding_id: task.finding_id, base_sha: task.baseline_sha },
    };
    const manifest = validateQuincyManifestContract(terminal.manifest, expectedManifest);
    if ((terminal.outcome === "passed") !== (manifest.state === "passed")) {
      throw new Error("Local runner outcome does not match the finalized Quincy manifest.");
    }
    const artifactsByName = new Map(terminal.artifacts.map((artifact) => [artifact.name, artifact]));
    if (artifactsByName.size !== 3) throw new Error("Local result must provide exactly the three Quincy verification artifacts.");
    for (const name of ["build-log", "test-report", "scan-evidence"] as const) {
      const descriptor = artifactsByName.get(name);
      if (!descriptor || descriptor.digest !== manifest.artifacts[name].digest) {
        throw new Error(`Local runner artifact ${name} is missing or conflicts with the validated manifest.`);
      }
      const { data: artifactRow, error: artifactError } = await this.db.from("local_runner_artifacts")
        .select("storage_key, size_bytes, digest").eq("task_id", task.id).eq("name", name).maybeSingle();
      if (artifactError || !artifactRow || artifactRow.digest !== descriptor.digest || artifactRow.size_bytes !== descriptor.size_bytes) {
        throw new Error(`Local runner artifact ${name} was not uploaded and bound to this task.`);
      }
      const stored = await this.db.storage.from("local-runner-artifacts").download(artifactRow.storage_key);
      if (stored.error) throw new Error(`Local runner artifact ${name} could not be read back.`);
      const bytes = new Uint8Array(await stored.data.arrayBuffer());
      if (bytes.byteLength !== descriptor.size_bytes || artifactDigest(bytes) !== descriptor.digest) {
        throw new Error(`Local runner artifact ${name} failed server-side digest verification.`);
      }
      if (name === "scan-evidence") {
        const evidencePair = z.object({
          baseline_evidence: QuincyTriageEvidenceSchema.nullable(),
          candidate_evidence: QuincyTriageEvidenceSchema.nullable(),
        }).strict().parse(JSON.parse(new TextDecoder().decode(bytes)));
        if (!evidencePair.baseline_evidence || !evidencePair.candidate_evidence
          || evidencePair.baseline_evidence.evidence_digest !== manifest.baseline_evidence_digest
          || evidencePair.candidate_evidence.evidence_digest !== manifest.candidate_evidence_digest) {
          throw new Error("Quincy scan evidence does not match the finalized manifest.");
        }
        if (terminal.outcome === "passed") {
          const baseline: QuincyTriageResult = { findings: [], rawFindingCount: 0, scanDurationSeconds: 0, evidence: evidencePair.baseline_evidence, baselineEvidence: null };
          const candidate: QuincyTriageResult = { findings: [], rawFindingCount: 0, scanDurationSeconds: 0, evidence: evidencePair.candidate_evidence, baselineEvidence: null };
          if (!quincyEvidenceSupportsVerification(baseline, task.baseline_sha) || !quincyEvidenceSupportsVerification(candidate, task.candidate_sha)) {
            throw new Error("Local Quincy scan evidence is incomplete, stale, or bound to different commits.");
          }
          const comparison = explicitQuincyTargetComparison(baseline, candidate, {
            legacyFingerprint: task.target.legacy_fingerprint, occurrenceId: task.target.occurrence_id,
            externalId: task.target.external_id, filePath: task.target.file_path,
          }, task.baseline_sha, task.candidate_sha);
          if (comparison.outcome !== "not_detected" || manifest.comparison_outcome !== "not_detected") {
            throw new Error("Local Quincy comparison did not prove fresh removal of the target finding.");
          }
        }
      }
    }
    const manifestStateToOutcome: Record<string, LocalRunnerResult["outcome"]> = {
      passed: "passed", failed: "failed", cancelled: "cancelled", timed_out: "incomplete",
      incomplete: "incomplete", infrastructure_failure: "infrastructure_failure",
    };
    if (manifestStateToOutcome[manifest.state] !== terminal.outcome) throw new Error("Runner result outcome does not match Quincy terminal state.");
    if (terminal.outcome === "passed") validateQuincyManifest(terminal.manifest, expectedManifest);
    const { data, error } = await this.db.rpc("finalize_local_runner_task", {
      p_runner_id: Uuid.parse(runnerId), p_lease_id: Uuid.parse(leaseId), p_result: terminal,
      p_payload_digest: digest(terminal),
    });
    if (error) throw new Error(`Local runner result rejected: ${error.message}`);
    return TaskRow.parse(data);
  }
}

/** Capabilities are recorded by an authenticated enrollment flow in a later slice. */
export function validateRunnerCapabilities(value: unknown): LocalRunnerCapabilities {
  return LocalRunnerCapabilitiesSchema.parse(value);
}

export function localRunnerPayloadDigest(value: unknown): string {
  return Sha256.parse(digest(value));
}
