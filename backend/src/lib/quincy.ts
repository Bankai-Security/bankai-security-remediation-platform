import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  scanner_version: z.string().nullable().optional(),
  rule_namespace: z.string().nullable().optional(),
  rule_id: z.string().nullable().optional(),
  rule_version: z.string().nullable().optional(),
  detected_at: z.string().optional(),
});

const QuincyFindingSchema = z.object({
  fingerprint: z.string().min(1),
  kind: z.enum(["location", "advisory"]),
  rule_id: z.string().min(1),
  rule_version: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["unknown", "info", "low", "medium", "high", "critical"]),
  cwe: z.array(z.string()),
  location: QuincyLocationSchema,
  message: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  confidence_as_reported: z.string().nullable().optional(),
  legacy_fingerprint: z.string().nullable().optional(),
  occurrence_id: z.string().nullable().optional(),
  provenance: z.array(QuincyProvenanceSchema),
  metadata: z.record(z.string(), z.unknown()),
  exploitability: z.enum(["not_exploitable", "theoretical", "likely", "confirmed"]).nullable(),
  reachable: z.boolean().nullable(),
  priority_score: z.number().min(0).max(100).nullable(),
});

const QuincyRevisionSchema = z.object({
  requested_commit: z.string().nullable(),
  resolved_commit: z.string().nullable(),
  snapshot_id: z.string().nullable(),
  binding: z.string(),
  workspace_state: z.string(),
});

const QuincyScannerSummarySchema = z.object({
  scanner: z.string().min(1),
  duration_seconds: z.number().nonnegative(),
  finding_count: z.number().int().nonnegative(),
  succeeded: z.boolean(),
  error: z.string().nullable(),
});

const QuincyCoverageEntrySchema = z.object({
  path: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
  module: z.string().nullable(),
  result_source: z.string().nullable(),
  subtree: z.boolean(),
});

const QuincyObservedFindingSchema = z.object({
  legacy_fingerprint: z.string().min(1),
  occurrence_id: z.string().nullable(),
  rule_namespace: z.string(),
  rule_id: z.string(),
  rule_version: z.string().nullable(),
  file_path: z.string(),
  line_start: z.number().int().positive(),
  line_end: z.number().int().positive(),
  severity: z.string(),
  confidence: z.string().nullable(),
  package: z.record(z.string(), z.unknown()).nullable(),
  advisory_ids: z.array(z.string()),
  provenance: z.array(z.record(z.string(), z.unknown())),
});

const QuincyObservationSchema = z.object({
  scanner: z.object({ name: z.string().min(1), version: z.string().nullable() }),
  schema_version: z.string().nullable(),
  scan_id: z.string().nullable(),
  request_id: z.string().nullable(),
  remediation_attempt_id: z.string().nullable(),
  repository_id: z.string().nullable(),
  revision: QuincyRevisionSchema,
  status: z.enum(["success", "partial", "cancelled", "failed"]),
  completeness: z.object({
    discovery: z.string(), analysis: z.string(), findings: z.string(), reasons: z.array(z.string()),
  }),
  coverage: z.object({
    scope: z.string(), available: z.boolean(), ledger_complete: z.boolean(), truncated: z.boolean(),
    missing_record_means: z.string(), entries: z.array(QuincyCoverageEntrySchema),
  }),
  termination: z.object({ reason: z.string(), phase: z.string().nullable() }),
  errors: z.array(z.object({
    code: z.string(), phase: z.string().nullable(), module: z.string().nullable(),
    file_path: z.string().nullable(), affects_completeness: z.boolean(),
  })),
  analysis: z.record(z.string(), z.unknown()),
  telemetry: z.record(z.string(), z.unknown()),
  findings: z.array(QuincyObservedFindingSchema),
});

