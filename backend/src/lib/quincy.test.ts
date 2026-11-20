import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../env.js";
import type { QuincyTriageEvidence } from "./quincy.js";
import { compareQuincyTarget, describeQuincyFallback, explicitQuincyTargetComparison, parseGithubPrNumber, persistQuincyScanEvidence, quincyEvidenceIsComparable, quincyEvidenceSupportsVerification, quincyNegativeEvidenceFingerprints, quincyRemediationPollTimeoutMs, runQuincyRemediationWorkflow, runQuincyTriageScan, runQuincyVerification } from "./quincy.js";

const COMMIT = "a".repeat(40);
const ORIGINAL_QUINCY_TOKEN = env.QUINCY_API_TOKEN;

function triagePayload(status: "complete" | "partial" | "failed" | "cancelled" | "incomparable" = "complete", comparisons?: unknown[]) {
  const complete = status === "complete";
  return {
    findings: [{
      fingerprint: "legacy-1", legacy_fingerprint: "legacy-1", occurrence_id: "occurrence-1",
      kind: "location", rule_id: "SCHRIFT-1", rule_version: "1", title: "Informational finding",
      severity: "info", cwe: [], location: { file: "src/app.ts", start_line: 3, end_line: 3 },
      message: "review", confidence: null, confidence_as_reported: "context-required",
      provenance: [{ scanner: "schrift-native", raw_scanner_id: "schrift-native:SCHRIFT-1", severity_as_reported: "INFO", message: "review" }],
      metadata: {}, exploitability: null, reachable: null, priority_score: null,
    }],
    scan_duration_seconds: 0.2,
    evidence: {
      schema_version: "1.0", scan_execution_id: "scan-1", repository_id: "repo-1",
      revision: { requested_commit: COMMIT, resolved_commit: COMMIT, snapshot_id: `sha256-${"b".repeat(64)}`, binding: "quincy_verified_checkout", workspace_state: "prepared_snapshot" },
      status,
      scanner_summaries: [{ scanner: "schrift", duration_seconds: 0.1, finding_count: 1, succeeded: complete, error: complete ? null : "partial evidence" }],
      observations: [{
        scanner: { name: "schrift", version: "0.1.0" }, schema_version: "1.1", scan_id: "schrift-scan",
        request_id: "scan-1", remediation_attempt_id: null, repository_id: "repo-1",
        revision: { requested_commit: COMMIT, resolved_commit: COMMIT, snapshot_id: `sha256-${"b".repeat(64)}`, binding: "caller_asserted", workspace_state: "prepared_snapshot" },
        status: status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : complete ? "success" : "partial",
        completeness: { discovery: complete ? "complete" : "incomplete", analysis: complete ? "complete" : "incomplete", findings: "complete", reasons: [] },
        coverage: { scope: "declared_native_scope", available: complete, ledger_complete: complete, truncated: false, missing_record_means: "unknown", entries: [{ path: "src/app.ts", state: "analyzed", reason: null, module: "schrift-native", result_source: "fresh", subtree: false }] },
        termination: { reason: complete ? "completed" : "deadline_exceeded", phase: null }, errors: [],
        analysis: { configuration_digest: "config", analysis_policy_digest: "policy", ruleset_digest: "rules", advisory_digest: "advisory", advisory_state: "enabled" }, telemetry: {},
        findings: [{ legacy_fingerprint: "legacy-1", occurrence_id: "occurrence-1", rule_namespace: "schrift-native", rule_id: "SCHRIFT-1", rule_version: "1", file_path: "src/app.ts", line_start: 3, line_end: 3, severity: "INFO", confidence: "context-required", package: null, advisory_ids: [], provenance: [] }],
      }],
      evidence_digest: `sha256-${"c".repeat(64)}`,
      ...(comparisons ? { comparisons } : {}),
    },
  };
}

