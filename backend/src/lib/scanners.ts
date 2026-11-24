import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { NormalizedFinding } from "./csv-ingest.js";
import type { Severity } from "./finding-types.js";
import type { GithubCredentials } from "./github.js";
import { logger } from "./logger.js";

const execFile = promisify(execFileCallback);
const SCANNER_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface ScannerRun {
  scanner: string;
  version: string;
  findings: number;
  status: "complete" | "skipped" | "failed";
  reason?: string;
}

export interface RepositoryScan {
  findings: NormalizedFinding[];
  scanners: ScannerRun[];
  complete: boolean;
  filesScanned: number;
}

type JsonObject = Record<string, unknown>;
const object = (v: unknown): JsonObject => v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {};
const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

// pip-audit emits no JSON when an audit is clean; it reports the result via
// stderr and exit code instead. For non-empty reports, tolerate incidental
// output before the JSON object while requiring the expected report shape.
function parsePipAuditOutput(output: string, stderr = "", exitCode?: number): unknown {
  const text = output.trim();
  if (!text && (exitCode === 0 || /No known vulnerabilities found/i.test(stderr))) return { dependencies: [] };
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const character = text[end]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{" || character === "[") depth++;
      else if (character === "}" || character === "]") depth--;
      if (depth !== 0) continue;

      try {
        const parsed: unknown = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(object(parsed).dependencies)) return parsed;
      } catch {
        // Keep looking: a log line may itself contain braces before the
        // actual report, or stdout may contain a non-JSON prefix.
      }
      break;
    }
  }

  const excerpt = text.slice(0, 240).replace(/\s+/g, " ");
  const diagnostic = stderr.trim().replace(/\s+/g, " ").slice(-1200);
  throw new Error([
    `pip-audit exited ${exitCode ?? "unknown"}`,
    excerpt ? `no JSON dependency report found; stdout began: ${excerpt}` : "no JSON dependency report found; stdout was empty",
    diagnostic ? `stderr: ${diagnostic}` : "stderr was empty",
  ].join("; "));
}

function isPipAuditAdvisoryServiceFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  // Retry only failures that indicate an advisory feed/network problem. An
  // empty or malformed report can instead mean pip-audit failed while
  // resolving the requirements; switching advisory feeds cannot fix that.
  return /vulnerability service|advisory service|pypi\.org|osv\.dev|connection (?:error|refused|reset)|timed? out|network is unreachable|temporary failure in name resolution|name or service not known|ssl|tls|http (?:429|5\d\d)/i.test(message);
}

function severity(value: unknown): Severity {
  const s = String(value ?? "medium").toLowerCase();
  if (s === "critical" || s === "error") return "Critical";
  if (s === "high") return "High";
  if (["warning", "moderate", "medium", "med"].includes(s)) return "Medium";
  if (["low", "info", "informational", "note"].includes(s)) return "Low";
  return "High";
}

function stableFingerprint(scanner: string, identity: string): string {
  return `${scanner}:${createHash("sha256").update(identity.toLowerCase()).digest("hex")}`;
}

