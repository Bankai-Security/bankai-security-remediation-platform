# Local Jenkins Companion — Subplans

This document decomposes `local-jenkins-companion-plan.md` into implementation slices. The source plan supplies product and security requirements; this breakdown does not authorize deployment, external account changes, or production migration.

## Guardrails for every subplan

- Keep local execution opt-in and represent skipped work as skipped, never passed.
- Reuse the existing Quincy verification v1 manifest and Bankai attempt/evidence/state-machine boundaries.
- Do not allow a local result to satisfy `VERIFIED` without a separately approved trust model.
- Never expose Jenkins or Docker control endpoints publicly or send raw Jenkins credentials to Bankai/Quincy/browser storage.
- Preserve existing GitHub Actions and scan-evidence behavior during migration.

## Subplans and exit criteria

| ID | Scope | Exit criteria |
|---|---|---|
| A. Contract and baseline | Inventory current verification, bootstrap, PR, and evidence behavior; define protocol, trust labels, supported environment, and feature-flag boundary. | Requirements map to existing code or explicit additive work; no unresolved identity or pass-gating ambiguity. |
| B. Runner protocol | Define versioned task lease, capabilities, heartbeat/progress, cancellation, result, artifact, expiry, and idempotency contracts. | Strict schemas and contract notes bind execution, attempt, finding, repo, policy, and exact SHAs; no client-controlled task mutation. |
| C. Quincy control plane | Provider abstraction; paired-runner auth/revocation; durable queue/outbox; leases, artifact upload, immutable manifest finalization and restart recovery. | Duplicate delivery is idempotent, conflicts fail closed, and worker/API restart cannot silently create a second Jenkins build. |
| D. Windows companion proof of concept | Pairing, Docker/Jenkins readiness, pinned stack lifecycle, credential manager integration, isolated fixture execution, in-app Jenkins view, cleanup. | Passing/failing/tampering fixtures and app restart recovery work; unsafe isolation refuses untrusted execution. |
| E. Bankai backend integration | Bind runner results to existing attempt; persist snapshots and provenance; stale-SHA, cancellation, bounded retry, recovery and idempotent processing. | Existing manifest/artifact validation remains authoritative and local outcome never bypasses `VERIFIED` policy. |
| F. Workflow UI | Authenticated workflow route, readiness and opt-in/skip states, progress/evidence/recovery, companion install/open, safe Jenkins embedded view. | Responsive UI uses existing design system; skip causes no local dispatch or success check. |
| G. GitHub and bootstrap transition | Per-finding remediation PR identity; idempotent checks bound to candidate SHA; remove bootstrap prerequisite and separately model any optional integration work. | Remediation no longer waits for bootstrap; old workflow/webhook behavior has a compatibility/migration plan; exact-SHA checks are accurate. |
| H. Pilot and rollout | Fixture pilot, explicit feature flag, operational metrics/runbook, security review, staged opt-in release. | Recovery, cleanup, privacy, support, and trust acceptance approved before broad enablement. |

## Dependency order

`A → B → C → D → E → F`; `G` can proceed after A's bootstrap inventory and in parallel with C–F once its compatibility plan is approved. `H` depends on all release-critical slices. No live runner dispatch should be enabled before C and D prove durable identity binding and safe execution isolation.

## Current implementation start

Subplan B's strict v1 protocol is implemented in `backend/src/lib/local-runner-protocol.ts`, with paired runner routes and a developer companion under `tools/local-runner/`. Dispatch remains opt-in behind `LOCAL_RUNNER_ENABLED`.

Initial repository inventory found bootstrap coupling in `pipeline.job.ts`, `ticket.controller.ts`, `webhook.controller.ts`, `ci-bootstrap.ts`, and `ticketing.ts`, plus user-facing marketing copy and persisted project columns. Bootstrap removal must therefore be a deliberate G transition rather than deleting an isolated helper.

## Subplan B contract details