function completeComparison() {
  const coverage = { scope: "declared_native_scope", available: true, ledger_complete: true, truncated: false, missing_record_means: "unknown", entries: [{ path: "src/app.ts", state: "analyzed", reason: null, module: "schrift-native", result_source: "fresh", subtree: false }] };
  const completeness = { discovery: "complete", analysis: "complete", findings: "complete", reasons: [] as string[] };
  return {
    baseline_scan_execution_id: "scan-0", candidate_scan_execution_id: "scan-1", repository_id: "repo-1",
    baseline_snapshot_id: `sha256-${"d".repeat(64)}`, candidate_snapshot_id: `sha256-${"b".repeat(64)}`,
    target_fingerprint: "legacy-1", target_occurrence_id: "occurrence-1", target_file_path: "src/app.ts",
    outcome: "not_detected", reason: "complete_comparable_scan_analyzed_target_scope", compared_at: "2026-11-11T00:00:00Z",
    baseline_revision: { requested_commit: COMMIT, resolved_commit: COMMIT, snapshot_id: `sha256-${"d".repeat(64)}`, binding: "quincy_verified_checkout", workspace_state: "prepared_snapshot" },
    candidate_revision: { requested_commit: COMMIT, resolved_commit: COMMIT, snapshot_id: `sha256-${"b".repeat(64)}`, binding: "quincy_verified_checkout", workspace_state: "prepared_snapshot" },
    baseline_completeness: completeness, candidate_completeness: completeness,
    baseline_coverage: coverage, candidate_coverage: coverage,
    compatibility: { scanner: "schrift", baseline_scanner_version: "0.1.0", candidate_scanner_version: "0.1.0", configuration_digest: "config", analysis_policy_digest: "policy", ruleset_digest: "rules", advisory_digest: "advisory", advisory_state: "enabled", compatible: true },
    integrity: { baseline_evidence_digest: `sha256-${"c".repeat(64)}`, candidate_observation_digest: `sha256-${"e".repeat(64)}`, comparison_digest: `sha256-${"f".repeat(64)}` },
    evidence_references: { baseline: `sha256-${"c".repeat(64)}`, candidate_observation: `sha256-${"e".repeat(64)}` },
  };
}

