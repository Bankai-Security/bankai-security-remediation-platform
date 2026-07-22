import { env } from "../env.js";
import { getBlobs, getTree, type GitTreeEntry, type GithubCredentials } from "./github.js";
import { extractFailingFilePaths } from "./log-parser.js";
import { logger } from "./logger.js";

export interface RepoContextResult {
  treeSummary: string;
  importedFiles: Array<{ path: string; content: string }>;
  testFiles: Array<{ path: string; content: string }>;
  formattedPromptContext: string;
}

export interface GatherContextOptions {
  creds: GithubCredentials;
  ref: string;
  targetFilePath: string;
  vulnerableFileContent: string;
  failingLog?: string | null;
}

/**
 * Parses import/include/require statements across major programming languages
 * to discover local files imported or referenced by the target file.
 */
function extractImportedPaths(filePath: string, fileContent: string, allTreePaths: Set<string>): string[] {
  const imported = new Set<string>();
  const lines = fileContent.split("\n");

  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*")) {
      continue;
    }

    let targetPath: string | null = null;

    // JS / TS: import x from './foo', import './foo', require('./bar'), import('./baz')
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
      const match = trimmed.match(/(?:from\s+|require\s*\(\s*|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/);
      if (match && match[1]) {
        targetPath = match[1];
      }
    }
    // Python: from .foo import bar OR import relative
    else if (ext === ".py") {
      const match = trimmed.match(/from\s+(\.[a-zA-Z0-9_.]+)\s+import/);
      if (match && match[1]) {
        targetPath = match[1].replace(/^\./, "./").replace(/\./g, "/");
      }
    }
    // C / C++: #include "foo.h"
    else if (ext === ".c" || ext === ".cpp" || ext === ".h" || ext === ".hpp") {
      const match = trimmed.match(/#include\s+["']([^"']+)["']/);
      if (match && match[1] && !match[1].startsWith("<")) {
        targetPath = match[1];
      }
    }

    if (targetPath) {
      let resolved = targetPath;
      if (targetPath.startsWith("./") || targetPath.startsWith("../")) {
        const parts = (dir ? dir + "/" + targetPath : targetPath).split("/");
        const stack: string[] = [];
        for (const p of parts) {
          if (p === "." || p === "") continue;
          if (p === "..") stack.pop();
          else stack.push(p);
        }
        resolved = stack.join("/");
      }

      const candidates = [
        resolved,
        `${resolved}${ext}`,
        `${resolved}.ts`,
        `${resolved}.js`,
        `${resolved}/index.ts`,
        `${resolved}/index.js`,
        `${resolved}.py`,
        `${resolved}.h`,
        `${resolved}.hpp`,
      ];

      for (const cand of candidates) {
        if (allTreePaths.has(cand) && cand !== filePath) {
          imported.add(cand);
          break;
        }
      }
    }
  }

  return Array.from(imported);
}

// Shared by findRelatedTestFiles (naming-convention search near the target
// file) and gatherRepoContext (classifying a log-discovered path so it lands
// in the test-files budget instead of the imported-modules budget).
function isTestFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("test_") ||
    lower.includes("_test.") ||
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("/__tests__/")
  );
}

/**
 * Finds test files associated with the target file or components in the repository.
 */
