import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { explicitQuincyTargetComparison, persistQuincyScanEvidence, runQuincyVerification, type QuincyTriageResult } from "./quincy.js";
import { validateQuincyManifest, type QuincyVerificationManifest } from "./quincy-manifest.js";
import { RemediationRepository } from "./remediation-state.js";
import { securityRegression } from "./security-regression.js";
import { normalizeSeverity } from "./csv-ingest.js";

const StoredAttempt = z.object({ id: z.uuid(), state: z.string(), base_sha: z.string().regex(/^[0-9a-f]{40}$/), candidate_sha: z.string().regex(/^[0-9a-f]{40}$/), verification_profile: z.string(), quincy_job_id: z.string().nullable().optional() });
const Finding = z.object({ id: z.uuid(), external_id: z.string().nullable(), file_path: z.string().nullable(), cwe: z.string().nullable(), line_start: z.number().nullable(), line_end: z.number().nullable(), legacy_fingerprint: z.string().nullable(), occurrence_id: z.string().nullable() });

function normalized(evidence: NonNullable<QuincyTriageResult["evidence"]>) {
  return evidence.observations.flatMap((observation) => observation.findings.map((finding) => ({
    fingerprint: finding.legacy_fingerprint, legacyFingerprint: finding.legacy_fingerprint,
    occurrenceId: finding.occurrence_id, externalId: finding.rule_id, title: finding.rule_id,
    severity: normalizeSeverity(finding.severity, null), cvssScore: null, cwe: null,
    component: null, filePath: finding.file_path, findingType: "Quincy finding", sourceStatus: null,
    dateFound: null, description: null, fixAvailable: null, sourceUrl: null, service: null,
    environment: null, cves: null, affectedPackages: null, currentVersions: null, fixedVersions: null,
    recommendations: null, lineStart: finding.line_start, lineEnd: finding.line_end,
  })));
}

/** Execute/resume the persisted SCRUM-30 attempt through Quincy verification v1.
 * Attempt IDs and API idempotency make worker redelivery safe across restarts.
 */
