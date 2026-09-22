import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["**/*.component.test.ts", "**/*.integration.test.ts", "**/node_modules/**", "dist/**"],
  },
});
