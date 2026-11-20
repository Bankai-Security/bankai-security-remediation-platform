import { Worker } from "bullmq";
import { processFixPrJob } from "./jobs/fix-pr.job.js";
import { processRepoScanJob } from "./jobs/repo-scan.job.js";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { waitingAgeMs } from "./lib/queue-telemetry.js";
import { fixPrQueue, FIX_PR_QUEUE_NAME, redisConnection, repoScanQueue, REPO_SCAN_QUEUE_NAME } from "./lib/queue.js";

function redisTarget(url: string): { host: string; pathname: string } {
  try { const parsed = new URL(url); return { host: parsed.host, pathname: parsed.pathname || "/" }; }
  catch { return { host: "(unparseable REDIS_URL)", pathname: "/" }; }
}

logger.info({ redis: redisTarget(env.REDIS_URL), queues: [REPO_SCAN_QUEUE_NAME, FIX_PR_QUEUE_NAME] }, "Bankai worker process starting");

const scanWorker = new Worker(REPO_SCAN_QUEUE_NAME, processRepoScanJob, { connection: redisConnection, concurrency: 1 });
const fixWorker = new Worker(FIX_PR_QUEUE_NAME, processFixPrJob, { connection: redisConnection, concurrency: 2 });

for (const [queueName, worker] of [[REPO_SCAN_QUEUE_NAME, scanWorker], [FIX_PR_QUEUE_NAME, fixWorker]] as const) {
  worker.on("active", job => logger.info({ event: "queue.job.active", queue: queueName, request_id: job.data.requestId, jobId: job.id, attempt: job.attemptsMade }, "Bankai job active"));
  worker.on("completed", job => logger.info({ event: "queue.job.completed", queue: queueName, request_id: job.data.requestId, jobId: job.id, durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined }, "Bankai job completed"));
  worker.on("stalled", jobId => logger.warn({ event: "queue.job.stalled", queue: queueName, jobId }, "Bankai job stalled"));
  worker.on("failed", (job, err) => logger.error({ event: "queue.job.failed", queue: queueName, request_id: job?.data.requestId, jobId: job?.id, attempt: job?.attemptsMade, err }, "Bankai job failed"));
}

const queues = [repoScanQueue, fixPrQueue];
const sampleQueueDepth = async () => {
  for (const queue of queues) {
    try {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
      const oldestWaiting = (counts.waiting ?? 0) > 0 ? (await queue.getWaiting(0, 0))[0] : undefined;
      logger.info({ event: "queue.depth", queue: queue.name, ...counts, oldestWaitingAgeMs: oldestWaiting ? waitingAgeMs(oldestWaiting.timestamp) : null }, "Queue depth sample");
    } catch (err) { logger.warn({ event: "queue.depth.error", queue: queue.name, err }, "Could not sample queue depth"); }
  }
};
void sampleQueueDepth();
setInterval(() => { void sampleQueueDepth(); }, 60_000).unref();
