import { beforeEach, expect, it, vi } from "vitest";
import { analyzeFiles } from "./gemini.js";
import { generateOpenRouterJson } from "./openrouter.js";

vi.mock("../env.js", () => ({ env: { AI_PROVIDER: "openrouter" } }));
vi.mock("./openrouter.js", () => ({ generateOpenRouterJson: vi.fn() }));
vi.mock("./logger.js", () => ({ logger: { error: vi.fn() } }));
const provider = vi.mocked(generateOpenRouterJson);
const context = { repo: "test/synthetic", commitSha: "a".repeat(40) };
const files = [{ path: "example.js", content: "example" }];
beforeEach(() => { provider.mockReset(); });

it("does not turn provider authentication failure into a clean scan", async () => {
  provider.mockRejectedValue(new Error("OpenRouter request failed (401)"));
  await expect(analyzeFiles(files, context)).rejects.toThrow("scan is incomplete");
  expect(provider).toHaveBeenCalledTimes(2);
});

it.each(["", "invalid json", '{"unexpected":true}'])("rejects repeatedly invalid assessment: %s", async response => {
  provider.mockResolvedValue(response);
  await expect(analyzeFiles(files, context)).rejects.toThrow("scan is incomplete");
});

it("accepts a valid empty findings result", async () => {
  provider.mockResolvedValue('{"findings":[]}');
  await expect(analyzeFiles(files, context)).resolves.toEqual([]);
});

it("does not return partial results when a later chunk cannot be assessed", async () => {
  provider.mockResolvedValueOnce('{"findings":[]}').mockRejectedValue(new Error("Unavailable"));
  await expect(analyzeFiles([{ path: "large.js", content: "x".repeat(40001) }, ...files], context)).rejects.toThrow("scan is incomplete");
});
