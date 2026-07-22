import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitTreeEntry, GithubCredentials } from "./github.js";

const getTree = vi.fn<(creds: GithubCredentials, ref: string) => Promise<GitTreeEntry[]>>();
const getBlobs =
  vi.fn<(creds: GithubCredentials, files: { path: string; sha: string }[], concurrency?: number) => Promise<{ path: string; content: string }[]>>();

vi.mock("./github.js", () => ({ getTree, getBlobs }));

const { gatherRepoContext } = await import("./repo-context.js");

const CREDS: GithubCredentials = { repo: "acme/widgets", token: "t" };

function entry(path: string, type: GitTreeEntry["type"] = "blob"): GitTreeEntry {
  return { path, type, sha: `sha-${path}` };
}

describe("gatherRepoContext", () => {
  beforeEach(() => {
    getTree.mockReset();
    getBlobs.mockReset();
  });

  it("fails open (returns empty context, never throws) when the tree fetch fails", async () => {
    getTree.mockRejectedValue(new Error("network down"));

    const result = await gatherRepoContext({
      creds: CREDS,
      ref: "bankai/fix-1",
      targetFilePath: "src/auth.ts",
      vulnerableFileContent: "export const x = 1;",
    });

    expect(result).toEqual({ treeSummary: "", importedFiles: [], testFiles: [], formattedPromptContext: "" });
    expect(getBlobs).not.toHaveBeenCalled();
  });

  it("discovers a relative import and a naming-convention test file, then fetches both", async () => {
    getTree.mockResolvedValue([
      entry("src/auth.ts"),
      entry("src/helpers.ts"),
      entry("src/auth.test.ts"),
      entry("README.md"),
    ]);
    getBlobs.mockImplementation(async (_creds, files) => files.map((f) => ({ path: f.path, content: `content of ${f.path}` })));

    const result = await gatherRepoContext({
      creds: CREDS,
      ref: "bankai/fix-1",
      targetFilePath: "src/auth.ts",
      vulnerableFileContent: `import { helper } from "./helpers";\nexport const x = helper();`,
    });

    expect(result.importedFiles.map((f) => f.path)).toEqual(["src/helpers.ts"]);
    expect(result.testFiles.map((f) => f.path)).toEqual(["src/auth.test.ts"]);
    expect(result.formattedPromptContext).toContain("RELATED IMPORTED MODULES");
    expect(result.formattedPromptContext).toContain("RELEVANT TEST SUITES");
    // The target file itself is never re-fetched as its own context.
    expect(getBlobs).toHaveBeenCalledWith(
      CREDS,
      expect.arrayContaining([expect.objectContaining({ path: "src/helpers.ts" }), expect.objectContaining({ path: "src/auth.test.ts" })]),
      expect.any(Number),
    );
    const [, fetchedFiles] = getBlobs.mock.calls[0]!;
    expect(fetchedFiles.some((f) => f.path === "src/auth.ts")).toBe(false);
  });

  it("discovers a file blamed in a CI failure log that isn't named after the target file", async () => {
    getTree.mockResolvedValue([entry("src/auth.ts"), entry("src/unrelated.py"), entry("tests/unrelated_test.py")]);
    getBlobs.mockImplementation(async (_creds, files) => files.map((f) => ({ path: f.path, content: `content of ${f.path}` })));

    const failingLog = 'File "/home/runner/work/repo/repo/src/unrelated.py", line 3, in run\nFAILED tests/unrelated_test.py::test_x';

    const result = await gatherRepoContext({
      creds: CREDS,
      ref: "bankai/fix-1",
      targetFilePath: "src/auth.ts",
      vulnerableFileContent: "export const x = 1;",
      failingLog,
    });

    expect(result.importedFiles.map((f) => f.path)).toContain("src/unrelated.py");
    expect(result.testFiles.map((f) => f.path)).toContain("tests/unrelated_test.py");
  });

  it("enforces the imported-file and test-file count budgets", async () => {
    vi.resetModules();
    vi.doMock("../env.js", () => ({
      env: { MAX_FIX_CONTEXT_FILES: 2, MAX_FIX_CONTEXT_BYTES: 1_000_000, MAX_FIX_TEST_FILES: 1, MAX_FIX_TREE_DEPTH: 3 },
    }));
    vi.doMock("./github.js", () => ({ getTree, getBlobs }));
    const { gatherRepoContext: gatherWithSmallBudget } = await import("./repo-context.js");

    const tree: GitTreeEntry[] = [entry("src/auth.ts")];
    let importLine = "";
    for (let i = 0; i < 5; i++) {
      tree.push(entry(`src/mod${i}.ts`));
      tree.push(entry(`src/mod${i}.test.ts`));
      importLine += `import { m${i} } from "./mod${i}";\n`;
    }
    getTree.mockResolvedValue(tree);
    getBlobs.mockImplementation(async (_creds, files) => files.map((f) => ({ path: f.path, content: "x" })));

    const result = await gatherWithSmallBudget({
      creds: CREDS,
      ref: "bankai/fix-1",
      targetFilePath: "src/auth.ts",
      vulnerableFileContent: importLine,
    });

    expect(result.importedFiles.length).toBeLessThanOrEqual(2);
    expect(result.testFiles.length).toBeLessThanOrEqual(1);

    vi.doUnmock("../env.js");
    vi.doUnmock("./github.js");
  });

  it("enforces the total byte budget across imported and test files combined", async () => {
    vi.resetModules();
    vi.doMock("../env.js", () => ({
      env: { MAX_FIX_CONTEXT_FILES: 10, MAX_FIX_CONTEXT_BYTES: 15, MAX_FIX_TEST_FILES: 10, MAX_FIX_TREE_DEPTH: 3 },
    }));
    vi.doMock("./github.js", () => ({ getTree, getBlobs }));
    const { gatherRepoContext: gatherWithByteBudget } = await import("./repo-context.js");

    getTree.mockResolvedValue([entry("src/auth.ts"), entry("src/helpers.ts")]);
    getBlobs.mockResolvedValue([{ path: "src/helpers.ts", content: "x".repeat(1000) }]);

    const result = await gatherWithByteBudget({
      creds: CREDS,
      ref: "bankai/fix-1",
      targetFilePath: "src/auth.ts",
      vulnerableFileContent: `import { h } from "./helpers";`,
    });

    // The 1000-byte file blows the 15-byte total budget, so it's dropped rather than truncated in place.
    expect(result.importedFiles).toEqual([]);

    vi.doUnmock("../env.js");
    vi.doUnmock("./github.js");
  });
});