- A claim is a request for available work plus a stable idempotency key. The server chooses and binds the task; the runner cannot submit or alter repository, finding, attempt, policy, or SHAs.
- A lease has server-issued identity and expiry. Heartbeats identify the same lease/execution and may extend expiry only while the lease is active and the paired installation remains authorized.
- Progress is ordered per execution. The next sequence is accepted; an identical replay of the most recent sequence is acknowledged; a gap or conflicting replay fails closed. Terminal callbacks and artifact uploads use stable idempotency keys and content digests.
- Cancellation is a request against a specific lease/execution. It does not imply success or terminal completion; the runner must report a cancelled result and cleanup evidence.
- Artifact names are an allowlist matching the existing manifest contract. Descriptors cap individual artifact size and carry a SHA-256 digest; the server still verifies the received bytes and manifest references.
- Result identity is checked against the persisted lease and attempt before the existing Quincy manifest schema and Bankai validation are invoked. `passed` in a transport envelope is not sufficient to publish a pass or transition state.

The protocol schemas include claim, heartbeat, progress, artifact, and result envelopes plus a pure replay classifier. Dispatch is available only when the operator enables `LOCAL_RUNNER_ENABLED`.

## Subplans C–F implementation status

Additive migrations define the durable attempt-bound task queue, one-time pairing, token digests, cancellation/events, artifact metadata, and per-attempt run/skip choices. The authenticated companion claims only when `LOCAL_RUNNER_ENABLED=true`, submits the exact identity to the local Quincy v1 service, and transfers its finalized manifest and artifacts. Bankai re-hashes uploaded bytes, validates the Quincy manifest, evidence completeness, exact SHAs and finding comparison, then records a terminal task state. It publishes an exact-candidate-SHA GitHub commit status: a local pass stays `pending`, a failed run is `failure`, and incomplete/cancelled work is `error`. `passed` is shown as **Passed locally · not verified** and never sets remediation `VERIFIED`.

Expired leases become `incomplete` and atomically move the matching current remediation attempt to `VERIFICATION_INCOMPLETE`. A worker sweeper runs at startup and every 30 seconds; claim also invokes recovery. Expired work is never requeued because a Jenkins build may already have been submitted. Durable task records currently provide the queue; there is no separate transactional outbox.

## Work completed in this implementation pass

- Added the project-scoped Jenkins Verification destination, explicit per-attempt run/skip choice, task history/cancellation, and paired runner management. Dispatch is guarded by `LOCAL_RUNNER_ENABLED`, which defaults to false.
- Removed the active CI-bootstrap generator and bootstrap PR creation path. Existing repository workflows can still be used; repositories without one remain unverified for that hosted CI path. Late webhook deliveries for the historical `bankai/ci-bootstrap` branch are ignored.
- Updated landing copy and README to stop promising automatic workflow installation.
- Kept legacy project bootstrap columns and historical data in place; no data-dropping migration was introduced.

## Remaining blockers

The developer flow can be exercised when a local Quincy service, its isolated Jenkins stack, Bankai migrations, and feature flag are configured. Production rollout is still blocked on a signed Windows installer, operationally managed Quincy/Jenkins credentials and repository allowlists, GitHub App Check Runs and required-check policy, and security approval of local provenance. The current commit-status fallback never posts success for a local pass. The local companion source is not a signed or auto-updating desktop application. Do not describe its local pass as trusted verification or enable it for untrusted repositories.

The Quincy API contract and Docker-backed isolation implementation already exist in the adjacent `quincy-security-engine` project. They are separate repository changes and deployment artifacts; this Bankai repository consumes the existing v1 contract. No production credentials or signing certificate are present in this workspace.

## Pairing and runner channel progress

The control plane supports authenticated project members creating ten-minute, single-use pairing codes. Exchange stores only a digest of a 256-bit bearer token, expires that token after 30 days, and allows project owners/admins to revoke the installation. Runner endpoints support capability updates, lease claim, heartbeat, ordered progress, artifact upload, result submission, and cancellation polling. Claims stay disabled unless the server feature flag is enabled and Docker/Jenkins/Quincy readiness is reported. Artifact uploads are size/type bounded, SHA-256 checked on received bytes, stored in a private bucket, and bound to an active lease. Result submission validates the persisted manifest identity and the actual stored artifact bytes; an accepted local pass still cannot create Bankai `VERIFIED`.

No pairing/API secrets are written to browser storage or logs. The browser displays the one-time pairing code only in component memory. The developer companion stores Bankai and local Quincy bearer tokens in Windows Credential Manager. Pairing, local Quincy submission, private artifact transfer, and server-side evidence validation are implemented. Signed packaging, GitHub Checks, and the approved trust model remain outstanding.
