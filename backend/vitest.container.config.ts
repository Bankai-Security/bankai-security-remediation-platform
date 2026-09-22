import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/container-health.component.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
