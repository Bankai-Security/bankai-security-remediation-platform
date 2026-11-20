# SCRUM-29 / SCRUM-34 validation

## Repository audit

| Repository | Path | Remote | Branch / HEAD | Working tree |
| --- | --- | --- | --- | --- |
| Bankai | `C:/Users/Anubhav Gupta/Desktop/Projects/bankai-security-remediation-platform` | `Bankai-Security/bankai-security-remediation-platform` | `main` / `b632034c62ba122462beec3e106ecf04aedccdb2` | Existing SCRUM-31 and related local edits plus this work; preserved. |
| Quincy | `C:/Users/Anubhav Gupta/Desktop/Projects/quincy-security-engine` | `Bankai-Security/quincy-security-engine` | `master` / `6a0a9c4e0d5a02c5d4590d5788302e876143da82` | Existing uncommitted SCRUM-28 work plus this work; preserved. |
| Schrift | `C:/Users/Anubhav Gupta/Desktop/Projects/schrift` | `Bankai-Security/schrift` | `main` / `accbc0f90cf4ad4190829332d3b47bea20ec2bf4` | Pre-existing progress-document changes; no source edits made. |

These are the active repositories. The Quincy release-audit bundle under Bankai
reports was not used as source.

## Prerequisites

- **SCRUM-26 present:** Quincy exposes authenticated `POST /v1/verifications`,
  `GET /v1/verifications/{execution_id}`, and cancel routes with strict v1
  request schema, idempotency, and durable SQLite/PostgreSQL job persistence.
- **SCRUM-27 present:** Quincy has a Jenkins backend and disposable isolated
  execution agent with SHA-pinned checkout and cleanup behavior.
- **SCRUM-28 present:** the `jenkins-schrift-comparison-v1` profile runs build,
  test, and packaged Schrift stages and retains exact-revision evidence. The
  Quincy SCRUM-28 report records local Jenkins build 30–34 results. Those
  historical live runs were not repeated in this task.
- `/remediations/run` remains the AI patch-generation route; Bankai now submits
  through the separate verification v1 API.

## Implemented

- Quincy finalizes a canonical JSON SHA-256 manifest for each terminal result,
  including failed, cancelled, and incomplete outcomes. Its existing job/evidence
  envelope remains intact. Authenticated retrieval by execution ID or manifest ID
  and artifact endpoints verify integrity. Build logs are bounded and common
  credential patterns are redacted. Its test-report artifact records the actual
  Jenkins stage outcomes and binds the sanitized execution log digest. A digest is
  not presented as a producer signature.
- Bankai submits an idempotent, attempt-correlated v1 request, persists the
  execution ID before polling, validates the manifest identity/digest/freshness,
  resumes by reusing the persisted idempotency key and execution ID, fetches and
  hashes all referenced artifacts (including parsing the scan envelope and
  matching it to terminal status), checks explicit complete target
  comparison and security regressions, persists evidence, and invokes its
  existing VERIFIED state transition. Failures remain non-passing.
- Added immutable manifest storage and a database guard binding VERIFIED to the
  manifest, execution, Jenkins build, scan execution, attempt, repository, and
  candidate SHA. Added a migration aligning the existing `owner/repo` locator
  with Quincy's derived repository identity. Corrected JSON field paths and the
  state-machine function rewrite anchor to match the actual Quincy v1 manifest
  and existing SQL implementation.
- Quincy also exposes manifest-addressed artifact reads; consumers can retrieve
  artifacts through authenticated manifest references while the server binds
  each reference back to the authorized execution.

## Test evidence

- Quincy unit suite: **792 passed, 6 skipped**, 5 existing pytest collection
  warnings. Focused manifest/API/worker tests include failed manifest retention,
  manifest and artifact tampering, cancellation, and persistence across a fresh
  store instance.
- Quincy Ruff checks on edited source/tests: **PASS**. Quincy `git diff --check`:
  **PASS**.
- Bankai backend suite (prior run): **173 passed**. Focused Quincy
  client/manifest/state tests after recovery and artifact checks: **47 passed**.
  Initial-patch integration fixture: **1 passed** (mocked
  Supabase/GitHub; not cross-product Jenkins).
- Bankai TypeScript typecheck and `git diff --check`: **PASS**. Secret-pattern
  search on changed integration files found no common credential patterns.
- Repository migration was not applied to a database. Its SQL trigger and
  function rewrite have not been validated against PostgreSQL in this task.

## Acceptance status and blockers

**SCRUM-29: PARTIAL.** Producer, integrity validation, persistence, retrieval,
and unit/API artifact checks are implemented. A real Jenkins execution was not
performed in this task.

**SCRUM-34: PARTIAL.** Bankai integration code and mocked request/result checks
are present. End-to-end Bankai-to-Quincy persistence and restart tests against a
real database were not run. The additive database migrations remain unapplied.