describe("Quincy triage evidence", () => {
  const originalQuincyUrl = env.QUINCY_API_URL;

  beforeEach(() => { env.QUINCY_API_URL = "http://quincy.local"; });
  afterEach(() => { env.QUINCY_API_URL = originalQuincyUrl; env.QUINCY_API_TOKEN = ORIGINAL_QUINCY_TOKEN; vi.restoreAllMocks(); });

  it("accepts informational findings and retains Schrift identity and evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(triagePayload()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT });

    expect(result?.findings[0]).toMatchObject({ severity: "Low", legacyFingerprint: "legacy-1", occurrenceId: "occurrence-1", confidenceAsReported: "context-required" });
    expect(result?.evidence?.status).toBe("complete");
    expect(quincyEvidenceSupportsVerification(result!, COMMIT)).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).repo_ref.ref).toBe(COMMIT);
  });

  it("submits an explicitly requested immutable local checkout without exposing a file URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(triagePayload()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runQuincyTriageScan({
      repo: "controlled/synthetic",
      ref: COMMIT,
      commitSha: COMMIT,
      repoRef: { kind: "local_path", value: "/fixtures/synthetic" },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.repo_ref).toEqual({ kind: "local_path", value: "/fixtures/synthetic", ref: COMMIT });
    expect(result?.findings[0]?.sourceUrl).toBeNull();
  });

  it("submits the integrity-bound baseline and target for candidate comparison", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(triagePayload()));
    vi.stubGlobal("fetch", fetchMock);
    const baselineEvidence = triagePayload().evidence as QuincyTriageEvidence;
    await runQuincyTriageScan({
      repo: "acme/app",
      ref: COMMIT,
      commitSha: COMMIT,
      comparison: {
        baselineEvidence,
        target: { legacyFingerprint: "legacy-1", occurrenceId: "occurrence-1", externalId: "SCHRIFT-1", filePath: "src/app.ts" },
      },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.comparison.baseline_evidence.evidence_digest).toBe(baselineEvidence.evidence_digest);
    expect(body.comparison.target).toMatchObject({ legacy_fingerprint: "legacy-1", occurrence_id: "occurrence-1", rule_id: "SCHRIFT-1", file_path: "src/app.ts" });
  });

  it("never turns partial or comparison-free evidence into negative proof", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(triagePayload("partial"))));
    const result = await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT });
    expect(result?.evidence?.status).toBe("partial");
    expect(quincyEvidenceSupportsVerification(result!, COMMIT)).toBe(false);
    expect([...quincyNegativeEvidenceFingerprints(result!, COMMIT)]).toEqual([]);
  });

  it.each(["partial", "failed", "cancelled", "incomparable"] as const)("rejects %s evidence for verification", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(triagePayload(status))));
    const result = await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT });
    expect(quincyEvidenceSupportsVerification(result!, COMMIT)).toBe(false);
    expect([...quincyNegativeEvidenceFingerprints(result!, COMMIT)]).toEqual([]);
  });

  it("authorizes only an explicit not_detected comparison from complete evidence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(triagePayload("complete", [{
      baseline_scan_execution_id: "scan-0", candidate_scan_execution_id: "scan-1", repository_id: "repo-1",
      baseline_snapshot_id: `sha256-${"d".repeat(64)}`, candidate_snapshot_id: `sha256-${"b".repeat(64)}`,
      target_fingerprint: "legacy-1", target_occurrence_id: "occurrence-1", target_file_path: "src/app.ts",
      outcome: "not_detected", reason: "complete_comparable_scan_analyzed_target_scope", compared_at: "2026-11-11T00:00:00Z",
      baseline_revision: { requested_commit: COMMIT, resolved_commit: COMMIT, snapshot_id: `sha256-${"d".repeat(64)}`, binding: "quincy_verified_checkout", workspace_state: "prepared_snapshot" },
      candidate_revision: { requested_commit: COMMIT, resolved_commit: COMMIT, snapshot_id: `sha256-${"b".repeat(64)}`, binding: "quincy_verified_checkout", workspace_state: "prepared_snapshot" },
      baseline_completeness: { discovery: "complete", analysis: "complete", findings: "complete", reasons: [] },
      candidate_completeness: { discovery: "complete", analysis: "complete", findings: "complete", reasons: [] },
      baseline_coverage: { scope: "declared_native_scope", available: true, ledger_complete: true, truncated: false, missing_record_means: "unknown", entries: [{ path: "src/app.ts", state: "analyzed", reason: null, module: "schrift-native", result_source: "fresh", subtree: false }] },
      candidate_coverage: { scope: "declared_native_scope", available: true, ledger_complete: true, truncated: false, missing_record_means: "unknown", entries: [{ path: "src/app.ts", state: "analyzed", reason: null, module: "schrift-native", result_source: "fresh", subtree: false }] },
      compatibility: { scanner: "schrift", baseline_scanner_version: "0.1.0", candidate_scanner_version: "0.1.0", configuration_digest: "config", analysis_policy_digest: "policy", ruleset_digest: "rules", advisory_digest: "advisory", advisory_state: "enabled", compatible: true },
      integrity: { baseline_evidence_digest: `sha256-${"c".repeat(64)}`, candidate_observation_digest: `sha256-${"e".repeat(64)}`, comparison_digest: `sha256-${"f".repeat(64)}` },
      evidence_references: { baseline: `sha256-${"c".repeat(64)}`, candidate_observation: `sha256-${"e".repeat(64)}` },
    }]))));
    const result = await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT });
    expect([...quincyNegativeEvidenceFingerprints(result!, COMMIT)]).toEqual(["quincy:legacy-1"]);
  });

  it("rejects unverified snapshots and schema-incompatible fallback input", async () => {
    const original = triagePayload();
    const firstObservation = original.evidence.observations[0]!;
    const unverified = {
      ...original,
      evidence: {
        ...original.evidence,
        revision: { ...original.evidence.revision, snapshot_id: null },
        observations: [{ ...firstObservation, revision: { ...firstObservation.revision, snapshot_id: null } }],
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(unverified)).mockResolvedValueOnce(Response.json({ findings: [{ severity: "bogus" }], scan_duration_seconds: 0 })));
    const first = await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT });
    const rejected = await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT });
    expect(quincyEvidenceSupportsVerification(first!, COMMIT)).toBe(false);
    expect(rejected).toBeNull();
  });

  it("consumes only Quincy's explicit integrity-bound comparison", async () => {
    const baselinePayload = triagePayload();
    baselinePayload.evidence.scan_execution_id = "scan-0";
    baselinePayload.evidence.revision.snapshot_id = `sha256-${"d".repeat(64)}`;
    baselinePayload.evidence.observations[0]!.revision.snapshot_id = `sha256-${"d".repeat(64)}`;
    const candidatePayload = triagePayload("complete", [completeComparison()]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(baselinePayload)).mockResolvedValueOnce(Response.json(candidatePayload)));
    const baseline = (await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT }))!;
    const candidate = (await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT }))!;
    const target = { legacyFingerprint: "legacy-1", occurrenceId: "occurrence-1", externalId: "SCHRIFT-1", filePath: "src/app.ts" };
    expect(explicitQuincyTargetComparison(baseline, candidate, target, COMMIT, COMMIT)).toEqual({
      outcome: "not_detected",
      reason: "complete_comparable_scan_analyzed_target_scope",
    });
    const comparison = candidate.evidence?.comparisons?.[0];
    if (!comparison?.integrity) throw new Error("comparison fixture missing integrity evidence");
    comparison.integrity.baseline_evidence_digest = `sha256-${"0".repeat(64)}`;
    expect(explicitQuincyTargetComparison(baseline, candidate, target, COMMIT, COMMIT).outcome).toBe("not_comparable");
  });

  it("persists explicit comparisons once with the evidence envelope and fails closed on write errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(triagePayload("complete", [completeComparison()]))));
    const result = (await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT }))!;
    const single = vi.fn().mockResolvedValue({ data: { id: "evidence-1" }, error: null });
    const select = vi.fn(() => ({ single }));
    const upsert = vi.fn((_row: unknown, _options?: unknown) => ({ select }));
    const from = vi.fn(() => ({ upsert }));
    const supabase = { from } as unknown as Parameters<typeof persistQuincyScanEvidence>[0];
    await expect(persistQuincyScanEvidence(supabase, { projectId: "project-1", result })).resolves.toBe("evidence-1");
    expect(upsert.mock.calls[0]![0]).toMatchObject({
      project_id: "project-1",
      quincy_scan_execution_id: "scan-1",
      comparisons: [expect.objectContaining({ outcome: "not_detected", target_fingerprint: "legacy-1" })],
    });

    single.mockResolvedValueOnce({ data: null, error: new Error("database unavailable") });
    await expect(persistQuincyScanEvidence(supabase, { projectId: "project-1", result })).resolves.toBeNull();
  });

  it("rejects repository and ruleset identity changes as incomparable", async () => {
    const original = triagePayload();
    const originalObservation = original.evidence.observations[0]!;
    const repositoryChanged = { ...original, evidence: { ...original.evidence, repository_id: "repo-2", observations: [{ ...originalObservation, repository_id: "repo-2" }] } };
    const rulesChanged = { ...original, evidence: { ...original.evidence, observations: [{ ...originalObservation, analysis: { ...originalObservation.analysis, ruleset_digest: "different-rules" } }] } };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json(triagePayload()))
      .mockResolvedValueOnce(Response.json(repositoryChanged))
      .mockResolvedValueOnce(Response.json(rulesChanged)));
    const baseline = (await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT }))!;
    const wrongRepo = (await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT }))!;
    const wrongRules = (await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT }))!;
    expect(quincyEvidenceIsComparable(baseline, wrongRepo, COMMIT, COMMIT)).toBe(false);
    expect(quincyEvidenceIsComparable(baseline, wrongRules, COMMIT, COMMIT)).toBe(false);
  });

  it("requires unique target identity and fresh target-path coverage for negative comparison", async () => {
    const basePayload = triagePayload();
    const observation = basePayload.evidence.observations[0]!;
    const missingPayload = { ...basePayload, findings: [], evidence: { ...basePayload.evidence, observations: [{ ...observation, findings: [] }] } };
    const duplicatePayload = { ...basePayload, findings: [basePayload.findings[0]!, { ...basePayload.findings[0]!, occurrence_id: "occurrence-2" }] };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json(basePayload))
      .mockResolvedValueOnce(Response.json(missingPayload))
      .mockResolvedValueOnce(Response.json(duplicatePayload)));
    const baseline = (await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT }))!;
    const missing = (await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT }))!;
    const duplicate = (await runQuincyTriageScan({ repo: "acme/app", ref: COMMIT, commitSha: COMMIT }))!;
    const target = { legacyFingerprint: "legacy-1", occurrenceId: null, externalId: "SCHRIFT-1", filePath: "src/app.ts" };
    expect(compareQuincyTarget(baseline, missing, target)).toEqual({ outcome: "not_detected", reason: "complete_comparable_scan_analyzed_target_scope" });
    expect(compareQuincyTarget(baseline, duplicate, target).outcome).toBe("inconclusive");
  });
});

