# Bankai Remediation State Machine (SCRUM-30)

## Contract and persistence

The additive Supabase migrations `20261113100000_remediation_state_machine.sql` and `20261114100000_harden_remediation_state_machine.sql` store a remediation keyed to a project/finding, independent numbered attempts, immutable patch digest and base/candidate SHAs, Quincy and Jenkins references, evidence references, structured failure data and idempotent command events. The follow-up migration supports databases where the initial RPC may already have run by renaming and wrapping it, upgrading old create responses with revision zero, and retaining parent diagnosis. The `SECURITY DEFINER` RPC serializes transitions under row locks, checks expected revisions, stores command receipts and rejects key reuse with a different command. RLS gives users read access only to owned project data; writes go through the service-only RPC. Existing verification evidence tables/formats and ticket completion policy remain authoritative.

Supported states are `DISCOVERED`, `TRIAGED`, `PATCH_GENERATED`, `VERIFICATION_PENDING`, `VERIFYING`, `VERIFICATION_FAILED`, `PATCH_REVISION`, `VERIFIED`, `PR_PUBLISHED`, `CANCELLED`, `ESCALATED`, `BLOCKED`, and `VERIFICATION_INCOMPLETE`. Every retry creates a new attempt; previous attempt records are retained. Only a matching accepted Quincy `not_detected` comparison with exact repository, finding/occurrence, base/candidate SHAs, complete scanner observations, fresh analyzed coverage, distinct snapshots and valid evidence digests may transition to `VERIFIED`.

## Corrections in this continuation

The create RPC now initializes revision to `1`, matching the event it records and allowing the first subsequent command to use that revision. The follow-up wrapper also upgrades prior revision-zero create records/events when replayed. Parent remediation rows retain failure classification and diagnostics, including human escalation before any attempt exists. When the attempt limit is exhausted, the current attempt is updated with `ESCALATED`, `retry_exhausted`, and a human-review diagnostic instead of silently changing only the parent state. Prior failed attempts remain unchanged. This keeps terminal exhaustion auditable without manufacturing a new attempt.

## Recovery and operations

`RemediationRepository.recover()` is a bounded read-only recovery query. A worker resumes by reading the persisted state, revision and attempt/Quincy execution IDs, then polling or issuing a command with the exact idempotency key/payload. Stale revisions fail. Duplicate command delivery returns its stored response. The repository layer alone does not run a worker or submit Quincy verification; those integrations remain explicit follow-on work. Apply migrations through the existing Supabase migration pipeline; do not edit production databases manually. Rollback by disabling the new caller and retaining tables/evidence for audit; dropping the tables would destroy attempt history and is not an automatic rollback.

## Validation and security

`backend/src/lib/remediation-state.test.ts` covers strict schemas, SHA binding, required verification references/diagnostics, persisted failure fields and fail-closed RPC handling. Vitest passed (13/13) with `--configLoader runner`; backend `tsc --noEmit` and Oxlint passed. `supabase/tests/remediation_state_machine.sql` is a rollback-only disposable database script covering create revision/idempotency, attempts, rejection of unbacked VERIFIED, retained failed history and retry exhaustion. Run it with `psql "$DISPOSABLE_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/remediation_state_machine.sql` after applying all migrations to a populated disposable branch. It has not been run because no PostgreSQL/Supabase CLI or disposable database is available. The migration still requires database validation for transaction rollback, concurrent idempotency, RLS, restart recovery and positive/negative evidence decisions. S07-R1 does not validate this later state-machine migration. No production database was contacted. Keep service-role credentials server-side.

## Acceptance status

- Additive persistent records, attempt history, revision-checked transitions, duplicate-delivery protection, evidence gate and recovery query: implemented.
- Retry exhaustion and terminal human escalation retain parent and attempt diagnosis; previous attempt history is preserved.
- Vitest state-machine unit tests passed (13/13); backend `tsc --noEmit` passed. SCRUM-30 still needs the SQL integration script, concurrency and restart/recovery checks on disposable Supabase/PostgreSQL before Done.

Modified/created files: this report; `supabase/migrations/20261113100000_remediation_state_machine.sql`, `supabase/migrations/20261114100000_harden_remediation_state_machine.sql`, `supabase/tests/remediation_state_machine.sql`, `backend/src/lib/remediation-state.ts`, and `backend/src/lib/remediation-state.test.ts`.
