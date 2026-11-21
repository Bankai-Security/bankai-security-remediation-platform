import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../env.js";

// maxRetriesPerRequest: null is required by BullMQ's blocking connections —
// see https://docs.bullmq.io/guide/going-to-production#maxretriesperrequest.
export const redisConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export interface RepoScanJobData {
  requestId?: string | undefined;
  scanId: string;
  projectId: string;
  triggerType: "manual" | "webhook";
  /** GitHub push SHA. Webhook scans still cover the entire repo at this revision. */
  headSha?: string;
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
  requestId?: string | undefined;
  ticketId: string;
  projectId: string;
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

// Manual retry uses a fresh job ID because a previous completed job may
// still occupy the ticket-based deduplication key in Redis.
export async function enqueueFixPrResume(data: FixPrJobData, delay = 0): Promise<{ id?: string }> {
  const job = await fixPrQueue.add("fix-pr", data, {
    delay,
    removeOnComplete: { age: 24 * 60 * 60 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  });
  return job.id ? { id: job.id } : {};
}

export interface JenkinsRetryJobData { requestId?: string; ticketId: string; projectId: string; runId: string; retryCount: number; failureLog: string; }
export const JENKINS_RETRY_QUEUE_NAME = "jenkins-retry";
export const jenkinsRetryQueue = new Queue<JenkinsRetryJobData>(JENKINS_RETRY_QUEUE_NAME, { connection: redisConnection });
export async function enqueueJenkinsRetry(data: JenkinsRetryJobData): Promise<void> {
  await jenkinsRetryQueue.add("retry", data, {
    jobId: `jenkins-retry-${data.runId}`,
    removeOnComplete: { age: 60 * 60 },
    removeOnFail: { age: 24 * 60 * 60 },
  });
}
