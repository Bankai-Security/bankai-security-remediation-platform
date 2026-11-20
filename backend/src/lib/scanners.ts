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

function finding(input: {
  scanner: string; id?: string | null; title?: string | null; severity?: unknown; path?: string | null;
  line?: number | null; component?: string | null; description?: string | null; url?: string | null;
  cves?: string[]; fixed?: string | null; guidance?: string | null; commitSha: string; __repo?: string;
}): NormalizedFinding {
  const path = input.path?.replaceAll("\\", "/").replace(/^\.?\//, "") ?? null;
  const id = input.id ?? null;
  const title = input.title || id || `${input.scanner} finding`;
  const identity = input.cves?.length
    ? `${input.cves.map(cve => cve.toLowerCase()).sort().join(",")}|${input.component ?? ""}`
    : id ? `${id}|${input.component ?? ""}|${path ?? ""}` : `${path ?? "repo"}|${input.component ?? ""}|${title}`;
  const anchor = input.line ? `#L${input.line}` : "";
  return {
    fingerprint: stableFingerprint(input.cves?.length ? "advisory" : input.scanner, identity), externalId: id, title, severity: severity(input.severity),
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

function normalize(scanner: string, data: unknown, repo: string, sha: string): NormalizedFinding[] {
  const root = object(data); const out: NormalizedFinding[] = [];
  const add = (value: Omit<Parameters<typeof finding>[0], "scanner" | "commitSha" | "__repo">) => out.push(finding({ ...value, scanner, commitSha: sha, __repo: repo }));
  if (scanner === "trivy") for (const result of arr(root.Results).map(object)) {
    const target = str(result.Target);
    for (const v of arr(result.Vulnerabilities).map(object)) {
      const vulnerabilityId = str(v.VulnerabilityID);
      const cves = arr(v.CVEIDs).map(String);
      if (vulnerabilityId?.startsWith("CVE-") && !cves.includes(vulnerabilityId)) cves.push(vulnerabilityId);
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
      add({ id: vulnerabilityId, title: str(v.summary) || str(v.id), severity: object(v.database_specific).severity, path: str(object(pkg.package).name) ? str(result.source && object(result.source).path) : null, component: str(object(pkg.package).name), description: str(v.details), url: str(v.references && arr(v.references).map(object).find(x => x.type === "ADVISORY")?.url), cves: aliases.filter(a => a.startsWith("CVE-")) });
    }
  }
  if (scanner === "codeql") for (const run of arr(root.runs).map(object)) for (const r of arr(run.results).map(object)) { const loc = object(arr(r.locations)[0]); const physical = object(object(loc.physicalLocation).artifactLocation); const region = object(object(loc.physicalLocation).region); add({ id: str(r.ruleId), title: str(r.message && object(r.message).text), severity: str(r.level), path: str(physical.uri), line: typeof region.startLine === "number" ? region.startLine : null, description: str(r.message && object(r.message).text) }); }
  return out;
}

async function run(command: string, args: string[], cwd: string, allowFindings = false): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? tmpdir(), TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: "C.UTF-8", SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? "", TRIVY_CACHE_DIR: process.env.TRIVY_CACHE_DIR ?? join(tmpdir(), "bankai-trivy-cache"), PIP_DISABLE_PIP_VERSION_CHECK: "1", GIT_TERMINAL_PROMPT: "0", NPM_CONFIG_USERCONFIG: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), SCANNER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) child.kill("SIGKILL"); else stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); if (code !== 0 && !(allowFindings && code === 1)) reject(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`)); else resolvePromise({ stdout, stderr, code: code ?? -1 }); });
  });
}

async function version(command: string, args: string[]): Promise<string> {
  const result = await run(command, args, process.cwd()); return result.stdout.trim().split(/\r?\n/)[0] || result.stderr.trim().split(/\r?\n/)[0] || "unknown";
}

async function scanner<T>(name: string, command: string, args: string[], root: string, parse: (s: string) => T, allowFindings = false): Promise<{ value: T; run: ScannerRun }> {
  const result = await run(command, args, root, allowFindings);
  let data: T; try { data = parse(result.stdout); } catch { throw new Error(`${name} returned invalid JSON.`); }
  return { value: data, run: { scanner: name, version: await version(command, ["--version"]).catch(() => "version unavailable"), findings: 0, status: "complete" } };
}

async function scanDirectory(root: string, repo: string, sha: string): Promise<RepositoryScan> {
  const runs: ScannerRun[] = []; const findings: NormalizedFinding[] = [];
  const invoke = async (name: string, command: string, args: string[], allowFindings = false) => {
    try {
      const result = await scanner(name, command, args, root, JSON.parse, allowFindings);
      const rows = normalize(name, result.value, repo, sha); result.run.findings = rows.length; runs.push(result.run); findings.push(...rows);
    } catch (error) {
      runs.push({ scanner: name, version: "unknown", findings: 0, status: "failed", reason: error instanceof Error ? error.message : "Scanner failed." });
    }
  };
  const files = await readdir(root, { recursive: true });
  const names = files.map(String);
  await invoke("trivy", "trivy", ["fs", "--scanners", "vuln,misconfig,secret", "--format", "json", "--quiet", root]);
  await invoke("semgrep", "semgrep", ["scan", "--json", "--quiet", "--metrics=off", "--config", "p/security-audit", root], true);
  await invoke("gitleaks", "gitleaks", ["dir", "--report-format", "json", "--report-path", "/dev/stdout", "--exit-code", "0", root]);
  const addSkipped = (name: string, reason: string) => runs.push({ scanner: name, version: "not-run", findings: 0, status: "skipped", reason });
  if (names.some(n => n.endsWith(".py"))) await invoke("bandit", "bandit", ["-q", "-f", "json", "-r", root], true);
  else addSkipped("bandit", "No Python source files were found.");
  if (names.some(n => ["package-lock.json", "npm-shrinkwrap.json"].includes(n.split(/[\\/]/).at(-1) ?? ""))) {
    try {
      const out = await run("npm", ["audit", "--package-lock-only", "--json", "--userconfig", "/dev/null", "--registry", "https://registry.npmjs.org"], root, true);
      const rows = normalize("npm-audit", JSON.parse(out.stdout), repo, sha); findings.push(...rows); runs.push({ scanner: "npm-audit", version: await version("npm", ["--version"]), findings: rows.length, status: "complete" });
    } catch (error) {
      runs.push({ scanner: "npm-audit", version: await version("npm", ["--version"]).catch(() => "unknown"), findings: 0, status: "failed", reason: error instanceof Error ? error.message : "Scanner failed." });
    }
  } else addSkipped("npm-audit", "No npm lockfile was found.");
  const reqFiles = names.filter(n => /(^|[\\/])requirements[^/\\]*\.txt$/i.test(n));
  if (reqFiles.length) for (const req of reqFiles) await invoke("pip-audit", "pip-audit", ["--format", "json", "-r", resolve(root, req)], true);
  else addSkipped("pip-audit", "No supported requirements file was found.");
  const hasManifest = names.some(n => /(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|requirements[^/\\]*\.txt|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/.test(n));
  if (hasManifest) await invoke("osv", "osv-scanner", ["scan", "source", "-r", root, "--format", "json"]);
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
