import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  explicitQuincyTargetComparison,
  persistQuincyScanEvidence,
  quincyEvidenceIsComparable,
  runQuincyTriageScan,
} from "./quincy.js";

const liveEnabled = process.env.RUN_S07_LIVE_E2E === "true";
const liveDescribe = liveEnabled ? describe : describe.skip;

liveDescribe("S07 live Quincy and PostgreSQL evidence flow", () => {
  it("binds two immutable commits, compares the target, and persists Bankai's decision", async () => {
    const repoPath = process.env.S07_REPO_PATH!;
    const baselineCommit = process.env.S07_BASELINE_COMMIT!;
    const candidateCommit = process.env.S07_CANDIDATE_COMMIT!;
    const projectId = process.env.S07_PROJECT_ID!;
    const ticketId = process.env.S07_TICKET_ID!;
    expect([repoPath, baselineCommit, candidateCommit, projectId, ticketId]).not.toContain("");

    const repoRef = { kind: "local_path" as const, value: repoPath };
    const baseline = await runQuincyTriageScan({
      repo: "controlled/synthetic",
      repoRef,
      ref: baselineCommit,
      commitSha: baselineCommit,
      scoreFindings: false,
    });
    expect(baseline).not.toBeNull();
    expect(baseline!.findings).toHaveLength(1);
    expect(baseline!.evidence?.revision).toMatchObject({
      binding: "quincy_verified_checkout",
      resolved_commit: baselineCommit,
    });

    const observed = baseline!.evidence!.observations
      .flatMap((observation) => observation.findings)[0]!;
    const target = {
      legacyFingerprint: observed.legacy_fingerprint,
      occurrenceId: observed.occurrence_id,
      externalId: observed.rule_id,
      filePath: observed.file_path,
    };
    const candidate = await runQuincyTriageScan({
      repo: "controlled/synthetic",
      repoRef,
      ref: candidateCommit,
      commitSha: candidateCommit,
      scoreFindings: false,
      comparison: { baselineEvidence: baseline!.evidence!, target },
    });
    expect(candidate).not.toBeNull();
    expect(candidate!.findings).toHaveLength(0);
    expect(quincyEvidenceIsComparable(baseline!, candidate!, baselineCommit, candidateCommit)).toBe(true);

    const comparison = explicitQuincyTargetComparison(
      baseline!, candidate!, target, baselineCommit, candidateCommit,
    );
    expect(comparison).toEqual({
      outcome: "not_detected",
      reason: "complete_comparable_scan_analyzed_target_scope",
    });

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const baselineEvidenceId = await persistQuincyScanEvidence(supabase, {
      projectId,
      result: baseline!,
    });
    const candidateEvidenceId = await persistQuincyScanEvidence(supabase, {
      projectId,
      result: candidate!,
    });
    expect(baselineEvidenceId).toBeTruthy();
    expect(candidateEvidenceId).toBeTruthy();

    const { error: decisionError } = await supabase
      .from("remediation_security_verifications")
      .upsert({
        project_id: projectId,
        ticket_id: ticketId,
        commit_sha: candidateCommit,
        scanner: "quincy",
        baseline_findings: baseline!.findings,
        current_findings: candidate!.findings,
        baseline_evidence_id: baselineEvidenceId,
        candidate_evidence_id: candidateEvidenceId,
        comparison_outcome: comparison.outcome,
        comparison_reason: comparison.reason,
        verification_policy: "bankai-complete-repository-differential-v1",
        final_decision: "accepted",
        decision_evidence_digest: candidate!.evidence!.evidence_digest,
      }, { onConflict: "ticket_id,commit_sha,scanner" });
    expect(decisionError).toBeNull();

    const { data: decision, error: readError } = await supabase
      .from("remediation_security_verifications")
      .select("commit_sha,comparison_outcome,final_decision,baseline_evidence_id,candidate_evidence_id,decision_evidence_digest")
      .eq("ticket_id", ticketId)
      .eq("commit_sha", candidateCommit)
      .single();
    expect(readError).toBeNull();
    expect(decision).toMatchObject({
      commit_sha: candidateCommit,
      comparison_outcome: "not_detected",
      final_decision: "accepted",
      baseline_evidence_id: baselineEvidenceId,
      candidate_evidence_id: candidateEvidenceId,
      decision_evidence_digest: candidate!.evidence!.evidence_digest,
    });

    const rejectedEvidenceId = await persistQuincyScanEvidence(supabase, {
      projectId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      result: candidate!,
    });
    expect(rejectedEvidenceId).toBeNull();
  });
});