const QuincyFindingComparisonSchema = z.object({
  baseline_scan_execution_id: z.string().min(1),
  candidate_scan_execution_id: z.string().min(1),
  repository_id: z.string().min(1),
  baseline_snapshot_id: z.string().min(1),
  candidate_snapshot_id: z.string().min(1),
  target_fingerprint: z.string().min(1),
  target_occurrence_id: z.string().nullable().optional(),
  target_rule_namespace: z.string().nullable().optional(),
  target_rule_id: z.string().nullable().optional(),
  target_file_path: z.string().nullable().optional(),
  outcome: z.enum(["still_detected", "not_detected", "inconclusive", "not_comparable"]),
  reason: z.string().min(1),
  compared_at: z.string().datetime({ offset: true }).optional(),
  correlation_method: z.string().nullable().optional(),
  candidate_occurrence_id: z.string().nullable().optional(),
  baseline_revision: QuincyRevisionSchema.optional(),
  candidate_revision: QuincyRevisionSchema.optional(),
  baseline_completeness: z.object({
    discovery: z.string(), analysis: z.string(), findings: z.string(), reasons: z.array(z.string()),
  }).optional(),
  candidate_completeness: z.object({
    discovery: z.string(), analysis: z.string(), findings: z.string(), reasons: z.array(z.string()),
  }).optional(),
  baseline_coverage: z.object({
    scope: z.string(), available: z.boolean(), ledger_complete: z.boolean(), truncated: z.boolean(),
    missing_record_means: z.string(), entries: z.array(QuincyCoverageEntrySchema),
  }).optional(),
  candidate_coverage: z.object({
    scope: z.string(), available: z.boolean(), ledger_complete: z.boolean(), truncated: z.boolean(),
    missing_record_means: z.string(), entries: z.array(QuincyCoverageEntrySchema),
  }).optional(),
  compatibility: z.object({
    scanner: z.string().min(1),
    baseline_scanner_version: z.string().nullable(),
    candidate_scanner_version: z.string().nullable(),
    configuration_digest: z.string().nullable(),
    analysis_policy_digest: z.string().nullable(),
    ruleset_digest: z.string().nullable(),
    advisory_digest: z.string().nullable(),
    advisory_state: z.string().nullable(),
    compatible: z.boolean(),
  }).optional(),
  integrity: z.object({
    baseline_evidence_digest: z.string().regex(/^sha256-[0-9a-f]{64}$/),
    candidate_observation_digest: z.string().regex(/^sha256-[0-9a-f]{64}$/),
    comparison_digest: z.string().regex(/^sha256-[0-9a-f]{64}$/),
  }).optional(),
  evidence_references: z.record(z.string(), z.unknown()).optional(),
});

const QuincyTriageEvidenceSchema = z.object({
  schema_version: z.literal("1.0"),
  scan_execution_id: z.string().min(1),
  repository_id: z.string().nullable(),
  revision: QuincyRevisionSchema,
  status: z.enum(["complete", "partial", "failed", "cancelled", "incomparable"]),
  scanner_summaries: z.array(QuincyScannerSummarySchema),
  observations: z.array(QuincyObservationSchema),
  evidence_digest: z.string().regex(/^sha256-[0-9a-f]{64}$/),
  comparisons: z.array(QuincyFindingComparisonSchema).optional(),
});

