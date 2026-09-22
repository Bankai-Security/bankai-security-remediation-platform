import { z } from "zod";
import { env } from "../env.js";
import type { NormalizedFinding } from "./csv-ingest.js";
import { logger } from "./logger.js";
import { normalizeSeverity } from "./csv-ingest.js";

export class QuincyApiError extends Error {}

const MAX_QUINCY_REMEDIATION_POLL_MS = 30 * 60_000;

const QuincyLocationSchema = z.object({
  file: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
});

const QuincyProvenanceSchema = z.object({
  scanner: z.string().min(1),
  raw_scanner_id: z.string().min(1),
  severity_as_reported: z.string().min(1),
  message: z.string().min(1),
});

const QuincyFindingSchema = z.object({
  fingerprint: z.string().min(1),
  kind: z.enum(["location", "advisory"]),
  rule_id: z.string().min(1),
  rule_version: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  cwe: z.array(z.string()),
  location: QuincyLocationSchema,
  message: z.string().min(1),
  confidence: z.number().min(0).max(1),
  provenance: z.array(QuincyProvenanceSchema),
  metadata: z.record(z.string(), z.unknown()),
  exploitability: z.enum(["not_exploitable", "theoretical", "likely", "confirmed"]).nullable(),
  reachable: z.boolean().nullable(),
  priority_score: z.number().min(0).max(100).nullable(),
});

const QuincyTriageResponseSchema = z.object({
  findings: z.array(QuincyFindingSchema),
  scan_duration_seconds: z.number().nonnegative(),
});

const QuincyStartWorkflowResponseSchema = z.object({
  workflow_id: z.string().min(1),
  job_id: z.string().min(1),
  status_url: z.string().min(1),
  idempotent_replay: z.boolean().optional(),
});

