import { randomUUID } from "node:crypto";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("BullMQ queue rules with isolated Redis", () => {
  let container: StartedTestContainer;
  let queues: typeof import("./queue.js");

  beforeAll(async () => {
    container = await new GenericContainer("redis:7.2.5-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start();
    process.env.REDIS_URL = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    vi.resetModules();
    queues = await import("./queue.js");
    await queues.redisConnection.ping();
  });

  afterAll(async () => {
    if (queues) {
      await Promise.all([
        queues.repoScanQueue.close(),
        queues.fixPrQueue.close(),
        queues.pipelineQueue.close(),
        queues.fixRetryQueue.close(),
      ]);
      await queues.redisConnection.quit();
    }
    if (container) await container.stop();
  });

  it("deduplicates repository webhook deliveries by caller job ID", async () => {
    const suffix = randomUUID();
    const jobId = `webhook-project-${suffix}`;
    const data = { scanId: suffix, projectId: "project", triggerType: "webhook" as const, baseSha: "a", headSha: "b" };
    await queues.enqueueRepoScan(data, jobId);
    await queues.enqueueRepoScan(data, jobId);
    expect((await queues.repoScanQueue.getJobs(["waiting"])).filter((job) => job.id === jobId)).toHaveLength(1);
  });

  it("creates unique IDs for explicit pipeline retries", async () => {
    const data = { ticketId: randomUUID(), projectId: "project" };
    const first = await queues.enqueuePipelineRetry(data);
    const second = await queues.enqueuePipelineRetry(data);
    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
    expect(first.id).not.toBe(second.id);
  });

  it("only clears the Quincy checkpoint that matches the completed job", async () => {
    const data = { ticketId: randomUUID(), projectId: "project" };
    await queues.saveQuincyCheckpoint(data, "new-job");
    await queues.clearQuincyCheckpoint(data, "stale-job");
    expect(await queues.loadQuincyCheckpoint(data)).toBe("new-job");
    await queues.clearQuincyCheckpoint(data, "new-job");
    expect(await queues.loadQuincyCheckpoint(data)).toBeUndefined();
  });

  it("round-trips progress and preserves ticket ordering", async () => {
    const first = { ticketId: randomUUID(), projectId: "project" };
    const secondId = randomUUID();
    const progress = { summary: "Validating patch", activeAttempt: 2, completedAttempts: 1, updatedAt: "2026-09-19T00:00:00Z" };
    await queues.saveRemediationProgress(first, progress);
    expect(await queues.getRemediationProgress("project", [secondId, first.ticketId])).toEqual([null, progress]);
  });
});