describe("Quincy PR identity", () => {
  it("accepts only a GitHub PR in the configured repository", () => {
    expect(parseGithubPrNumber("https://github.com/acme/app/pull/12", "acme/app")).toBe(12);
    for (const url of ["https://example.com/acme/app/pull/12", "https://github.com/other/app/pull/12", "https://github.com/acme/app/pull/0", "not-a-url"]) {
      expect(parseGithubPrNumber(url, "acme/app")).toBeNull();
    }
  });
});

describe("runQuincyRemediationWorkflow", () => {
  const originalQuincyUrl = env.QUINCY_API_URL;
  const originalTimeout = env.QUINCY_REMEDIATION_TIMEOUT_MS;

  beforeEach(() => {
    env.QUINCY_API_URL = "http://quincy.local";
    env.QUINCY_REMEDIATION_TIMEOUT_MS = 5_000;
  });

  afterEach(() => {
    env.QUINCY_API_URL = originalQuincyUrl;
    env.QUINCY_REMEDIATION_TIMEOUT_MS = originalTimeout;
    vi.restoreAllMocks();
  });

  it("reconciles a late result without starting a second workflow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ job_id: "late-job", status: "succeeded", attempts: 3, pr_url: "https://github.com/acme/app/pull/31" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runQuincyRemediationWorkflow({ repo: "acme/app", ref: "main", ruleId: "bankai:f", ticketId: "t", projectId: "p", severity: "high", githubToken: "test", baseBranch: "main", jobId: "late-job" });
    expect(result?.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://quincy.local/remediations/late-job/bankai");
  });

  it("checkpoints a running workflow instead of reporting poll expiry as failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ workflow_id: "w", job_id: "slow-job", status_url: "/w" }, { status: 202 }));
    const onStarted = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    const result = await runQuincyRemediationWorkflow({ repo: "acme/app", ref: "main", ruleId: "bankai:f", ticketId: "t", projectId: "p", severity: "high", githubToken: "test", baseBranch: "main", onStarted, pollTimeoutMs: 0 });
    expect(onStarted).toHaveBeenCalledWith("slow-job");
    expect(result).toMatchObject({ jobId: "slow-job", status: "running", error: null });
  });

  it("preserves the checkpoint during a temporary status outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    const result = await runQuincyRemediationWorkflow({ repo: "acme/app", ref: "main", ruleId: "bankai:f", ticketId: "t", projectId: "p", severity: "high", githubToken: "test", baseBranch: "main", jobId: "running-job" });
    expect(result).toMatchObject({ jobId: "running-job", status: "running", error: "network unavailable" });
  });

  it("reports completed attempts while the job is still running", async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ job_id: "j", status: "running", attempts: 1, active_attempt: 2, progress_summary: "Generating patch", updated_at: "2026-09-11T06:00:00Z" }))
      .mockResolvedValueOnce(Response.json({ job_id: "j", status: "succeeded", attempts: 2 })));
    await runQuincyRemediationWorkflow({ repo: "acme/app", ref: "main", ruleId: "CVE-test", ticketId: "t", projectId: "p", severity: "high", githubToken: "test", baseBranch: "main", jobId: "j", onProgress });
    expect(onProgress).toHaveBeenCalledWith({ summary: "Generating patch", activeAttempt: 2, completedAttempts: 1, updatedAt: "2026-09-11T06:00:00Z" });
  });

  it("requires repository verification before accepting a scanner-backed remediation", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(init ? { url, init } : { url });
        if (url === "http://quincy.local/workflows/remediations") {
          return Response.json(
            {
              workflow_id: "workflow-123",
              job_id: "job-456",
              status_url: "/workflows/workflow-123",
            },
            { status: 202 },
          );
        }
        if (url === "http://quincy.local/remediations/job-456/bankai") {
          return Response.json({
            job_id: "job-456",
            status: "succeeded",
            final_status: "succeeded",
            attempts: 1,
            total_cost_usd: 0,
            total_tokens: 10,
            pr_url: "https://github.com/acme/app/pull/7",
            patch: {
              summary: "Validated fix",
              files_changed: 1,
              lines_added: 2,
              lines_removed: 1,
            },
          });
        }
        return Response.json({ detail: "not found" }, { status: 404 });
      }),
    );

    const result = await runQuincyRemediationWorkflow({
      repo: "acme/app",
      ref: "main",
      ruleId: "bandit:B608",
      ticketId: "ticket-1",
      projectId: "project-1",
      severity: "high",
      githubToken: "gh-token",
      baseBranch: "main",
      idempotencyKey: "ticket:ticket-1:quincy-remediation:job:85",
    });

    expect(result).toEqual({
      jobId: "job-456",
      status: "succeeded",
      prUrl: "https://github.com/acme/app/pull/7",
      summary: "Validated fix",
      failureGuidance: null,
      attempts: 1,
      error: null,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://quincy.local/workflows/remediations",
      "http://quincy.local/remediations/job-456/bankai",
    ]);
    const startBody = JSON.parse(String(calls[0]?.init?.body)) as {
      execution_options: {
        require_pov: boolean;
        require_ci_parity: boolean;
        validation_policy: string;
        accept_when_target_finding_removed: boolean;
        ignore_test_command_failures: boolean;
      };
      bankai_context: { idempotency_key: string };
    };
    expect(startBody.execution_options.require_pov).toBe(false);
    expect(startBody.execution_options.require_ci_parity).toBe(true);
    expect(startBody.execution_options.validation_policy).toBe("target_scanner_clean");
    expect(startBody.execution_options.accept_when_target_finding_removed).toBe(true);
    expect(startBody.execution_options.ignore_test_command_failures).toBe(false);
    expect(startBody.bankai_context.idempotency_key).toBe("ticket:ticket-1:quincy-remediation:job:85");
    expect(calls.some((call) => call.url.includes("/remediation/fix"))).toBe(false);
  });

  it("passes precise Bankai finding context to Quincy", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(init ? { url, init } : { url });
        if (url === "http://quincy.local/workflows/remediations") {
          return Response.json({ workflow_id: "workflow-123", job_id: "job-456", status_url: "/workflows/workflow-123" }, { status: 202 });
        }
        return Response.json({ job_id: "job-456", status: "failed", attempts: 3, failure_guidance: "Update pytest only." });
      }),
    );

    const result = await runQuincyRemediationWorkflow({
      repo: "acme/app",
      ref: "main",
      ruleId: "CVE-2025-71176",
      ticketId: "ticket-1",
      projectId: "project-1",
      severity: "high",
      githubToken: "gh-token",
      baseBranch: "main",
      finding: {
        title: "Vulnerable pytest pin",
        filePath: "backend/requirements.txt",
        lineStart: 7,
        lineEnd: 7,
        cwe: "CWE-377",
        affectedPackages: "pytest",
        currentVersions: "7.1.2",
        fixedVersions: "9.0.3",
        description: "pytest is vulnerable.",
        remediationGuidance: "Upgrade pytest.",
      },
    });

    expect(result?.failureGuidance).toBe("Update pytest only.");
    const startBody = JSON.parse(String(calls[0]?.init?.body)) as {
      bankai_context: { finding: { file_path: string; affected_packages: string; fixed_versions: string } };
    };
    expect(startBody.bankai_context.finding).toMatchObject({
      file_path: "backend/requirements.txt",
      affected_packages: "pytest",
      fixed_versions: "9.0.3",
    });
  });

  it("propagates the bounded request ID to Quincy headers and workflow context", async () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ workflow_id: "workflow-1", job_id: "job-1", status_url: "/workflows/workflow-1" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ job_id: "job-1", status: "failed", attempts: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await runQuincyRemediationWorkflow({ requestId, repo: "acme/app", ref: "main", ruleId: "CVE-test", ticketId: "ticket-1", projectId: "project-1", severity: "high", githubToken: "test", baseBranch: "main" });

    const startInit = fetchMock.mock.calls[0]![1] as RequestInit;
    const statusInit = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(startInit.headers).toMatchObject({ "x-request-id": requestId });
    expect(statusInit.headers).toMatchObject({ "x-request-id": requestId });
    expect(JSON.parse(String(startInit.body)).bankai_context.external_request_id).toBe(requestId);
  });

  it("allows Quincy remediation polling to run longer than three minutes", () => {
    env.QUINCY_REMEDIATION_TIMEOUT_MS = 900_000;

    expect(quincyRemediationPollTimeoutMs()).toBe(900_000);
  });

  it("requires executable proof for stored findings without a real scanner rule", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ workflow_id: "workflow-1", job_id: "job-1", status_url: "/workflows/workflow-1" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ job_id: "job-1", status: "failed", attempts: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await runQuincyRemediationWorkflow({ repo: "acme/app", ref: "main", ruleId: "bankai:finding-1", ticketId: "ticket-1", projectId: "project-1", severity: "high", githubToken: "test-token", baseBranch: "main" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.execution_options).toMatchObject({ require_pov: true, require_ci_parity: true, validation_policy: "full_proof", accept_when_target_finding_removed: false, ignore_test_command_failures: false });
  });

  it("caps Quincy remediation polling at thirty minutes", () => {
    env.QUINCY_REMEDIATION_TIMEOUT_MS = 60 * 60_000;

    expect(quincyRemediationPollTimeoutMs()).toBe(30 * 60_000);
  });

  it("classifies zero-attempt Quincy no-match results as handoff misses instead of validation failures", () => {
    const fallback = describeQuincyFallback({
      jobId: "job-1",
      status: "failed",
      prUrl: null,
      summary: null,
      failureGuidance: null,
      attempts: 0,
      error: "no finding for rule 'CVE-2023-43804' in C:\\workspace",
    });

    expect(fallback.kind).toBe("no_match");
    expect(fallback.logLevel).toBe("info");
    expect(fallback.logMessage).toBe("Quincy could not match finding; continuing to Bankai fallback remediation");
    expect(fallback.note).toContain("Bankai fallback used the ticket's stored finding context.");
  });

  it("keeps attempted Quincy failures classified as validation failures", () => {
    const fallback = describeQuincyFallback({
      jobId: "job-1",
      status: "failed",
      prUrl: null,
      summary: "tests still fail",
      failureGuidance: "Update only the vulnerable package.",
      attempts: 3,
      error: null,
    });

    expect(fallback.kind).toBe("validation_failed");
    expect(fallback.logLevel).toBe("warn");
    expect(fallback.logMessage).toBe("Quincy workflow failed validation; continuing to Bankai fallback remediation");
  });

  it("submits a correlated versioned verification and persists its execution before polling", async () => {
    env.QUINCY_API_TOKEN = "service-test-token";
    const started: string[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ detail: "temporary" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ execution_id: "execution-1", state: "queued" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ state: "failed", result_current: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runQuincyVerification({
      idempotencyKey: "bankai-remediation:attempt-1", repository: "org/repo", baselineSha: "a".repeat(40), candidateSha: "b".repeat(40),
      target: { legacyFingerprint: "legacy-1", occurrenceId: "occ-1", externalId: "SCHRIFT-1", filePath: "src/app.ts" },
      remediationId: "00000000-0000-4000-8000-000000000001", attemptId: "00000000-0000-4000-8000-000000000002",
      findingId: "00000000-0000-4000-8000-000000000003", profile: "jenkins-schrift-comparison-v1",
      policyId: "bankai-complete-repository-differential-v1", onStarted: async (id) => { started.push(id); },
    })).rejects.toThrow("current passing result");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/v1/verifications");
    expect(fetchMock.mock.calls[1]![1].body).toBe(fetchMock.mock.calls[0]![1].body);
    expect(body).toMatchObject({ schema_version: "1.0", profile: "jenkins-schrift-comparison-v1", baseline_sha: "a".repeat(40), candidate_sha: "b".repeat(40),
      bankai_correlation: { attempt_id: "00000000-0000-4000-8000-000000000002" } });
    expect(started).toEqual(["execution-1"]);
  });
});
