import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const counts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
vi.mock("./lib/queue.js", () => ({
  redisConnection: { ping: vi.fn().mockResolvedValue("PONG") },
  repoScanQueue: { getJobCounts: vi.fn().mockResolvedValue(counts) },
  fixPrQueue: { getJobCounts: vi.fn().mockResolvedValue(counts) },
  pipelineQueue: { getJobCounts: vi.fn().mockResolvedValue(counts) },
}));

describe("Bankai HTTP application boundary", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const { createApp } = await import("./app.js");
    server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("serves a dependency-aware health response with security headers", async () => {
    const response = await fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toMatchObject({ status: "ok", redis: "PONG" });
  });

  it("returns the stable JSON not-found contract", async () => {
    const response = await fetch(`${origin}/not-a-route`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });
});
