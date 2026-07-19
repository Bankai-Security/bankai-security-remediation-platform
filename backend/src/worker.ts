import { Worker } from "bullmq";
import { processRepoScanJob } from "./jobs/repo-scan.job.js";
import { logger } from "./lib/logger.js";
import { redisConnection, REPO_SCAN_QUEUE_NAME } from "./lib/queue.js";

// Separate process from the API server (backend/src/server.ts) —
// Gemini calls + repo fetching are slow, and a scan job crashing or OOMing
// must not take the request-handling process down with it. Run alongside
// the API server: `npm run worker` in dev, a second process/dyno in prod.
const worker = new Worker(REPO_SCAN_QUEUE_NAME, processRepoScanJob, {
  connection: redisConnection,
  concurrency: 2,
});

worker.on("completed", (job) => {
  logger.info({ jobId: job.id, data: job.data }, "Repo scan job completed");
});

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, data: job?.data, err }, "Repo scan job failed");
});

logger.info(`Repo scan worker listening on queue "${REPO_SCAN_QUEUE_NAME}"`);
