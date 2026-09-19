import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../env.js";
import type { PipelineStageName } from "./pipeline-types.js";

// maxRetriesPerRequest: null is required by BullMQ's blocking connections —
// see https://docs.bullmq.io/guide/going-to-production#maxretriesperrequest.
export const redisConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export interface RepoScanJobData {
  scanId: string;
  projectId: string;
  triggerType: "manual" | "webhook";
  // Set only for webhook-triggered incremental scans (M4) — both null for a
  // manual full scan, where the worker resolves the branch HEAD itself.
  baseSha: string | null;
  headSha: string | null;
}

export const REPO_SCAN_QUEUE_NAME = "repo-scan";

export const repoScanQueue = new Queue<RepoScanJobData>(REPO_SCAN_QUEUE_NAME, { connection: redisConnection });

// jobId is the caller's dedupe key — BullMQ silently no-ops adding a job
// whose id is already present/active, which is exactly what's needed for
// GitHub's at-least-once webhook redelivery (M4: `webhook-${projectId}-${headSha}`)
// as well as preventing a double-submit of the same manual scan
// (`manual-${scanId}`).
export async function enqueueRepoScan(data: RepoScanJobData, jobId: string): Promise<void> {
  await repoScanQueue.add("scan", data, {
    jobId,
    removeOnComplete: { age: 24 * 60 * 60 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  });
}

export interface FixPrJobData {
  ticketId: string;
  projectId: string;
  quincyJobId?: string;
}

export interface RemediationProgress {
  summary: string;
  activeAttempt: number;
  completedAttempts: number;
  updatedAt: string | null;
}

export async function saveRemediationProgress(data: FixPrJobData, progress: RemediationProgress): Promise<void> {
  await redisConnection.set(`bankai:progress:${data.projectId}:${data.ticketId}`, JSON.stringify(progress), "EX", 3600);
}

export async function getRemediationProgress(projectId: string, ticketIds: string[]): Promise<(RemediationProgress | null)[]> {
  if (!ticketIds.length) return [];
  const values = await redisConnection.mget(...ticketIds.map(id => `bankai:progress:${projectId}:${id}`));
  return values.map(value => {
    try { return value ? JSON.parse(value) as RemediationProgress : null; } catch { return null; }
  });
}

function quincyCheckpointKey(data: FixPrJobData): string {
  return `bankai:quincy:${data.projectId}:${data.ticketId}`;
}

export async function loadQuincyCheckpoint(data: FixPrJobData): Promise<string | undefined> {
  return (await redisConnection.get(quincyCheckpointKey(data))) ?? data.quincyJobId;
}

export async function saveQuincyCheckpoint(data: FixPrJobData, jobId: string): Promise<void> {
  await redisConnection.set(quincyCheckpointKey(data), jobId);
}

export async function clearQuincyCheckpoint(data: FixPrJobData, jobId: string): Promise<void> {
  await redisConnection.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", 1, quincyCheckpointKey(data), jobId);
}

export const FIX_PR_QUEUE_NAME = "fix-pr";

export const fixPrQueue = new Queue<FixPrJobData>(FIX_PR_QUEUE_NAME, { connection: redisConnection });

// jobId dedupes on ticketId — a burst of calls that all create/retry the
// same ticket's branch (createTicketForFinding followed by a syncTickets
// retry, say) collapses to one job. This is a belt-and-suspenders
// optimization, not the real idempotency guard: processFixPrJob re-checks
// the ticket's own state (status, github_pr_number, github_fix_commit_sha)
// on every run, so it stays safe even if two jobs for the same ticket land
// outside BullMQ's dedup window.
export async function enqueueFixPr(data: FixPrJobData): Promise<void> {
  await fixPrQueue.add("fix-pr", data, {
    jobId: `fix-pr-${data.ticketId}`,
    removeOnComplete: { age: 24 * 60 * 60 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  });
}

// Used after the CI bootstrap PR merges. The original fix-pr job completed
// successfully when it marked the ticket pending_setup, so its deduped
// `fix-pr-${ticketId}` id can still be retained in Redis. A resume must use
// a fresh BullMQ id or it may silently no-op.
export async function enqueueFixPrResume(data: FixPrJobData, delay = 0): Promise<{ id?: string }> {
  const job = await fixPrQueue.add("fix-pr", data, {
    delay,
    ...(data.quincyJobId ? { deduplication: { id: `quincy-poll-${data.ticketId}`, keepLastIfActive: true } } : {}),
    removeOnComplete: { age: 24 * 60 * 60 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  });
  return job.id ? { id: job.id } : {};
}

export interface PipelineJobData {
  ticketId: string;
  projectId: string;
}

export const PIPELINE_QUEUE_NAME = "ci-pipeline";

export const pipelineQueue = new Queue<PipelineJobData>(PIPELINE_QUEUE_NAME, { connection: redisConnection });

// jobId dedupes on ticketId, same belt-and-suspenders rationale as
// enqueueFixPr — processPipelineJob re-checks the ticket's own ci_status on
// every run, so it stays safe even outside BullMQ's dedup window. Reused
// both right after a PR opens and when a bootstrap PR merge re-triggers
// every ticket that was left at 'pending_setup'.
export async function enqueuePipelineVerification(data: PipelineJobData): Promise<void> {
  await pipelineQueue.add("verify", data, {
    jobId: `ci-pipeline-${data.ticketId}`,
    removeOnComplete: { age: 24 * 60 * 60 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  });
}

// Used by the ticket-level "retry" action, not the automatic post-PR
// trigger above — deliberately NOT deduped on a fixed ticketId-based jobId.
// processPipelineJob never throws (every failure is caught and recorded on
// the ticket instead), so a stuck/failed ticket's job always occupies its
// `ci-pipeline-${ticketId}` id in Redis until removeOnComplete's 24h TTL
// expires; re-adding that same id would silently no-op instead of actually
// retrying. A human clicking "retry" always means "run it again now."
export async function enqueuePipelineRetry(data: PipelineJobData): Promise<{ id?: string }> {
  const job = await pipelineQueue.add("verify", data, {
    jobId: `ci-pipeline-retry-${data.ticketId}-${randomUUID()}`,
    removeOnComplete: { age: 24 * 60 * 60 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  });
  return job.id ? { id: job.id } : {};
}

export interface FixRetryJobData {
  ticketId: string;
  projectId: string;
  githubRunId: number;
  failingStage: PipelineStageName;
  securityFeedback?: string;
  securityCommitSha?: string;
}

export const FIX_RETRY_QUEUE_NAME = "fix-retry";

export const fixRetryQueue = new Queue<FixRetryJobData>(FIX_RETRY_QUEUE_NAME, { connection: redisConnection });

// jobId dedupes on (ticketId, githubRunId) — workflow_run is an
// at-least-once GitHub webhook, so a redelivery of the same completed run
// must not enqueue a second self-healing attempt for it. processFixRetryJob
// still re-checks ticket.ci_fix_attempt at run time as a belt-and-suspenders
// guard, same idempotency contract as the rest of this file.
export async function enqueueFixRetry(data: FixRetryJobData): Promise<void> {
  await fixRetryQueue.add("fix-retry", data, {
    jobId: `fix-retry-${data.ticketId}-${data.securityCommitSha ?? data.githubRunId}`,
    removeOnComplete: { age: 24 * 60 * 60 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  });
}