function findRelatedTestFiles(targetFilePath: string, tree: GitTreeEntry[]): GitTreeEntry[] {
  const baseName = targetFilePath.slice(targetFilePath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const tests: GitTreeEntry[] = [];

  for (const entry of tree) {
    if (entry.type !== "blob" || !isTestFilePath(entry.path)) continue;
    if (entry.path.toLowerCase().includes(baseName.toLowerCase())) {
      tests.unshift(entry);
    } else {
      tests.push(entry);
    }
  }

  return tests;
}

function dedupOrdered(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

/**
 * Generates a tree summary string up to MAX_FIX_TREE_DEPTH.
 */
function buildTreeSummary(tree: GitTreeEntry[]): string {
  const maxDepth = env.MAX_FIX_TREE_DEPTH;
  const paths: string[] = [];

  for (const entry of tree) {
    const depth = entry.path.split("/").length;
    if (depth <= maxDepth) {
      paths.push(`${entry.type === "tree" ? "[DIR] " : "      "}${entry.path}`);
    }
  }

  return paths.slice(0, 100).join("\n") + (paths.length > 100 ? "\n... (truncated)" : "");
}

/**
 * Fail-open context gatherer for AI fix generation.
 * Assembles repository tree summary, imported file contents, and test file contents
 * under strict environment budget limits.
 */
export async function gatherRepoContext(options: GatherContextOptions): Promise<RepoContextResult> {
  const { creds, ref, targetFilePath, vulnerableFileContent, failingLog } = options;

  try {
    const tree = await getTree(creds, ref);
    const treeSummary = buildTreeSummary(tree);
    const allTreePaths = new Set(tree.map((e) => e.path));

    // Failure logs (build/lint/test-runner/compiler output — pytest, jest,
    // mvn/javac, go test, cargo test, dotnet test, tsc, gcc/clang, phpunit,
    // rspec) point at concrete files the log itself blames, which may be
    // neither an import of the target file nor named after it — e.g. an
    // unrelated module a compiler flagged, or a test file that doesn't share
    // the target file's basename. These are listed first in each ordered
    // list below so they survive the budget cap ahead of weaker
    // naming/import-convention matches.
    const logBlamedPaths = failingLog ? extractFailingFilePaths(failingLog, allTreePaths) : [];
    const logTestPaths = logBlamedPaths.filter((p) => p !== targetFilePath && isTestFilePath(p));
    const logImportPaths = logBlamedPaths.filter((p) => p !== targetFilePath && !isTestFilePath(p));

    const importCandidates = dedupOrdered([...logImportPaths, ...extractImportedPaths(targetFilePath, vulnerableFileContent, allTreePaths)]);
    const testCandidates = dedupOrdered([...logTestPaths, ...findRelatedTestFiles(targetFilePath, tree).map((e) => e.path)]);

    const entryByPath = new Map(tree.map((e) => [e.path, e]));
    const importedEntries = importCandidates.map((p) => entryByPath.get(p)).filter((e): e is GitTreeEntry => e != null);
    const relevantTestEntries = testCandidates.map((p) => entryByPath.get(p)).filter((e): e is GitTreeEntry => e != null);

    const cappedImported = importedEntries.slice(0, env.MAX_FIX_CONTEXT_FILES);
    const cappedTests = relevantTestEntries.slice(0, env.MAX_FIX_TEST_FILES);

    const toFetchMap = new Map<string, { path: string; sha: string }>();
    for (const item of [...cappedImported, ...cappedTests]) {
      if (item.path !== targetFilePath && item.sha) {
        toFetchMap.set(item.path, { path: item.path, sha: item.sha });
      }
    }

    const toFetch = Array.from(toFetchMap.values());
    const fetched = toFetch.length > 0 ? await getBlobs(creds, toFetch, 5) : [];
    const fetchedMap = new Map(fetched.map((f) => [f.path, f.content]));

    let currentBytes = 0;
    const maxBytes = env.MAX_FIX_CONTEXT_BYTES;

    const importedFiles: Array<{ path: string; content: string }> = [];
    for (const entry of cappedImported) {
      const content = fetchedMap.get(entry.path);
      if (content && currentBytes + content.length <= maxBytes) {
        importedFiles.push({ path: entry.path, content });
        currentBytes += content.length;
      }
    }

    const testFiles: Array<{ path: string; content: string }> = [];
    for (const entry of cappedTests) {
      const content = fetchedMap.get(entry.path);
      if (content && currentBytes + content.length <= maxBytes) {
        testFiles.push({ path: entry.path, content });
        currentBytes += content.length;
      }
    }

    let formattedPromptContext = `=== REPOSITORY MAP (Depth <= ${env.MAX_FIX_TREE_DEPTH}) ===\n${treeSummary}\n\n`;

    if (importedFiles.length > 0) {
      formattedPromptContext += `=== RELATED IMPORTED MODULES ===\n`;
      for (const file of importedFiles) {
        formattedPromptContext += `--- FILE: ${file.path} ---\n${file.content}\n\n`;
      }
    }

    if (testFiles.length > 0) {
      formattedPromptContext += `=== RELEVANT TEST SUITES / FIXTURES ===\n`;
      for (const file of testFiles) {
        formattedPromptContext += `--- FILE: ${file.path} ---\n${file.content}\n\n`;
      }
    }

    return {
      treeSummary,
      importedFiles,
      testFiles,
      formattedPromptContext,
    };
  } catch (err) {
    logger.error({ err, repo: creds.repo, targetFilePath }, "Failed to gather repository context — failing open to default context");
    return {
      treeSummary: "",
      importedFiles: [],
      testFiles: [],
      formattedPromptContext: "",
    };
  }
}
