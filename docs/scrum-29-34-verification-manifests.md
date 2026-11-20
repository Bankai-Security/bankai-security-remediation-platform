# SCRUM-29 and SCRUM-34 verification manifest integration

## Bankai contract and integrity checks

Quincy v1 continues to return the existing `VerificationJob` and
`TriageScanEvidence` envelope. Terminal jobs carry a canonical SHA-256 manifest;
authenticated manifest and artifact routes retrieve the record and verify
artifact digests. The digest detects edits but is not a signature.

Bankai's `backend/src/lib/quincy-manifest.ts` consumes that contract, checks
repository/commit/profile/policy/execution/attempt identities and freshness,
then fetches and hashes the referenced artifacts. Its
`verifyRemediationAttempt` resumes an idempotent attempt, persists the Quincy
execution ID before polling, stores the manifest, applies target comparison and
security regression checks, persists scan/decision evidence, and requests the
existing VERIFIED transition.

The validator correlates execution ID, repository identity, candidate commit,
scan revision, verification profile, and policy with values expected from the
specific remediation attempt. It rejects future, failed, or incomplete
execution and scan evidence. Artifact references carry SHA-256 digests and must
be fetched and verified by the trusted Quincy producer/consumer transport before
they can support a VERIFIED transition.

`remediation_verification_manifests` stores one immutable manifest per attempt.
The trigger binds execution, repository, and candidate SHA to persisted attempt
state; duplicate identical inserts can be retried and conflicting writes fail.
Service-role access is insert-only, with owner-scoped reads.

## Integration status and limits

The new caller runs after Bankai records a SHA-pinned candidate when Quincy is
configured. The GitHub Actions CI path remains in place. An additive migration
aligns the existing state-machine repository check (stored `owner/repo`) with
Quincy's derived repository ID, retaining the locator for GitHub links. The
manifest table is supplementary immutable audit storage; existing scan evidence
and VERIFIED transition checks remain authoritative.

## Local evidence

Focused Quincy producer/API/worker tests and Bankai manifest-consumer tests are
listed in the sprint evidence report. Live Jenkins, database migration and
cross-product fixture results are recorded there; no hosted database or Railway
service was changed.
