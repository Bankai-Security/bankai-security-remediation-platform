# SCRUM-31 validation

## Result

**PASS for the Jira acceptance criterion.** The initial fix flow now pins generation to a commit SHA, commits only validated paths with that SHA as parent, hashes GitHub's candidate diff, and records an immutable diff reference linked to the SCRUM-30 attempt and finding.

## Acceptance mapping

| Requirement | Implementation / evidence |
| --- | --- |
| Consume the linked finding | `backend/src/jobs/fix-pr.job.ts` uses the ticket's finding ID and versioned finding fields. |
| Pin the source revision | The job reads the branch head once, then gets the tree and repository context by that SHA and commits with it as the parent. |
| Keep changes in scope | The existing generated-path checks reject unsafe paths and any proposed extra file outside supplied context. |
| Record candidate history | `recordInitialPatch` creates/uses the SCRUM-30 remediation, transitions it to TRIAGED, then starts the SHA-bound attempt with a digest of the generated diff. |
| Link finding, diff and candidate | `remediation_patch_artifacts` ties finding ID, base/candidate SHA, digest, and immutable GitHub compare URL to the attempt ID; attempt history returns the artifact. |
| Duplicate delivery | Stable project/finding command keys and artifact conflict checks make the initial attempt idempotent. A committed-but-unrecorded candidate resumes from its parent SHA and exact GitHub diff. |
| Known-vulnerable fixture | `backend/src/lib/initial-patch.integration.test.ts` reads `e2e-fixture-repo/fixtures/vulnerable-command.js`, constructs the safe `execFile` candidate, and asserts its diff and candidate SHA are linked in the attempt artifact. |

## Checks

- `npm run test:integration -- --reporter=dot src/lib/initial-patch.integration.test.ts` — **PASS**, 1 test.
- `npm run typecheck` — **PASS**.
- `npm run lint -- --quiet` — **PASS**.
- `npm test -- --reporter=dot` — **PASS**, 23 files and 168 tests.
- `git diff --check` — **PASS**.

The integration test uses a simulated Supabase RPC/table boundary. No live GitHub repository or database was used. The migration is included for deployment and was not applied to a hosted database during this validation.

## Security and limitations

- Candidate commits use the pinned SHA as their sole parent; GitHub's non-forced branch update rejects a moved branch.
- Model-suggested paths are validated before commit; no arbitrary model-provided command is executed.
- The patch is a candidate only. Quincy verification and PR completion remain separate workflow steps.
- The test verifies attempt linkage and fixture patch content, not model quality or a live remote commit.
