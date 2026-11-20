import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RemediationRepository } from "./remediation-state.js";

export interface InitialPatchInput {
  projectId: string;
  findingId: string;
  repositoryId: string;
  baseSha: string;
  candidateSha: string;
  diffRef: string;
  diffContent: string;
}

/** Persist an initial generated patch as a SCRUM-30 attempt plus immutable diff reference. */
export async function recordInitialPatch(db: SupabaseClient, input: InitialPatchInput) {
  const patchDigest = `sha256-${createHash("sha256").update(input.diffContent).digest("hex")}`;
  const repository = new RemediationRepository(db);
  const remediation = await repository.command({
    schema_version: "1.0", action: "create", command_key: `scrum31:${input.projectId}:${input.findingId}:create`,
    project_id: input.projectId, finding_id: input.findingId, repository_id: input.repositoryId,
  });
  const triaged = await repository.command({
    schema_version: "1.0", action: "transition", command_key: `scrum31:${input.projectId}:${input.findingId}:triaged`,
    remediation_id: remediation.id, expected_revision: remediation.revision, state: "TRIAGED",
  });
  const attempt = await repository.command({
    schema_version: "1.0", action: "start_attempt", command_key: `scrum31:${input.projectId}:${input.findingId}:initial-attempt`,
    remediation_id: triaged.id, expected_revision: triaged.revision,
    patch_digest: patchDigest, base_sha: input.baseSha, candidate_sha: input.candidateSha,
    verification_profile: "jenkins-schrift-comparison-v1",
  });
  if (!attempt.current_attempt_id) throw new Error("Remediation attempt was not created.");
  await repository.recordPatchArtifact({
    attemptId: attempt.current_attempt_id, findingId: input.findingId, baseSha: input.baseSha,
    candidateSha: input.candidateSha, patchDigest, diffRef: input.diffRef,
  });
  return { remediation, attempt, patchDigest };
}