function repositoryRelativePath(path: string | null, repoRoot: string): string | null {
  if (!path) return null;
  const normalized = path.replaceAll("\\", "/");
  const root = repoRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  const marker = normalized.match(/(?:^|\/)tmp\/bankai-scan-[^/]+\/repo\/(.+)$/i);
  return marker?.[1] ?? normalized.replace(/^\.\//, "");
}

function advisoryAliases(primary: string | null, aliases: string[]): string[] {
  const ids = [primary, ...aliases].filter((value): value is string => Boolean(value));
  const cves = ids.filter((value) => /^CVE-\d{4}-\d+$/i.test(value));
  return cves.length ? [...new Set(cves.map((value) => value.toUpperCase()))] : ids.map((value) => value.toUpperCase());
}

function finding(input: {
  scanner: string; id?: string | null; title?: string | null; severity?: unknown; path?: string | null; repoRoot: string;
  line?: number | null; component?: string | null; description?: string | null; url?: string | null;
  cves?: string[]; fixed?: string | null; guidance?: string | null; commitSha: string; __repo?: string;
}): NormalizedFinding {
  const path = repositoryRelativePath(input.path ?? null, input.repoRoot);
  const id = input.id ?? null;
  const title = input.title || id || `${input.scanner} finding`;
  const component = input.component?.trim().toLowerCase() ?? null;
  const stableId = id?.trim().toLowerCase() ?? null;
  const advisoryIds = input.cves?.length ? advisoryAliases(id, input.cves) : [];
  const identity = advisoryIds.length
    ? `${advisoryIds.sort().join(",")}|${component ?? ""}`
    : stableId ? `${stableId}|${component ?? ""}|${path ?? ""}` : `${path ?? "repo"}|${component ?? ""}|${title.toLowerCase()}`;
  const anchor = input.line ? `#L${input.line}` : "";
  return {
    fingerprint: stableFingerprint(advisoryIds.length ? "advisory" : input.scanner, identity), externalId: id, title, severity: severity(input.severity),
    cvssScore: null, cwe: null, component: input.component ?? null, filePath: path,
    findingType: input.scanner, sourceStatus: null, dateFound: null, description: input.description ?? title,
    fixAvailable: input.fixed ?? null, sourceUrl: input.url ?? (path ? `https://github.com/${input.__repo ?? ""}/blob/${input.commitSha}/${path}${anchor}` : null),
    service: null, environment: null, cves: input.cves?.join(", ") ?? null, affectedPackages: input.component ?? null,
    currentVersions: null, fixedVersions: input.fixed ?? null, recommendations: input.guidance ?? null,
    remediationGuidance: input.guidance ?? input.description ?? null, lineStart: input.line ?? null, lineEnd: input.line ?? null,
    commitSha: input.commitSha, source: "github_ai",
    scannerProvenance: [{ scanner: input.scanner, nativeId: id, component: input.component ?? null }],
  } as NormalizedFinding;
}

export function normalizeScannerFindings(scanner: string, data: unknown, repo: string, sha: string, repoRoot: string): NormalizedFinding[] {
  const root = object(data); const out: NormalizedFinding[] = [];
  const add = (value: Omit<Parameters<typeof finding>[0], "scanner" | "commitSha" | "__repo" | "repoRoot">) => out.push(finding({ ...value, scanner, commitSha: sha, __repo: repo, repoRoot }));
  if (scanner === "trivy") for (const result of arr(root.Results).map(object)) {
    const target = str(result.Target);
    for (const v of arr(result.Vulnerabilities).map(object)) {
      const vulnerabilityId = str(v.VulnerabilityID);
      const cves = advisoryAliases(vulnerabilityId, arr(v.CVEIDs).map(String));
      add({ id: vulnerabilityId, title: str(v.Title), severity: v.Severity, path: target, component: str(v.PkgName), description: str(v.Description), url: str(v.PrimaryURL), cves, fixed: str(v.FixedVersion), guidance: str(arr(v.References).map(String).join("; ")) });
    }
    for (const m of arr(result.Misconfigurations).map(object)) { const cause = object(m.CauseMetadata); add({ id: str(m.ID), title: str(m.Title), severity: m.Severity, path: target, line: typeof cause.StartLine === "number" ? cause.StartLine : null, description: str(m.Message), url: str(m.PrimaryURL), guidance: str(m.Resolution) }); }
    for (const s of arr(result.Secrets).map(object)) add({ id: str(s.RuleID), title: str(s.Title) || str(s.RuleID), severity: s.Severity, path: target, line: typeof s.StartLine === "number" ? s.StartLine : null, description: "Potential secret detected; value redacted.", guidance: "Rotate the exposed credential and remove it from repository history." });
  }
  if (scanner === "semgrep") for (const r of arr(root.results).map(object)) { const e = object(r.extra); const m = object(r.start); add({ id: str(r.check_id), title: str(e.message), severity: e.severity, path: str(r.path), line: typeof m.line === "number" ? m.line : null, description: str(e.message), url: str(e.metadata && object(e.metadata).source) }); }
  if (scanner === "bandit") for (const r of arr(root.results).map(object)) add({ id: str(r.test_id), title: str(r.issue_text), severity: r.issue_severity, path: str(r.filename), line: typeof r.line_number === "number" ? r.line_number : null, description: str(r.issue_text), guidance: str(r.more_info) });
  if (scanner === "gitleaks") for (const r of arr(data).map(object)) add({ id: str(r.RuleID), title: str(r.Description) || str(r.RuleID), severity: "high", path: str(r.File), line: typeof r.StartLine === "number" ? r.StartLine : null, description: str(r.Secret) ? `Potential secret detected by ${String(r.RuleID)}.` : str(r.Description), guidance: "Revoke and rotate the exposed secret; remove it from repository history." });
  if (scanner === "npm-audit") for (const [name, raw] of Object.entries(object(root.vulnerabilities))) { const v = object(raw); for (const via of arr(v.via)) { if (typeof via === "string") continue; const item = object(via); add({ id: str(item.url) || `npm:${name}`, title: str(item.title) || `${name} vulnerability`, severity: v.severity, path: "package-lock.json", component: name, description: str(item.title), url: str(item.url), fixed: typeof v.fixAvailable === "object" ? String(object(v.fixAvailable).version ?? "") || null : null }); } }
  if (scanner === "pip-audit") for (const dep of arr(root.dependencies).map(object)) for (const v of arr(dep.vulns).map(object)) add({ id: str(v.id), title: str(v.description) || `${String(dep.name)} vulnerability`, severity: "high", path: str(dep.name), component: str(dep.name), description: str(v.description), url: str(arr(v.aliases).map(String).find(a => a.startsWith("https://")) ?? null), fixed: arr(v.fix_versions).join(", ") || null });
  if (scanner === "osv") {
    const results = arr(root.results);
    for (const result of results.map(object)) for (const pkg of arr(result.packages).map(object)) for (const v of arr(pkg.vulnerabilities).map(object)) {
      const aliases = arr(v.aliases).map(String);
      const vulnerabilityId = str(v.id);
      if (vulnerabilityId?.startsWith("CVE-") && !aliases.includes(vulnerabilityId)) aliases.push(vulnerabilityId);
      add({ id: vulnerabilityId, title: str(v.summary) || str(v.id), severity: object(v.database_specific).severity, path: str(object(pkg.package).name) ? str(result.source && object(result.source).path) : null, component: str(object(pkg.package).name), description: str(v.details), url: str(v.references && arr(v.references).map(object).find(x => x.type === "ADVISORY")?.url), cves: advisoryAliases(vulnerabilityId, aliases) });
    }
  }
  if (scanner === "codeql") for (const run of arr(root.runs).map(object)) for (const r of arr(run.results).map(object)) { const loc = object(arr(r.locations)[0]); const physical = object(object(loc.physicalLocation).artifactLocation); const region = object(object(loc.physicalLocation).region); add({ id: str(r.ruleId), title: str(r.message && object(r.message).text), severity: str(r.level), path: str(physical.uri), line: typeof region.startLine === "number" ? region.startLine : null, description: str(r.message && object(r.message).text) }); }
  return out;
}

async function run(command: string, args: string[], cwd: string, allowFindings = false): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    const home = process.env.HOME ?? tmpdir();
    const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(home, ".cache"), TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: "C.UTF-8", ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}), ...(process.env.PIP_BUILD_CONSTRAINT ? { PIP_BUILD_CONSTRAINT: process.env.PIP_BUILD_CONSTRAINT } : {}), TRIVY_CACHE_DIR: process.env.TRIVY_CACHE_DIR ?? join(tmpdir(), "bankai-trivy-cache"), PIP_DISABLE_PIP_VERSION_CHECK: "1", GIT_TERMINAL_PROMPT: "0", NPM_CONFIG_USERCONFIG: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), SCANNER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) child.kill("SIGKILL"); else stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !(allowFindings && code === 1)) {
        const diagnostic = stderr.trim();
        const context = diagnostic.length > 1600 ? `${diagnostic.slice(0, 1100)}\n…\n${diagnostic.slice(-450)}` : diagnostic;
        reject(new Error(`${command} exited ${code}${context ? `: ${context}` : ""}`));
      } else {
        resolvePromise({ stdout, stderr, code: code ?? -1 });
      }
    });
  });
}

