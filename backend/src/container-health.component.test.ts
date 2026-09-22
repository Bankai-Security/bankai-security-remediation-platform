import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("packaged Bankai API", () => {
  const image = process.env.BANKAI_TEST_IMAGE ?? "bankai-backend-component:phase2";
  let network: StartedNetwork;
  let redis: StartedTestContainer;
  let api: StartedTestContainer;
  let worker: StartedTestContainer;

  const environment = {
    NODE_ENV: "production",
    APP_ENV: "production",
    PORT: "4000",
    SUPABASE_ENV: "production",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "component-anon",
    SUPABASE_SERVICE_ROLE_KEY: "component-service-role",
    ARCJET_KEY: "component-arcjet",
    TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString("base64"),
    FRONTEND_ORIGIN: "http://localhost:5173",
    GEMINI_API_KEY: "component-gemini",
    GITHUB_OAUTH_CLIENT_ID: "component-client",
    GITHUB_OAUTH_CLIENT_SECRET: "component-client-secret",
    AI_PROVIDER: "gemini",
    REDIS_URL: "redis://redis:6379",
  };

  beforeAll(async () => {
    network = await new Network().start();
    redis = await new GenericContainer("redis:7.2.5-alpine")
      .withNetwork(network)
      .withNetworkAliases("redis")
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start();
    api = await new GenericContainer(image)
      .withNetwork(network)
      .withExposedPorts(4000)
      .withEnvironment(environment)
      .withWaitStrategy(Wait.forHttp("/healthz", 4000).forStatusCode(200))
      .withStartupTimeout(120_000)
      .start();
    worker = await new GenericContainer(image)
      .withNetwork(network)
      .withEnvironment(environment)
      .withCommand(["node", "dist/worker.js"])
      .withWaitStrategy(Wait.forLogMessage(/Fix-retry worker listening/))
      .withStartupTimeout(120_000)
      .start();
  }, 120_000);

  afterAll(async () => {
    if (worker) await worker.stop();
    if (api) await api.stop();
    if (redis) await redis.stop();
    if (network) await network.stop();
  });

  it("starts the production image and reports Redis healthy", async () => {
    const response = await fetch(`http://${api.getHost()}:${api.getMappedPort(4000)}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      redis: "PONG",
      queues: { repoScan: { waiting: 0 }, fixPr: { waiting: 0 }, pipeline: { waiting: 0 } },
    });
  });

  it("runs the API and worker from the same image as a non-root user", async () => {
    const [apiIdentity, workerIdentity] = await Promise.all([
      api.exec(["id", "-u"]),
      worker.exec(["id", "-u"]),
    ]);
    expect(apiIdentity.output.trim()).toBe("10001");
    expect(workerIdentity.output.trim()).toBe("10001");
  });
});
