import { Worker } from "bullmq";
import { processFixPrJob } from "./jobs/fix-pr.job.js";
import { processFixRetryJob } from "./jobs/fix-retry.job.js";
import { processPipelineJob } from "./jobs/pipeline.job.js";
import { processRepoScanJob } from "./jobs/repo-scan.job.js";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { waitingAgeMs } from "./lib/queue-telemetry.js";
import { fixPrQueue, fixRetryQueue, FIX_PR_QUEUE_NAME, FIX_RETRY_QUEUE_NAME, pipelineQueue, PIPELINE_QUEUE_NAME, redisConnection, repoScanQueue, REPO_SCAN_QUEUE_NAME } from "./lib/queue.js";

function redisTarget(url: string): { host: string; pathname: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, pathname: parsed.pathname || "/" };
  } catch {
    return { host: "(unparseable REDIS_URL)", pathname: "/" };
  }
}

logger.info(
  {
    redis: redisTarget(env.REDIS_URL),
    quincyConfigured: Boolean(env.QUINCY_API_URL),
    queues: [REPO_SCAN_QUEUE_NAME, FIX_PR_QUEUE_NAME, PIPELINE_QUEUE_NAME, FIX_RETRY_QUEUE_NAME],
  },
  "Bankai worker process starting",
);

// Separate process from the API server (backend/src/server.ts) —
// Gemini calls + repo fetching are slow, and a scan job crashing or OOMing
// must not take the request-handling process down with it. Run alongside
// the API server: `npm run worker` in dev, a second process/dyno in prod.
const worker = new Worker(REPO_SCAN_QUEUE_NAME, processRepoScanJob, {
  connection: redisConnection,
  concurrency: 2,
});

worker.on("completed", (job) => {
  logger.info({ event: "queue.job.completed", queue: REPO_SCAN_QUEUE_NAME, jobId: job.id, durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined }, "Repo scan job completed");
});

worker.on("active", (job) => {
  logger.info({ event: "queue.job.active", queue: REPO_SCAN_QUEUE_NAME, jobId: job.id, attempt: job.attemptsMade, waitMs: job.processedOn ? job.processedOn - job.timestamp : undefined }, "Repo scan job active");
});

worker.on("stalled", (jobId) => {
  logger.warn({ event: "queue.job.stalled", queue: REPO_SCAN_QUEUE_NAME, jobId }, "Repo scan job stalled");
});

worker.on("failed", (job, err) => {
  logger.error({ event: "queue.job.failed", queue: REPO_SCAN_QUEUE_NAME, jobId: job?.id, attempt: job?.attemptsMade, err }, "Repo scan job failed");
});

logger.info(`Repo scan worker listening on queue "${REPO_SCAN_QUEUE_NAME}"`);

// Same process for v1 — AI fix-generation + GitHub commit/PR calls are just
// as slow/unreliable as scan calls, so they get the same crash-isolation
// rationale as above, without needing a third process yet.
const fixPrWorker = new Worker(FIX_PR_QUEUE_NAME, processFixPrJob, {
  connection: redisConnection,
  concurrency: 2,
});

fixPrWorker.on("active", (job) => {
  logger.info({ event: "queue.job.active", queue: FIX_PR_QUEUE_NAME, jobId: job.id, attempt: job.attemptsMade, waitMs: job.processedOn ? job.processedOn - job.timestamp : undefined }, "Fix-PR job active");
});

fixPrWorker.on("stalled", (jobId) => {
  logger.warn({ event: "queue.job.stalled", queue: FIX_PR_QUEUE_NAME, jobId }, "Fix-PR job stalled");
});

fixPrWorker.on("completed", (job) => {
  logger.info({ event: "queue.job.completed", queue: FIX_PR_QUEUE_NAME, jobId: job.id, durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined }, "Fix-PR job completed");
});

fixPrWorker.on("failed", (job, err) => {
  logger.error({ event: "queue.job.failed", queue: FIX_PR_QUEUE_NAME, jobId: job?.id, attempt: job?.attemptsMade, err }, "Fix-PR job failed");
});