const QuincyBankaiStatusSchema = z.object({
  job_id: z.string().min(1),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  final_status: z.enum(["succeeded", "failed"]).nullable().optional(),
  error: z.string().nullable().optional(),
  abort_reason: z.string().nullable().optional(),
  failure_guidance: z.string().nullable().optional(),
  guidance: z.string().nullable().optional(),
  attempts: z.number().int().nonnegative().optional(),
  progress_summary: z.string().nullable().optional(),
  active_attempt: z.number().int().nonnegative().optional(),
  updated_at: z.string().nullable().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  pr_url: z.string().nullable().optional(),
  patch: z
    .object({
      summary: z.string(),
      files_changed: z.number().int().nonnegative(),
      lines_added: z.number().int().nonnegative(),
      lines_removed: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});

export type QuincyFinding = z.infer<typeof QuincyFindingSchema>;

export interface QuincyTriageResult {
  findings: NormalizedFinding[];
  rawFindingCount: number;
  scanDurationSeconds: number;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function githubRepoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

async function quincyPost(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${trimTrailingSlash(env.QUINCY_API_URL!)}/${path.replace(/^\/+/, "")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.QUINCY_API_TOKEN ? { authorization: `Bearer ${env.QUINCY_API_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function quincyGet(path: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${trimTrailingSlash(env.QUINCY_API_URL!)}/${path.replace(/^\/+/, "")}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(env.QUINCY_API_TOKEN ? { authorization: `Bearer ${env.QUINCY_API_TOKEN}` } : {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function metadataString(finding: QuincyFinding, key: string): string | null {
  const value = finding.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function quincyFindingToNormalizedFinding(finding: QuincyFinding, repo: string, commitSha: string): NormalizedFinding {
  const location = finding.location;
  const anchor = `#L${location.start_line}${location.end_line !== location.start_line ? `-L${location.end_line}` : ""}`;
  const scannerNames = finding.provenance.map((p) => p.scanner).filter(Boolean);
  const provenance = scannerNames.length > 0 ? `Detected by ${Array.from(new Set(scannerNames)).join(", ")}.` : null;
  const priority =
    finding.priority_score != null
      ? `Quincy priority score: ${finding.priority_score.toFixed(1)}${finding.reachable != null ? `; reachable: ${finding.reachable ? "yes" : "no"}` : ""}${
          finding.exploitability ? `; exploitability: ${finding.exploitability}` : ""
        }.`
      : null;
  const details = [finding.message, priority, provenance].filter((part): part is string => Boolean(part));

  const packageIdentity = metadataString(finding, "purl") ?? metadataString(finding, "package_purl") ?? metadataString(finding, "package_name");
  return {
    fingerprint: `quincy:${finding.fingerprint}`,
    externalId: finding.rule_id,
    title: finding.title,
    severity: normalizeSeverity(finding.severity, null),
    cvssScore: null,
    cwe: finding.cwe.length > 0 ? finding.cwe.join(", ") : null,
    component: packageIdentity,
    filePath: location.file,
    findingType: `Quincy ${finding.kind}`,
    sourceStatus: null,
    dateFound: null,
    description: details.join("\n\n") || null,
    fixAvailable: null,
    sourceUrl: `${githubRepoUrl(repo)}/blob/${commitSha}/${location.file}${anchor}`,
    service: null,
    environment: null,
    cves: finding.kind === "advisory" ? finding.rule_id : metadataString(finding, "advisory_id"),
    affectedPackages: packageIdentity,
    currentVersions: metadataString(finding, "installed_version") ?? metadataString(finding, "package_version"),
    fixedVersions: metadataString(finding, "fixed_version"),
    recommendations: priority,
    remediationGuidance: null,
    lineStart: location.start_line,
    lineEnd: location.end_line,
    commitSha,
    source: "github_ai",
  };
}

export async function runQuincyTriageScan(input: {
  repo: string;
  ref: string;
  commitSha: string;
  scoreFindings?: boolean;
  githubToken?: string;
}): Promise<QuincyTriageResult | null> {
  if (!env.QUINCY_API_URL) return null;

  try {
    const response = await quincyPost(
      "/triage/scan",
      {
        score_findings: input.scoreFindings ?? true,
        github_token: input.githubToken,
        repo_ref: {
          kind: "github_url",
          value: githubRepoUrl(input.repo),
          ref: input.ref,
        },
      },
      env.QUINCY_SCAN_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new QuincyApiError(`Quincy triage scan failed with ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`);
    }

    const parsed = QuincyTriageResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new QuincyApiError("Quincy triage scan returned an unexpected response shape.");
    }

    return {
      findings: parsed.data.findings.map((finding) => quincyFindingToNormalizedFinding(finding, input.repo, input.commitSha)),
      rawFindingCount: parsed.data.findings.length,
      scanDurationSeconds: parsed.data.scan_duration_seconds,
    };
  } catch (err) {
    logger.warn({ err, repo: input.repo, ref: input.ref }, "Quincy triage scan unavailable; falling back to configured AI repo scan");
    return null;
  }
}

export interface QuincyWorkflowResult {
  jobId: string;
  status: "succeeded" | "failed" | "running";
  prUrl: string | null;
  summary: string | null;
  failureGuidance: string | null;
  attempts: number;
  error: string | null;
}

export interface QuincyFallbackDescription {
  logLevel: "info" | "warn";
  logMessage: string;
  note: string;
  kind: "no_match" | "validation_failed";
}

function compactResultParts(result: QuincyWorkflowResult): string[] {
  return [result.error, result.failureGuidance, result.summary, `attempts=${result.attempts}`].filter((part): part is string => Boolean(part));
}

export function describeQuincyFallback(result: QuincyWorkflowResult): QuincyFallbackDescription {
  const detail = compactResultParts(result).join(" | ");
  const combinedText = [result.error, result.failureGuidance, result.summary].filter(Boolean).join(" ");
  const noFindingMatch = result.attempts === 0 && /no finding for rule/i.test(combinedText);

  if (noFindingMatch) {
    return {
      logLevel: "info",
      logMessage: "Quincy could not match finding; continuing to Bankai fallback remediation",
      note: `Quincy could not match this rule in its latest scan${detail ? `: ${detail}` : "."} Bankai fallback used the ticket's stored finding context.`,
      kind: "no_match",
    };
  }

  return {
    logLevel: "warn",
    logMessage: "Quincy workflow failed validation; continuing to Bankai fallback remediation",
    note: detail,
    kind: "validation_failed",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function quincyRemediationPollTimeoutMs(): number {
  return Math.min(env.QUINCY_REMEDIATION_TIMEOUT_MS, MAX_QUINCY_REMEDIATION_POLL_MS);
}

export function parseGithubPrNumber(url: string | null, expectedRepo?: string): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.port) return null;
    const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/);
    if (!match || (expectedRepo && match[1]!.toLowerCase() !== expectedRepo.toLowerCase())) return null;
    const number = Number(match[2]);
    return Number.isSafeInteger(number) ? number : null;
  } catch {
    return null;
  }
}

export async function runQuincyRemediationWorkflow(input: {
  repo: string;
  ref: string;
  ruleId: string;
  ticketId: string;
  projectId: string;
  severity: "low" | "medium" | "high" | "critical" | null;
  githubToken: string;
  baseBranch: string;
  idempotencyKey?: string;
  jobId?: string | undefined;
  onStarted?: (jobId: string) => Promise<void>;
  onProgress?: (progress: { summary: string; activeAttempt: number; completedAttempts: number; updatedAt: string | null }) => Promise<void>;
  pollTimeoutMs?: number;
  finding?: {
    title: string;
    filePath: string;
    lineStart: number | null;
    lineEnd: number | null;
    cwe: string | null;
    affectedPackages: string | null;
    currentVersions: string | null;
    fixedVersions: string | null;
    description: string | null;
    remediationGuidance: string | null;
  };
}): Promise<QuincyWorkflowResult | null> {
  if (!env.QUINCY_API_URL) {
    logger.error(
      { ticketId: input.ticketId, projectId: input.projectId, ruleId: input.ruleId },
      "Quincy remediation skipped: QUINCY_API_URL is not set on this process",
    );
    return null;
  }

  // A synthetic AI/CSV rule cannot be proven removed by a scanner that never
  // reported it. Require executable proof and tests for these handoffs.
  const requiresExecutableProof = input.ruleId.startsWith("bankai:");
  const body = {
    repo_ref: {
      kind: "github_url",
      value: githubRepoUrl(input.repo),
      ref: input.ref,
    },
    target: {
      kind: "rule_id",
      value: input.ruleId,
    },
    mode: "fix_and_pr",
    execution_options: {
      require_pov: requiresExecutableProof,
      require_red_team: true,
      require_attestation: false,
      // A scanner disappearing is necessary, but it is not sufficient proof
      // that the remediation works.  Scanner-backed findings need the same
      // repository-test/CI-parity gate as imported findings; otherwise Quincy
      // can publish a PR that removes the signature while breaking the app.
      require_ci_parity: true,
      artifact_detail: "full",
      validation_policy: requiresExecutableProof ? "full_proof" : "target_scanner_clean",
      accept_when_target_finding_removed: !requiresExecutableProof,
      ignore_test_command_failures: false,
    },
    bankai_context: {
      external_request_id: input.ticketId,
      tenant_id: input.projectId,
      requested_by: "bankai-worker",
      source: "api",
      priority: input.severity,
      labels: ["bankai", "quincy-primary"],
      idempotency_key: input.idempotencyKey ?? `ticket:${input.ticketId}:quincy-remediation`,
      finding: input.finding
        ? {
            title: input.finding.title,
            file_path: input.finding.filePath,
            line_start: input.finding.lineStart,
            line_end: input.finding.lineEnd,
            cwe: input.finding.cwe,
            affected_packages: input.finding.affectedPackages,
            current_versions: input.finding.currentVersions,
            fixed_versions: input.finding.fixedVersions,
            description: input.finding.description,
            remediation_guidance: input.finding.remediationGuidance,
          }
        : undefined,
    },
    github: {
      token: input.githubToken,
      base_branch: input.baseBranch,
      head_branch_prefix: "remediation/quincy",
      draft: false,
      auto_merge_requested: false,
    },
  };

  let workflowId: string | undefined;
  let jobId = input.jobId;
  logger.info(
    { ticketId: input.ticketId, projectId: input.projectId, ruleId: input.ruleId, repo: input.repo },
    "POSTing Quincy remediation workflow",
  );
  if (!jobId) try {
    const started = await quincyPost("/workflows/remediations", body, quincyRemediationPollTimeoutMs());
    if (started.status === 404 || started.status === 405 || started.status === 422) {
      const detail = await started.text().catch(() => "");
      logger.warn({ status: started.status, detail: detail.slice(0, 500), ruleId: input.ruleId }, "Quincy workflow endpoint cannot execute this remediation");
      return null;
    }
    if (!started.ok) {
      const detail = await started.text().catch(() => "");
      throw new QuincyApiError(`Quincy workflow start failed with ${started.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
    }
    const parsedStart = QuincyStartWorkflowResponseSchema.safeParse(await started.json());
    if (!parsedStart.success) throw new QuincyApiError("Quincy workflow start returned an unexpected response shape.");
    workflowId = parsedStart.data.workflow_id;
    jobId = parsedStart.data.job_id;
  } catch (err) {
    logger.warn({ err, repo: input.repo, ruleId: input.ruleId }, "Quincy remediation workflow unavailable; falling back to local fix engine");
    return null;
  }

  await input.onStarted?.(jobId);
  const pending = (error: string | null = null): QuincyWorkflowResult => ({ jobId, status: "running", prUrl: null, summary: null, failureGuidance: null, attempts: 0, error });
  const deadline = Date.now() + Math.min(input.pollTimeoutMs ?? quincyRemediationPollTimeoutMs(), quincyRemediationPollTimeoutMs());
  let lastStatus: z.infer<typeof QuincyBankaiStatusSchema> | null = null;
  while (Date.now() < deadline) {
    let statusResponse: Response;
    try {
      statusResponse = await quincyGet(`/remediations/${encodeURIComponent(jobId)}/bankai`, 15_000);
    } catch (err) {
      return pending(err instanceof Error ? err.message : "Quincy status temporarily unavailable");
    }
    if (!statusResponse.ok) {
      const detail = await statusResponse.text().catch(() => "");
      const error = `Quincy workflow status failed with ${statusResponse.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`;
      if (statusResponse.status === 404) return { ...pending(error), status: "failed" };
      return pending(error);
    }
    const parsedStatus = QuincyBankaiStatusSchema.safeParse(await statusResponse.json());
    if (!parsedStatus.success) throw new QuincyApiError("Quincy workflow status returned an unexpected response shape.");
    lastStatus = parsedStatus.data;
    if (lastStatus.progress_summary) await input.onProgress?.({
      summary: lastStatus.progress_summary,
      activeAttempt: lastStatus.active_attempt ?? 0,
      completedAttempts: lastStatus.attempts ?? 0,
      updatedAt: lastStatus.updated_at ?? null,
    });

    if (lastStatus.status === "succeeded" || lastStatus.status === "failed") {
      return {
        jobId,
        status: lastStatus.status,
        prUrl: lastStatus.pr_url ?? null,
        summary: lastStatus.patch?.summary ?? null,
        failureGuidance: lastStatus.failure_guidance ?? lastStatus.guidance ?? null,
        attempts: lastStatus.attempts ?? 0,
        error: lastStatus.error ?? lastStatus.abort_reason ?? null,
      };
    }

    await sleep(3000);
  }

  logger.warn({ repo: input.repo, ruleId: input.ruleId, workflowId, jobId, lastStatus }, "Timed out waiting for Quincy remediation workflow");
  return {
    jobId,
    status: "running",
    prUrl: lastStatus?.pr_url ?? null,
    summary: lastStatus?.patch?.summary ?? null,
    failureGuidance: lastStatus?.failure_guidance ?? lastStatus?.guidance ?? null,
    attempts: lastStatus?.attempts ?? 0,
    error: null,
  };
}