async function version(command: string, args: string[]): Promise<string> {
  const result = await run(command, args, process.cwd()); return result.stdout.trim().split(/\r?\n/)[0] || result.stderr.trim().split(/\r?\n/)[0] || "unknown";
}

async function scanner<T>(name: string, command: string, args: string[], root: string, parse: (stdout: string, stderr?: string, exitCode?: number) => T, allowFindings = false): Promise<{ value: T; run: ScannerRun }> {
  const result = await run(command, args, root, allowFindings);
  let data: T;
  try { data = parse(result.stdout, result.stderr, result.code); }
  catch (error) {
    const detail = error instanceof Error ? error.message : "Could not parse scanner output.";
    throw new Error(`${name} output could not be parsed: ${detail}`);
  }
  return { value: data, run: { scanner: name, version: await version(command, ["--version"]).catch(() => "version unavailable"), findings: 0, status: "complete" } };
}

async function scanDirectory(root: string, repo: string, sha: string): Promise<RepositoryScan> {
  const runs: ScannerRun[] = []; const findings: NormalizedFinding[] = [];
  const invoke = async (name: string, command: string, args: string[], allowFindings = false, findingFilePath?: string, parse: (stdout: string, stderr?: string, exitCode?: number) => unknown = (stdout) => JSON.parse(stdout)) => {
    try {
      let result: Awaited<ReturnType<typeof scanner>>;
      try {
        result = await scanner(name, command, args, root, parse, allowFindings);
      } catch (primaryError) {
        if (name !== "pip-audit") throw primaryError;

        // pip-audit defaults to the PyPI advisory service. Retry against OSV
        // when that service or request fails so a transient PyPI outage does
        // not block remediation verification when the alternate feed works.
        const primaryReason = primaryError instanceof Error ? primaryError.message : "Scanner failed.";
        if (!isPipAuditAdvisoryServiceFailure(primaryError)) throw primaryError;
        logger.warn({ scanner: name, service: "pypi", reason: primaryReason }, "pip-audit primary advisory service failed; retrying with OSV");
        try {
          result = await scanner(name, command, ["--vulnerability-service", "osv", ...args], root, parse, allowFindings);
          result.run.version = `${result.run.version} (OSV fallback)`;
        } catch (fallbackError) {
          const fallbackReason = fallbackError instanceof Error ? fallbackError.message : "Scanner failed.";
          throw new Error(`PyPI audit failed: ${primaryReason}; OSV fallback failed: ${fallbackReason}`);
        }
      }
      const rows = normalizeScannerFindings(name, result.value, repo, sha, root);
      // pip-audit reports the vulnerable distribution name, not the
      // requirements file that caused it to be installed. Preserve the
      // manifest context so remediation targets a real repository file.
      if (name === "pip-audit" && findingFilePath) {
        const manifestPath = findingFilePath.replaceAll("\\", "/");
        for (const row of rows) {
          row.filePath = manifestPath;
          if (row.sourceUrl?.includes(`/blob/${sha}/`)) {
            row.sourceUrl = `https://github.com/${repo}/blob/${sha}/${manifestPath}`;
          }
        }
      }
      result.run.findings = rows.length; runs.push(result.run); findings.push(...rows);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Scanner failed.";
      logger.warn({ scanner: name, reason }, "Repository scanner failed");
      runs.push({ scanner: name, version: "unknown", findings: 0, status: "failed", reason });
    }
  };
  const files = await readdir(root, { recursive: true });
  const names = files.map(String);
  await invoke("trivy", "trivy", ["fs", "--scanners", "vuln,misconfig,secret", "--format", "json", "--quiet", root]);
  await invoke("semgrep", "semgrep", ["scan", "--json", "--quiet", "--metrics=off", "--config", "p/security-audit", root], true);
  await invoke("gitleaks", "gitleaks", ["dir", "--report-format", "json", "--report-path", "-", "--exit-code", "0", root]);
  const addSkipped = (name: string, reason: string) => runs.push({ scanner: name, version: "not-run", findings: 0, status: "skipped", reason });
  if (names.some(n => n.endsWith(".py"))) await invoke("bandit", "bandit", ["-q", "-f", "json", "-r", root], true);
  else addSkipped("bandit", "No Python source files were found.");
  if (names.some(n => ["package-lock.json", "npm-shrinkwrap.json"].includes(n.split(/[\\/]/).at(-1) ?? ""))) {
    try {
      const out = await run("npm", ["audit", "--package-lock-only", "--json", "--userconfig", "/dev/null", "--registry", "https://registry.npmjs.org"], root, true);
      const rows = normalizeScannerFindings("npm-audit", JSON.parse(out.stdout), repo, sha, root); findings.push(...rows); runs.push({ scanner: "npm-audit", version: await version("npm", ["--version"]), findings: rows.length, status: "complete" });
    } catch (error) {
      runs.push({ scanner: "npm-audit", version: await version("npm", ["--version"]).catch(() => "unknown"), findings: 0, status: "failed", reason: error instanceof Error ? error.message : "Scanner failed." });
    }
  } else addSkipped("npm-audit", "No npm lockfile was found.");
  const reqFiles = names.filter(n => /(^|[\\/])requirements[^/\\]*\.txt$/i.test(n));
  if (reqFiles.length) for (const req of reqFiles) await invoke("pip-audit", "pip-audit", ["--format", "json", "-r", resolve(root, req)], true, req, parsePipAuditOutput);
  else addSkipped("pip-audit", "No supported requirements file was found.");
  const hasManifest = names.some(n => /(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|requirements[^/\\]*\.txt|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/.test(n));
  if (hasManifest) await invoke("osv", "osv-scanner", ["scan", "source", "-r", root, "--format", "json"], true);
  else addSkipped("osv", "No supported dependency manifest or lockfile was found.");
  return { findings, scanners: runs, complete: runs.every(run => run.status !== "failed"), filesScanned: names.length };
}

export async function scanRepository(creds: GithubCredentials, commitSha: string): Promise<RepositoryScan> {
  const base = await mkdtemp(join(tmpdir(), "bankai-scan-")); const archive = join(base, "repo.tar.gz"); const root = join(base, "repo");
  await mkdir(root);
  try {
    const response = await fetch(`https://api.github.com/repos/${creds.repo}/tarball/${commitSha}`, { headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
    if (!response.ok || !response.body) throw new Error(`Could not fetch pinned repository archive (${response.status}).`);
    await pipeline(response.body, createWriteStream(archive));
    await execFile("tar", ["-xzf", archive, "--strip-components=1", "-C", root], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    logger.info({ repo: creds.repo, commitSha }, "Running Bankai repository scanner set");
    return await scanDirectory(root, creds.repo, commitSha);
  } finally { await rm(base, { recursive: true, force: true }); }
}
