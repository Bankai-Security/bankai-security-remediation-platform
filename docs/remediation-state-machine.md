# Bankai Remediation State Machine (SCRUM-30)

## Contract and persistence

The additive Supabase migrations `20261113100000_remediation_state_machine.sql` and `20261114100000_harden_remediation_state_machine.sql` store a remediation keyed to a project/finding, independent numbered attempts, immutable patch digest and base/candidate SHAs, Quincy and Jenkins references, evidence references, structured failure data and idempotent command events. The follow-up migration supports databases where the initial RPC may already have run by renaming and wrapping it, upgrading old create responses with revision zero, and retaining parent diagnosis. The `SECURITY DEFINER` RPC serializes transitions under row locks, checks expected revisions, stores command receipts and rejects key reuse with a different command. RLS gives users read access only to owned project data; writes go through the service-only RPC. Existing verification evidence tables/formats and ticket completion policy remain authoritative.

Supported states are `DISCOVERED`, `TRIAGED`, `PATCH_GENERATED`, `VERIFICATION_PENDING`, `VERIFYING`, `VERIFICATION_FAILED`, `PATCH_REVISION`, `VERIFIED`, `PR_PUBLISHED`, `CANCELLED`, `ESCALATED`, `BLOCKED`, and `VERIFICATION_INCOMPLETE`. Every retry creates a new attempt; previous attempt records are retained. Only a matching accepted Quincy `not_detected` comparison with exact repository, finding/occurrence, base/candidate SHAs, complete scanner observations, fresh analyzed coverage, distinct snapshots and valid evidence digests may transition to `VERIFIED`.

## Corrections in this continuation

The create RPC now initializes revision to `1`, matching the event it records and allowing the first subsequent command to use that revision. The follow-up wrapper also upgrades prior revision-zero create records/events when replayed. Parent remediation rows retain failure classification and diagnostics, including human escalation before any attempt exists. When the attempt limit is exhausted, the current attempt is updated with `ESCALATED`, `retry_exhausted`, and a human-review diagnostic instead of silently changing only the parent state. Prior failed attempts remain unchanged. This keeps terminal exhaustion auditable without manufacturing a new attempt.

## Recovery and operations

`RemediationRepository.recover()` is a bounded read-only recovery query. A worker resumes by reading the persisted state, revision and attempt/Quincy execution IDs, then polling or issuing a command with the exact idempotency key/payload. Stale revisions fail. Duplicate command delivery returns its stored response. The repository layer alone does not run a worker or submit Quincy verification; those integrations remain explicit follow-on work. Apply migrations through the existing Supabase migration pipeline; do not edit production databases manually. Rollback by disabling the new caller and retaining tables/evidence for audit; dropping the tables would destroy attempt history and is not an automatic rollback.

## Validation and security

`backend/src/lib/remediation-state.test.ts` covers strict schemas, SHA binding, required verification references/diagnostics, persisted failure fields, fail-closed RPC handling, and recovery through a fresh repository instance. Vitest passed (14/14). The rollback-only `supabase/tests/remediation_state_machine.sql` covers create revision/idempotency, multiple attempts, rejection of unbacked VERIFIED, rejection of mismatched execution identity, acceptance of matching complete Quincy evidence, retained failed history and retry exhaustion. It passed against disposable Supabase project `ypafqnsevfnkfeefpytb`; the test left projects, scans, findings, remediations, attempts and events at zero. A committed synthetic `VERIFYING` remediation was also read in a separate CLI query with its revision and Quincy job ID intact, then removed, exercising persisted recovery data across independent database sessions.

The three migrations `20261110100000`, `20261113100000`, and `20261114100000` were promoted to Bankai project `gyiyyuozhaavqxstzmgf` after the disposable run. Production now has 35 migration records through `20261114100000` and the expected evidence/state-machine tables and RPC. Existing production counts remained projects=4, scans=20, findings=102. Keep service-role credentials server-side.

## Acceptance status

- Additive persistent records, attempt history, revision-checked transitions, duplicate-delivery protection, evidence gate and recovery query: implemented.
- Retry exhaustion and terminal human escalation retain parent and attempt diagnosis; previous attempt history is preserved.
- Vitest state-machine unit tests passed (14/14); disposable SQL assertions passed, including positive matching evidence and mismatched identity rejection; a persisted in-flight record survived between separate Supabase CLI queries and was cleaned up. Production migration promotion and schema readback passed. No concurrent multi-worker stress test or full Bankai process restart was performed.

Modified/created files: this report; `supabase/migrations/20261110100000_quincy_verification_evidence.sql`, `supabase/migrations/20261113100000_remediation_state_machine.sql`, `supabase/migrations/20261114100000_harden_remediation_state_machine.sql`, `supabase/tests/remediation_state_machine.sql`, `backend/src/lib/remediation-state.ts`, and `backend/src/lib/remediation-state.test.ts`.