export async function verifyRemediationAttempt(db: SupabaseClient, input: { remediationId: string; attemptId: string; requestId?: string | undefined }): Promise<void> {
  const repository = new RemediationRepository(db);
  let remediation = await repository.get(input.remediationId);
  if (!remediation || remediation.current_attempt_id !== input.attemptId) throw new Error("Current remediation attempt does not match.");
  if (remediation.state === "VERIFIED") return;
  if (!["PATCH_GENERATED", "VERIFICATION_PENDING", "VERIFYING"].includes(remediation.state)) throw new Error(`Attempt cannot be verified from ${remediation.state}.`);
  let attempts = await repository.attempts(input.remediationId);
  const attempt = StoredAttempt.parse(attempts.find((item) => (item as { id?: string }).id === input.attemptId));
  if (attempt.verification_profile !== "jenkins-schrift-comparison-v1") throw new Error("Attempt verification profile does not match Quincy Jenkins profile.");
  const existingManifest = await repository.verificationManifest(input.attemptId);
  if (existingManifest && remediation.state !== "VERIFYING") throw new Error("A finalized manifest exists for an attempt that is not in verification recovery.");
  if (existingManifest && attempt.quincy_job_id !== existingManifest.execution_id) throw new Error("Persisted verification manifest does not match the attempt execution ID.");
  if (remediation.state === "PATCH_GENERATED") remediation = await repository.command({
    schema_version: "1.0", action: "transition", command_key: `scrum34:${input.attemptId}:pending`,
    remediation_id: remediation.id, expected_revision: remediation.revision, state: "VERIFICATION_PENDING",
  });
  const findingResult = await db.from("findings").select("id, external_id, file_path, cwe, line_start, line_end, legacy_fingerprint, occurrence_id")
    .eq("id", remediation.finding_id).eq("project_id", remediation.project_id).maybeSingle();
  if (findingResult.error || !findingResult.data) throw new Error("Attempt finding could not be loaded.");
  const finding = Finding.parse(findingResult.data);
  if (!finding.legacy_fingerprint) throw new Error("Attempt finding has no stable Quincy comparison identity.");
  let result: Awaited<ReturnType<typeof runQuincyVerification>>;
  try {
    result = await runQuincyVerification({
    idempotencyKey: `bankai-remediation:${input.attemptId}`, repository: remediation.repository_id,
    baselineSha: attempt.base_sha, candidateSha: attempt.candidate_sha,
    target: { legacyFingerprint: finding.legacy_fingerprint, occurrenceId: finding.occurrence_id, externalId: finding.external_id, filePath: finding.file_path },
    remediationId: remediation.id, attemptId: input.attemptId, findingId: remediation.finding_id,
    profile: attempt.verification_profile, policyId: "bankai-complete-repository-differential-v1", ...(input.requestId ? { requestId: input.requestId } : {}),
    onStarted: async (executionId) => {
      const current = await repository.get(input.remediationId);
      if (!current || current.current_attempt_id !== input.attemptId) throw new Error("Remediation attempt changed during Quincy submission.");
      if (attempt.quincy_job_id && attempt.quincy_job_id !== executionId) throw new Error("Quincy returned a different execution ID for this persisted attempt.");
      if (current.state === "VERIFYING") {
        attempts = await repository.attempts(input.remediationId);
        const saved = StoredAttempt.parse(attempts.find((item) => (item as { id?: string }).id === input.attemptId));
        if (saved.quincy_job_id !== executionId) throw new Error("Persisted Quincy execution belongs to another attempt.");
        return;
      }
      if (current.state !== "VERIFICATION_PENDING") throw new Error("Attempt is no longer awaiting verification.");
      await repository.command({ schema_version: "1.0", action: "transition", command_key: `scrum34:${input.attemptId}:started`,
        remediation_id: current.id, expected_revision: current.revision, state: "VERIFYING", quincy_job_id: executionId });
    },
    });
  } catch {
    const current = await repository.get(input.remediationId);
    if (current && current.current_attempt_id === input.attemptId && current.state === "VERIFYING") {
      await repository.command({ schema_version: "1.0", action: "transition", command_key: `scrum34:${input.attemptId}:incomplete`,
        remediation_id: current.id, expected_revision: current.revision, state: "VERIFICATION_INCOMPLETE",
        failure_classification: "incomplete", diagnostic: "Quincy did not return a complete, current, integrity-validated verification result." });
    } else if (current && current.current_attempt_id === input.attemptId && current.state === "VERIFICATION_PENDING") {
      await repository.command({ schema_version: "1.0", action: "transition", command_key: `scrum34:${input.attemptId}:submission-failed`,
        remediation_id: current.id, expected_revision: current.revision, state: "BLOCKED",
        failure_classification: "infrastructure", diagnostic: "Quincy verification could not be submitted after bounded transport retries." });
    }
    throw new Error("Quincy verification failed closed; the remediation attempt was not verified.");
  }
  const manifestDigest = result.manifest.integrity_digest;
  validateQuincyManifest(result.manifest, {
    executionId: result.executionId,
    repositoryId: result.manifest.repository_id,
    repository: result.manifest.repository,
    candidateSha: attempt.candidate_sha,
    baselineSha: attempt.base_sha,
    profile: attempt.verification_profile,
    policyId: "bankai-complete-repository-differential-v1",
    correlation: { remediation_id: remediation.id, attempt_id: input.attemptId, finding_id: remediation.finding_id, base_sha: attempt.base_sha },
  });
  if (existingManifest) {
    const existing = existingManifest.manifest as QuincyVerificationManifest;
    if (existingManifest.manifest_id !== result.manifest.manifest_id || existingManifest.manifest_digest !== manifestDigest
      || existingManifest.execution_id !== result.executionId || existing.integrity_digest !== manifestDigest) {
      throw new Error("Recovered Quincy result conflicts with the immutable persisted manifest.");
    }
  }
  await repository.recordVerificationManifest({ attemptId: input.attemptId, manifestId: result.manifest.manifest_id,
    executionId: result.executionId, digest: manifestDigest, manifest: result.manifest });
  const baseline: QuincyTriageResult = { findings: normalized(result.baselineEvidence), rawFindingCount: 0, scanDurationSeconds: 0, evidence: result.baselineEvidence, baselineEvidence: null };
  const candidate: QuincyTriageResult = { findings: normalized(result.candidateEvidence), rawFindingCount: 0, scanDurationSeconds: 0, evidence: result.candidateEvidence, baselineEvidence: null };
  const comparison = explicitQuincyTargetComparison(baseline, candidate,
    { legacyFingerprint: finding.legacy_fingerprint, occurrenceId: finding.occurrence_id, externalId: finding.external_id, filePath: finding.file_path },
    attempt.base_sha, attempt.candidate_sha);
  if (comparison.outcome !== "not_detected") throw new Error(`Quincy comparison did not clear target: ${comparison.reason}`);
  const regression = securityRegression(baseline.findings, candidate.findings, {
    externalId: finding.external_id, filePath: finding.file_path, cwe: finding.cwe,
    lineStart: finding.line_start, lineEnd: finding.line_end,
  });
  if (regression) {
    const current = await repository.get(input.remediationId);
    if (current?.state === "VERIFYING" && current.current_attempt_id === input.attemptId) {
      await repository.command({ schema_version: "1.0", action: "transition", command_key: `scrum34:${input.attemptId}:security-failed`,
        remediation_id: current.id, expected_revision: current.revision, state: "VERIFICATION_FAILED",
        failure_classification: "security", diagnostic: `Quincy candidate introduced a security regression: ${regression}` });
    }
    throw new Error(`Quincy candidate introduced a security regression: ${regression}`);
  }
  const projectId = remediation.project_id;
  const baselineEvidenceId = await persistQuincyScanEvidence(db, { projectId, result: baseline });
  const candidateEvidenceId = await persistQuincyScanEvidence(db, { projectId, result: candidate });
  if (!baselineEvidenceId || !candidateEvidenceId) throw new Error("Quincy scan evidence persistence failed.");
  const ticketResult = await db.from("tickets").select("id").eq("project_id", projectId).eq("finding_id", remediation.finding_id).limit(1).maybeSingle();
  if (ticketResult.error || !ticketResult.data) throw new Error("Remediation ticket could not be resolved for the verification record.");
  const verificationResult = await db.from("remediation_security_verifications").upsert({
    project_id: projectId, ticket_id: ticketResult.data.id, commit_sha: attempt.candidate_sha,
    scanner: "quincy", baseline_findings: baseline.findings, current_findings: candidate.findings,
    baseline_evidence_id: baselineEvidenceId, candidate_evidence_id: candidateEvidenceId,
    comparison_outcome: comparison.outcome, comparison_reason: comparison.reason,
    verification_policy: "bankai-complete-repository-differential-v1", final_decision: "accepted",
    decision_evidence_digest: result.candidateEvidence.evidence_digest, verified_at: new Date().toISOString(),
  }, { onConflict: "ticket_id,commit_sha,scanner" }).select("id").single();
  if (verificationResult.error || !verificationResult.data) throw new Error("Bankai verification decision persistence failed.");
  remediation = await repository.get(input.remediationId);
  if (!remediation || remediation.current_attempt_id !== input.attemptId || remediation.state !== "VERIFYING") throw new Error("Remediation attempt changed before final decision.");
  await repository.command({ schema_version: "1.0", action: "transition", command_key: `scrum34:${input.attemptId}:verified`,
    remediation_id: remediation.id, expected_revision: remediation.revision, state: "VERIFIED",
    verification_id: verificationResult.data.id, quincy_job_id: result.executionId,
    quincy_scan_execution_id: result.candidateEvidence.scan_execution_id,
    jenkins_build_id: result.manifest.jenkins_build_id });
}
