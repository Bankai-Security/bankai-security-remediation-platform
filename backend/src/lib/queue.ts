import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../env.js";

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
