import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../env.js";
import { generateFix } from "./gemini-fix.js";
import { analyzeFiles } from "./gemini.js";

const originalProvider = env.AI_PROVIDER;
const finding = { title: "Injection", cwe: "CWE-94", filePath: "app.js", lineStart: 1, lineEnd: 1, evidence: "eval(input)", remediationGuidance: "Remove eval" };
const fix = { confident: true, fixedContent: "safe(input)", summary: "Removed eval" };
function completion(content: unknown, finish = "stop") {
  return Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(content) } }] });
}

describe("DeepSeek through OpenRouter", () => {
  beforeEach(() => { env.AI_PROVIDER = "openrouter"; });
  afterEach(() => { env.AI_PROVIDER = originalProvider; vi.unstubAllGlobals(); });

  it("routes fixes and CI retries through the configured model with structured output", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => completion(fix));
    vi.stubGlobal("fetch", fetchMock);
    expect(await generateFix(finding, "eval(input)", { attempt: 2, maxAttempts: 3, failedStage: "test", failureLog: "missing safe" })).toEqual(fix);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${env.OPENROUTER_BASE_URL}/chat/completions`);
    const body = JSON.parse(options.body);
    expect(body.model).toBe(env.OPENROUTER_MODEL_NAME);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.messages[1].content).toContain("missing safe");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("scans files through DeepSeek and validates finding fields", async () => {
    const result = { ...finding, severity: "High" };
    vi.stubGlobal("fetch", vi.fn(async () => completion({ findings: [result] })));
    expect(await analyzeFiles([{ path: "app.js", content: "eval(input)" }], { repo: "org/app", commitSha: "abc" })).toEqual([result]);
  });

  it("rejects a truncated patch even when its JSON is valid, then retries with more tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(completion(fix, "length")).mockResolvedValueOnce(completion(fix));
    vi.stubGlobal("fetch", fetchMock);
    expect(await generateFix(finding, "eval(input)")).toEqual(fix);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).max_tokens).toBe(16384);
  });

  it("never accepts malformed patches or provider failures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: "private data" }, { status: 401 })).mockResolvedValueOnce(completion({ summary: "missing content" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await generateFix(finding, "eval(input)")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
