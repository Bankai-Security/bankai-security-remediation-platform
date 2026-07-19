import { extname } from "node:path";

// Directories whose contents are never worth scanning — generated,
// vendored, or version-control internals.
const SKIP_DIR_SEGMENTS = new Set(["node_modules", "vendor", "dist", "build", ".git", "coverage", ".next", ".turbo"]);

const SKIP_FILENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "Cargo.lock",
]);

// Allowlist, not a denylist — scanning is opt-in per extension so binary,
// media, and other non-code files are never fetched or sent to Gemini.
const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rs",
  ".sql",
  ".yml",
  ".yaml",
  ".json",
  ".tf",
  ".html",
  ".css",
  ".scss",
]);

export function isScannablePath(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => SKIP_DIR_SEGMENTS.has(segment))) return false;

  const filename = segments[segments.length - 1] ?? "";
  if (SKIP_FILENAMES.has(filename)) return false;

  return ALLOWED_EXTENSIONS.has(extname(filename).toLowerCase());
}

export interface RepoFileCandidate {
  path: string;
  sha: string;
  size: number;
}

export interface RepoScanCaps {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface FilterResult {
  files: RepoFileCandidate[];
  totalEligible: number;
}

// Filters by path/extension and per-file size first (cheap, no network
// cost), then caps the survivors by count and cumulative size so a huge
// monorepo can't blow the scan's latency/cost budget. Files dropped purely
// for exceeding the caps are reported via totalEligible - files.length so
// the caller can surface "scanned N of M eligible files" rather than
// silently under-scanning.
export function filterScannableFiles(candidates: RepoFileCandidate[], caps: RepoScanCaps): FilterResult {
  const eligible = candidates.filter((c) => isScannablePath(c.path) && c.size > 0 && c.size <= caps.maxFileBytes);

  const files: RepoFileCandidate[] = [];
  let totalBytes = 0;
  for (const candidate of eligible) {
    if (files.length >= caps.maxFiles) break;
    if (totalBytes + candidate.size > caps.maxTotalBytes) continue;
    files.push(candidate);
    totalBytes += candidate.size;
  }

  return { files, totalEligible: eligible.length };
}
