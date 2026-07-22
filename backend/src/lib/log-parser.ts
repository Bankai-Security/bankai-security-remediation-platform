// Extracts repo file paths mentioned in a CI failure log (stack traces,
// compiler diagnostics, test-runner output) across the languages
// stack-detect.ts recognizes. Used by repo-context.ts to widen fix context
// beyond the single vulnerable file to whatever the CI log itself points at
// (e.g. a test file, or a dependent module a compiler flagged).
//
// Each pattern captures a *raw* path exactly as the tool printed it — which
// may be absolute (a GitHub Actions runner path like
// /home/runner/work/repo/repo/src/foo.py) or already repo-relative. Raw
// paths are resolved against the branch's actual tree in resolveAgainstTree
// rather than trusted directly, so a log line that happens to contain
// something path-shaped but isn't a real file in this repo is dropped
// instead of causing a failed blob fetch downstream.
const LOG_PATH_PATTERNS: RegExp[] = [
  // Python (pytest/unittest tracebacks): File "path/to/file.py", line 42
  /File "([^"]+\.py)", line \d+/g,
  // Python (pytest short summary): FAILED path/to/test_file.py::test_name
  /FAILED\s+([^\s:]+\.py)(?:::\S+)?/g,
  // JS/TS (Jest): FAIL src/foo.test.ts
  /FAIL\s+([^\s]+\.(?:test|spec)\.[jt]sx?)/g,
  // JS/TS stack frames: at Object.<anonymous> (src/foo.ts:10:5)
  /\bat .*\(([^\s()]+\.[cm]?[jt]sx?):\d+:\d+\)/g,
  // TypeScript compiler: src/foo.ts(10,5): error TS2345
  /([^\s()]+\.[cm]?tsx?)\(\d+,\d+\): error TS\d+/g,
  // Java (Maven/Gradle compiler + stack frames): at com.foo.Bar(Bar.java:42) / Bar.java:[10,5]
  /\(([A-Za-z0-9_$]+\.java):\d+\)/g,
  /([^\s]+\.java):\[\d+,\d+\]/g,
  // Go (build errors + `--- FAIL` test output): ./pkg/foo.go:10:2: / foo_test.go:15:
  /([^\s]+\.go):\d+(?::\d+)?:/g,
  // Rust (panics + compiler diagnostics): panicked at 'msg', src/lib.rs:10:5 / --> src/lib.rs:10:5
  /(?:panicked at .*|-->)\s+([^\s,]+\.rs):\d+:\d+/g,
  // C# / .NET stack frames: at Namespace.Class.Method() in /path/File.cs:line 42
  /\bin\s+([^\s]+\.cs):line \d+/g,
  // C/C++ (gcc/clang/make diagnostics): src/foo.cpp:10:5: error:
  /([^\s]+\.(?:c|cc|cpp|h|hpp)):\d+:\d+:\s*(?:error|warning)/g,
  // PHP (PHPUnit): /path/to/FooTest.php:42
  /([^\s]+\.php):\d+/g,
  // Ruby (RSpec/Minitest): ./spec/foo_spec.rb:10
  /([^\s]+\.rb):\d+/g,
];

const MAX_MATCHES = 200; // guards against a pathological log producing an unbounded candidate set

function stripLeadingDotSlash(path: string): string {
  return path.replace(/^\.\//, "");
}

// A raw path from a log line may be absolute (runner-specific prefix) or
// already repo-relative. Resolve it against the real tree by trying an exact
// match first, then falling back to "does a real tree path match the raw
// path's own trailing segments" — handles both directions without needing to
// know the runner's checkout prefix.
function resolveAgainstTree(rawPath: string, treePaths: Set<string>): string | null {
  const cleaned = stripLeadingDotSlash(rawPath);
  if (treePaths.has(cleaned)) return cleaned;

  for (const treePath of treePaths) {
    if (cleaned === treePath || cleaned.endsWith(`/${treePath}`) || treePath.endsWith(`/${cleaned}`)) {
      return treePath;
    }
  }
  return null;
}

// Best-effort, never throws — a log format this doesn't recognize just
// yields fewer resolved paths, same fail-open contract as the rest of the
// context-assembly path (gatherRepoContext catches everything around this).
export function extractFailingFilePaths(log: string, treePaths: Set<string>): string[] {
  const resolved = new Set<string>();
  let matchCount = 0;

  for (const pattern of LOG_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(log)) !== null && matchCount < MAX_MATCHES) {
      matchCount++;
      const raw = match[1];
      if (!raw) continue;
      const hit = resolveAgainstTree(raw, treePaths);
      if (hit) resolved.add(hit);
    }
  }

  return Array.from(resolved);
}