The existing Quincy local configuration reports service authentication,
Jenkins credentials, Schrift enablement, and repository allowlisting all absent.
No `psql`, PostgreSQL server, Docker executable, or local Supabase project
configuration is available. Supabase CLI status could not be run because the
CLI attempted to write telemetry outside the workspace sandbox. Therefore the
passing and failing cross-product fixtures, PostgreSQL migration/restart tests,
and live Jenkins test could not run. No Railway, staging, production, Git
remote, or Jira changes were made.

**Jira recommendation: Not Done** for both issues until the migrations pass
database validation and configured passing/failing cross-product Jenkins runs
prove the persisted VERIFIED and non-VERIFIED outcomes.

## Staging acceptance attempt — 2026-11-15

Railway project `0980e07b-f702-4f83-a137-cb568940cc2d` and environment
`staging` (`3d38aada-21f1-44cc-845f-e5ea5893ea95`) were confirmed by ID.
Bankai backend, Quincy API, Postgres, Redis, and Bankai frontend all report
`SUCCESS`; there are no staged Railway changes. The staging project has no
Jenkins service. Quincy API and Bankai service variables include
`SERVICE_API_TOKEN`, `QUINCY_API_URL`, and `QUINCY_API_TOKEN` by name; Railway's
connected OAuth integration withholds the values, so endpoint/authentication
reachability was not tested.

The Quincy staging variable inventory is missing the runtime verification
configuration `ENABLED_SCANNERS`, `VERIFICATION_ALLOWED_REPOSITORIES`,
`JENKINS_BASE_URL`, `JENKINS_JOB_NAME`, `JENKINS_USERNAME`, `JENKINS_TOKEN`, and
`JENKINS_TOKEN_EXPIRES_AT`. The live test also has no configured
`QUINCY_JENKINS_URL`, `QUINCY_JENKINS_JOB`, `QUINCY_JENKINS_USERNAME`,
`QUINCY_JENKINS_TOKEN`, passing/broken/cancel repository URLs, or corresponding
commit SHAs. Schrift is not installed by the checked-in Quincy `Dockerfile`,
which packages Gitleaks, Trivy, and OSV Scanner; staging has no configured
Schrift executable. No live Jenkins build or manifest was requested or
fabricated.

Bankai stores its application state through `SUPABASE_URL` and related
Supabase variables. Railway's `Postgres` service is Quincy’s database; it is
not a verified target for Bankai's Supabase migrations. The Supabase values are
not readable through the connected Railway account, and this checkout has no
linked Supabase project configuration. `psql` is unavailable. Consequently
the staging database identity/schema, migration compatibility, backup/rollback
readiness, and SQL trigger execution could not be verified. Migrations
`20261115100000`, `20261115110000`, and `20261115120000` were **not applied**.
Static review found additive tables/guards and no row deletion, but the final
migration also rewrites the existing transition function and has no tested
down migration; static review is not database validation.

Current local regression results: Bankai Quincy manifest/workflow/state tests
**47 passed** across 3 files; Bankai typecheck and lint **PASS**. Quincy
verification manifest/API/worker/Jenkins/Schrift tests **88 passed, 1 skipped**
with one existing collection warning. These are local code tests, not live
service or database evidence. Cross-product passing/failing fixtures, a real
Jenkins execution, manifest retrieval/digest verification, Bankai restart
recovery, and staging migration checks remain **BLOCKED**. No Railway
configuration, deployment, database, Git remote, or production service was
changed.

**Final staging acceptance: SCRUM-29 and SCRUM-34 remain Not Done.** Required
Jenkins credentials/configuration, allowlisted disposable fixtures, packaged
Schrift, and a verifiable Bankai staging PostgreSQL/Supabase migration target
must be available before these acceptance gates can be completed.

## Local Jenkins fixture follow-up — 2026-11-16

Created the approved public synthetic repository
`https://github.com/anubhavgpta/quincy-scrum-29-verification-fixture` with no
secrets or real project data. Its branches resolve to:

- `known-vulnerable`: `3eb3e44364ccd71044c013058f4ee57147174370`
- `main` (fixed candidate): `81fd73b662dccda21605ce038d5e69873db4b4bd`
- `known-failing` (compile failure): `97033d4a32551f151c066b1a26a90d6d7261c92e`
- `cancel-workload`: `87f4cb7578081c48c2fb3a480028ae84c3c6559c`

Both build and test passed on the vulnerable baseline and fixed candidate. The
Quincy live Jenkins acceptance suite then passed against the local Docker
Jenkins controller: **2 passed** in 42.70 seconds. It exercised a successful
build, a failed build, cancellation, artifact retrieval, and cleanup evidence.
This is real local Jenkins evidence, not Railway staging or Bankai-to-Quincy
cross-product evidence. Staging settings and Bankai database/migration blockers
above remain unchanged.