const QuincyTriageResponseSchema = z.object({
  findings: z.array(QuincyFindingSchema),
  scan_duration_seconds: z.number().nonnegative(),
  evidence: QuincyTriageEvidenceSchema.optional(),
  baseline_evidence: QuincyTriageEvidenceSchema.nullable().optional(),
  comparison_status: z.enum(["still_detected", "not_detected", "inconclusive", "not_comparable"]).nullable().optional(),
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
export type QuincyTriageEvidence = z.infer<typeof QuincyTriageEvidenceSchema>;
export type QuincyFindingComparison = z.infer<typeof QuincyFindingComparisonSchema>;
export type QuincyRepoRef =
  | { kind: "github_url"; value: string }
  | { kind: "local_path"; value: string };

export interface QuincyTriageResult {
  findings: NormalizedFinding[];
  rawFindingCount: number;
  scanDurationSeconds: number;
  evidence: QuincyTriageEvidence | null;
  baselineEvidence: QuincyTriageEvidence | null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function githubRepoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

async function quincyPost(path: string, body: unknown, timeoutMs: number, requestId?: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${trimTrailingSlash(env.QUINCY_API_URL!)}/${path.replace(/^\/+/, "")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(requestId ? { "x-request-id": requestId } : {}),
        ...(env.QUINCY_API_TOKEN ? { authorization: `Bearer ${env.QUINCY_API_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function quincyGet(path: string, timeoutMs: number, requestId?: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${trimTrailingSlash(env.QUINCY_API_URL!)}/${path.replace(/^\/+/, "")}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(requestId ? { "x-request-id": requestId } : {}),
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

function quincyFindingToNormalizedFinding(
  finding: QuincyFinding,
  repoRef: QuincyRepoRef,
  commitSha: string,
): NormalizedFinding {
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
    sourceUrl: repoRef.kind === "github_url"
      ? `${trimTrailingSlash(repoRef.value)}/blob/${commitSha}/${location.file}${anchor}`
      : null,
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
    scannerProvenance: finding.provenance,
    legacyFingerprint: finding.legacy_fingerprint ?? finding.fingerprint,
    occurrenceId: finding.occurrence_id ?? null,
    confidenceAsReported: finding.confidence_as_reported ?? null,
  };
}

export function quincyEvidenceSupportsVerification(result: QuincyTriageResult, requestedCommit: string): boolean {
  const evidence = result.evidence;
  return !!evidence
    && evidence.status === "complete"
    && evidence.revision.binding === "quincy_verified_checkout"
    && evidence.revision.resolved_commit?.toLowerCase() === requestedCommit.toLowerCase()
    && !!evidence.revision.snapshot_id
    && evidence.scanner_summaries.length > 0
    && evidence.scanner_summaries.every((summary) => summary.succeeded)
    && evidence.observations.length === evidence.scanner_summaries.length
    && evidence.observations.every((observation) =>
      observation.status === "success"
      && observation.termination.reason === "completed"
      && observation.errors.every((error) => !error.affects_completeness)
      && observation.completeness.discovery === "complete"
      && observation.completeness.analysis === "complete"
      && observation.completeness.findings === "complete"
      && observation.coverage.available
      && observation.coverage.ledger_complete
      && !observation.coverage.truncated,
    );
}

export function quincyEvidenceIsComparable(
  baseline: QuincyTriageResult,
  candidate: QuincyTriageResult,
  baselineCommit: string,
  candidateCommit: string,
): boolean {
  if (!quincyEvidenceSupportsVerification(baseline, baselineCommit)
      || !quincyEvidenceSupportsVerification(candidate, candidateCommit)) return false;
  const before = baseline.evidence!;
  const after = candidate.evidence!;
  if (!before.repository_id || before.repository_id !== after.repository_id) return false;
  if (!before.revision.snapshot_id || before.revision.snapshot_id === after.revision.snapshot_id) return false;
  const candidateByScanner = new Map(after.observations.map((observation) => [observation.scanner.name, observation]));
  if (candidateByScanner.size !== before.observations.length) return false;
  const requiredIdentityKeys = ["configuration_digest", "analysis_policy_digest", "ruleset_digest"];
  const advisoryIdentityKeys = ["advisory_digest", "advisory_state"];
  return before.observations.every((observation) => {
    const other = candidateByScanner.get(observation.scanner.name);
    return !!other
      && !!observation.scanner.version
      && observation.scanner.version === other.scanner.version
      && requiredIdentityKeys.every((key) => observation.analysis[key] != null
        && JSON.stringify(observation.analysis[key]) === JSON.stringify(other.analysis[key]))
      && advisoryIdentityKeys.every((key) => JSON.stringify(observation.analysis[key] ?? null)
        === JSON.stringify(other.analysis[key] ?? null));
  });
}

export interface QuincyTargetIdentity {
  legacyFingerprint?: string | null;
  occurrenceId?: string | null;
  externalId: string | null;
  filePath: string | null;
}

export interface QuincyTargetComparison {
  outcome: "still_detected" | "not_detected" | "inconclusive" | "not_comparable";
  reason: string;
}

function completeComparisonEvidence(
  comparison: QuincyFindingComparison,
  baseline: QuincyTriageEvidence,
  candidate: QuincyTriageEvidence,
  baselineCommit: string,
  candidateCommit: string,
  target: QuincyTargetIdentity,
): boolean {
  const baselineRevision = comparison.baseline_revision;
  const candidateRevision = comparison.candidate_revision;
  const baselineCompleteness = comparison.baseline_completeness;
  const candidateCompleteness = comparison.candidate_completeness;
  const baselineCoverage = comparison.baseline_coverage;
  const candidateCoverage = comparison.candidate_coverage;
  const compatibility = comparison.compatibility;
  const integrity = comparison.integrity;
  if (!baselineRevision || !candidateRevision || !baselineCompleteness || !candidateCompleteness
      || !baselineCoverage || !candidateCoverage || !compatibility || !integrity || !comparison.compared_at) return false;
  if (comparison.baseline_scan_execution_id !== baseline.scan_execution_id
      || comparison.candidate_scan_execution_id !== candidate.scan_execution_id
      || comparison.repository_id !== baseline.repository_id
      || comparison.repository_id !== candidate.repository_id
      || comparison.baseline_snapshot_id !== baseline.revision.snapshot_id
      || comparison.candidate_snapshot_id !== candidate.revision.snapshot_id
      || comparison.target_fingerprint !== target.legacyFingerprint
      || (target.occurrenceId && comparison.target_occurrence_id !== target.occurrenceId)) return false;
  if (baselineRevision.binding !== "quincy_verified_checkout"
      || candidateRevision.binding !== "quincy_verified_checkout"
      || baselineRevision.resolved_commit?.toLowerCase() !== baselineCommit.toLowerCase()
      || candidateRevision.resolved_commit?.toLowerCase() !== candidateCommit.toLowerCase()
      || baselineRevision.snapshot_id !== baseline.revision.snapshot_id
      || candidateRevision.snapshot_id !== candidate.revision.snapshot_id) return false;
  if (integrity.baseline_evidence_digest !== baseline.evidence_digest
      || comparison.evidence_references?.baseline !== integrity.baseline_evidence_digest
      || comparison.evidence_references?.candidate_observation !== integrity.candidate_observation_digest) return false;
  if (!compatibility.compatible
      || !compatibility.baseline_scanner_version
      || compatibility.baseline_scanner_version !== compatibility.candidate_scanner_version) return false;
  const completeness = [baselineCompleteness, candidateCompleteness];
  if (!completeness.every((item) => item.discovery === "complete" && item.analysis === "complete" && item.findings === "complete")) return false;
  if (!baselineCoverage.available || !baselineCoverage.ledger_complete || baselineCoverage.truncated
      || !candidateCoverage.available || !candidateCoverage.ledger_complete || candidateCoverage.truncated) return false;
  if (comparison.outcome === "not_detected" && comparison.reason !== "complete_scan_confirmed_deleted_target_file") {
    const path = comparison.target_file_path ?? target.filePath;
    const coverage = candidateCoverage.entries.filter((entry) => entry.path === path);
    if (!path || coverage.length !== 1 || coverage[0]!.state !== "analyzed" || coverage[0]!.result_source === "cache") return false;
  }
  return true;
}

export function explicitQuincyTargetComparison(
  baseline: QuincyTriageResult,
  candidate: QuincyTriageResult,
  target: QuincyTargetIdentity,
  baselineCommit: string,
  candidateCommit: string,
): QuincyTargetComparison {
  if (!quincyEvidenceIsComparable(baseline, candidate, baselineCommit, candidateCommit)) {
    return { outcome: "not_comparable", reason: "scan_evidence_incomplete_or_incompatible" };
  }
  const matches = (candidate.evidence?.comparisons ?? []).filter((comparison) =>
    comparison.target_fingerprint === target.legacyFingerprint
    && (!target.occurrenceId || comparison.target_occurrence_id === target.occurrenceId));
  if (matches.length !== 1) {
    return { outcome: matches.length > 1 ? "inconclusive" : "not_comparable", reason: "explicit_comparison_not_unique" };
  }
  const comparison = matches[0]!;
  if (!completeComparisonEvidence(comparison, baseline.evidence!, candidate.evidence!, baselineCommit, candidateCommit, target)) {
    return { outcome: "not_comparable", reason: "comparison_evidence_incomplete_or_mismatched" };
  }
  return { outcome: comparison.outcome, reason: comparison.reason };
}

export function compareQuincyTarget(
  baseline: QuincyTriageResult,
  candidate: QuincyTriageResult,
  target: QuincyTargetIdentity,
): QuincyTargetComparison {
  if (!target.legacyFingerprint && !target.occurrenceId) {
    return { outcome: "not_comparable", reason: "versioned_target_identity_unavailable" };
  }
  const identityMatch = (finding: NormalizedFinding) =>
    (!!target.occurrenceId && finding.occurrenceId === target.occurrenceId)
    || (!!target.legacyFingerprint && finding.legacyFingerprint === target.legacyFingerprint);
  const before = baseline.findings.filter(identityMatch);
  if (before.length !== 1) return { outcome: "not_comparable", reason: "target_not_uniquely_present_in_baseline" };
  const exact = candidate.findings.filter(identityMatch);
  if (exact.length > 1) return { outcome: "inconclusive", reason: "ambiguous_finding_identity" };
  if (exact.length === 1) return { outcome: "still_detected", reason: "preserved_finding_identity" };
  if (candidate.findings.some((finding) => finding.externalId === before[0]!.externalId)) {
    return { outcome: "inconclusive", reason: "same_rule_requires_scanner_correlation" };
  }
  const baselineObservation = baseline.evidence?.observations.find((observation) =>
    observation.findings.some((finding) =>
      finding.occurrence_id === target.occurrenceId || finding.legacy_fingerprint === target.legacyFingerprint),
  );
  const candidateObservation = candidate.evidence?.observations.find((observation) =>
    observation.scanner.name === baselineObservation?.scanner.name,
  );
  if (!baselineObservation || !candidateObservation || !target.filePath) {
    return { outcome: "inconclusive", reason: "target_scanner_or_path_unavailable" };
  }
  const coverage = candidateObservation.coverage.entries.filter((entry) => entry.path === target.filePath);
  if (coverage.length !== 1 || coverage[0]!.state !== "analyzed" || coverage[0]!.result_source === "cache") {
    return { outcome: "inconclusive", reason: "target_scope_not_proven_freshly_analyzed" };
  }
  return { outcome: "not_detected", reason: "complete_comparable_scan_analyzed_target_scope" };
}

export function quincyNegativeEvidenceFingerprints(result: QuincyTriageResult, requestedCommit: string): ReadonlySet<string> {
  if (!quincyEvidenceSupportsVerification(result, requestedCommit)) return new Set();
  const comparisons = result.evidence?.comparisons ?? [];
  return new Set(
    comparisons
      .filter((comparison) =>
        comparison.outcome === "not_detected"
        && comparison.candidate_scan_execution_id === result.evidence!.scan_execution_id
        && comparison.repository_id === result.evidence!.repository_id
        && comparison.candidate_snapshot_id === result.evidence!.revision.snapshot_id
        && comparison.baseline_snapshot_id !== comparison.candidate_snapshot_id
        && comparison.compatibility?.compatible === true
        && comparison.candidate_completeness?.discovery === "complete"
        && comparison.candidate_completeness?.analysis === "complete"
        && comparison.candidate_completeness?.findings === "complete"
        && comparison.integrity?.candidate_observation_digest === comparison.evidence_references?.candidate_observation,
      )
      .map((comparison) => `quincy:${comparison.target_fingerprint}`),
  );
}

export async function persistQuincyScanEvidence(
  supabase: SupabaseClient,
  input: { projectId: string; bankaiScanId?: string | null; result: QuincyTriageResult },
): Promise<string | null> {
  const evidence = input.result.evidence;
  if (!evidence) return null;
  const { data, error } = await supabase
    .from("quincy_scan_evidence")
    .upsert({
      project_id: input.projectId,
      bankai_scan_id: input.bankaiScanId ?? null,
      quincy_scan_execution_id: evidence.scan_execution_id,
      repository_id: evidence.repository_id,
      requested_revision: evidence.revision.requested_commit,
      resolved_revision: evidence.revision.resolved_commit,
      snapshot_id: evidence.revision.snapshot_id,
      status: evidence.status,
      scanner_summaries: evidence.scanner_summaries,
      observations: evidence.observations,
      comparisons: evidence.comparisons ?? [],
      evidence_digest: evidence.evidence_digest,
    }, { onConflict: "project_id,quincy_scan_execution_id" })
    .select("id")
    .single();
  if (error || !data?.id) {
    logger.error({ err: error, scanExecutionId: evidence.scan_execution_id }, "Could not persist Quincy scan evidence");
    return null;
  }
  return String(data.id);
}

export async function runQuincyTriageScan(input: {
  repo: string;
  ref: string;
  commitSha: string;
  repoRef?: QuincyRepoRef;
  scoreFindings?: boolean;
  githubToken?: string;
  comparison?: {
    baselineEvidence: QuincyTriageEvidence;
    target: QuincyTargetIdentity;
    renamedFiles?: Record<string, string>;
    deletedFiles?: string[];
  };
}): Promise<QuincyTriageResult | null> {
  if (!env.QUINCY_API_URL) return null;

  try {
    if (input.comparison && !input.comparison.target.legacyFingerprint) {
      throw new QuincyApiError("Quincy comparison requires a legacy finding fingerprint.");
    }
    const repoRef = input.repoRef ?? { kind: "github_url" as const, value: githubRepoUrl(input.repo) };
    const response = await quincyPost(
      "/triage/scan",
      {
        score_findings: input.scoreFindings ?? true,
        github_token: input.githubToken,
        repo_ref: { ...repoRef, ref: input.ref },
        ...(input.comparison ? {
          comparison: {
            baseline_evidence: input.comparison.baselineEvidence,
            target: {
              legacy_fingerprint: input.comparison.target.legacyFingerprint,
              occurrence_id: input.comparison.target.occurrenceId ?? null,
              rule_id: input.comparison.target.externalId,
              file_path: input.comparison.target.filePath,
            },
            renamed_files: input.comparison.renamedFiles ?? {},
            deleted_files: input.comparison.deletedFiles ?? [],
          },
        } : {}),
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
      findings: parsed.data.findings.map((finding) => quincyFindingToNormalizedFinding(finding, repoRef, input.commitSha)),
      rawFindingCount: parsed.data.findings.length,
      scanDurationSeconds: parsed.data.scan_duration_seconds,
      evidence: parsed.data.evidence ?? null,
      baselineEvidence: parsed.data.baseline_evidence ?? null,
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
  requestId?: string | undefined;
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
      external_request_id: input.requestId,
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
    const started = await quincyPost("/workflows/remediations", body, quincyRemediationPollTimeoutMs(), input.requestId);
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
      statusResponse = await quincyGet(`/remediations/${encodeURIComponent(jobId)}/bankai`, 15_000, input.requestId);
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