logger.info(`Fix-PR worker listening on queue "${FIX_PR_QUEUE_NAME}"`);

// Same process for v1, same crash-isolation rationale as the two workers
// above — dispatching/bootstrapping GitHub Actions runs is just as slow and
// external-API-dependent.
const pipelineWorker = new Worker(PIPELINE_QUEUE_NAME, processPipelineJob, {
  connection: redisConnection,
  concurrency: 2,
});

pipelineWorker.on("completed", (job) => {
  logger.info({ event: "queue.job.completed", queue: PIPELINE_QUEUE_NAME, jobId: job.id, durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined }, "CI pipeline job completed");
});

pipelineWorker.on("active", (job) => {
  logger.info({ event: "queue.job.active", queue: PIPELINE_QUEUE_NAME, jobId: job.id, attempt: job.attemptsMade, waitMs: job.processedOn ? job.processedOn - job.timestamp : undefined }, "CI pipeline job active");
});

pipelineWorker.on("stalled", (jobId) => {
  logger.warn({ event: "queue.job.stalled", queue: PIPELINE_QUEUE_NAME, jobId }, "CI pipeline job stalled");
});

pipelineWorker.on("failed", (job, err) => {
  logger.error({ event: "queue.job.failed", queue: PIPELINE_QUEUE_NAME, jobId: job?.id, attempt: job?.attemptsMade, err }, "CI pipeline job failed");
});

logger.info(`CI pipeline worker listening on queue "${PIPELINE_QUEUE_NAME}"`);

// Same process for v1, same crash-isolation rationale as the three workers
// above — regenerating a fix (another Gemini call) plus another GitHub
// commit/comment round-trip is just as slow/external-API-dependent.
const fixRetryWorker = new Worker(FIX_RETRY_QUEUE_NAME, processFixRetryJob, {
  connection: redisConnection,
  concurrency: 2,
});

fixRetryWorker.on("completed", (job) => {
  logger.info({ event: "queue.job.completed", queue: FIX_RETRY_QUEUE_NAME, jobId: job.id, durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined }, "Fix-retry job completed");
});

fixRetryWorker.on("active", (job) => {
  logger.info({ event: "queue.job.active", queue: FIX_RETRY_QUEUE_NAME, jobId: job.id, attempt: job.attemptsMade, waitMs: job.processedOn ? job.processedOn - job.timestamp : undefined }, "Fix-retry job active");
});

fixRetryWorker.on("stalled", (jobId) => {
  logger.warn({ event: "queue.job.stalled", queue: FIX_RETRY_QUEUE_NAME, jobId }, "Fix-retry job stalled");
});

fixRetryWorker.on("failed", (job, err) => {
  logger.error({ event: "queue.job.failed", queue: FIX_RETRY_QUEUE_NAME, jobId: job?.id, attempt: job?.attemptsMade, err }, "Fix-retry job failed");
});

logger.info(`Fix-retry worker listening on queue "${FIX_RETRY_QUEUE_NAME}"`);

// Emit one bounded sample per queue each minute. Datadog log-based metrics
// can aggregate these fields without tagging job IDs or customer data.
const queues = [repoScanQueue, fixPrQueue, pipelineQueue, fixRetryQueue];
const sampleQueueDepth = async () => {
  for (const queue of queues) {
    try {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
      const oldestWaiting = (counts.waiting ?? 0) > 0 ? (await queue.getWaiting(0, 0))[0] : undefined;
      logger.info({ event: "queue.depth", queue: queue.name, ...counts, oldestWaitingAgeMs: oldestWaiting ? waitingAgeMs(oldestWaiting.timestamp) : null }, "Queue depth sample");
    } catch (err) {
      logger.warn({ event: "queue.depth.error", queue: queue.name, err }, "Could not sample queue depth");
    }
  }
};
void sampleQueueDepth();
setInterval(() => { void sampleQueueDepth(); }, 60_000).unref();
