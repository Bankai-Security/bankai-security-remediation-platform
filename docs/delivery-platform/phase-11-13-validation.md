# Phase 11–13 validation record — updated 2026-10-28

## October 28 continuation

- Disk blocker resolved (approximately 6.7 GiB available at resume).
- Authenticated AWS checks confirm nonproduction UPDATE_COMPLETE and all 34
  Bankai operational alarms OK. Managed target-tracking low alarms are expected
  scale-in signals and are recorded separately in the alarm audit.
- Deterministic synthesis passed for both stages; Jenkins/native observability
  validators passed; CDK tests 23/23; release/promotion policy tests 29/29.
- Promotion verification now binds exact repository/account/digest to each API,
  worker and Quincy container rather than accepting a digest anywhere in a task.
- Authenticated Jenkins UI confirms release build 40 SUCCESS. Downloaded 42-file
  archived bundle and verified frontend SHA-256 against the retained manifest.
  The schema-v1 manifest and null smoke identity prohibit promotion under the new
  contract; no historical evidence was relabeled or fabricated.
- Nightly full E2E build 50 FAILED, following failures since October 21. Logs show
  Quincy detects BANKAI-E2E-001 but OpenRouter assessment returns HTTP 401, User
  not found. Bankai fallback also receives 401 and incorrectly records success
  with zero findings. This is a release blocker despite healthy infrastructure.
- Fixed fallback analysis to throw after exhausted request/response validation
  retries, preventing incomplete assessments from becoming successful scans.
  Backend tests 131/131, typecheck and lint passed. Fix is local, not deployed.
- Operator updated OPENROUTER_API_KEY in bankai/nonprod/backend. API, worker and
  Quincy were rolled without changing images/task definitions; all stabilized.
  Full Jenkins E2E build 51 was triggered, but is waiting for an executor.
  EC2 rejected the c7g.large agent: applied Standard On-Demand vCPU quota is 1,
  while the existing m7g.large controller alone uses 2. No OpenRouter success
  has been demonstrated after rotation yet.
- Requested EC2 quota 4; AWS rejected it because requests must exceed default 5.
  Request c9084877322a4022a5e6f7c227b66c015qFOOsmW for 6 vCPUs is PENDING.
  Fleet limits were not changed. AWS approval is an external dependency.
- Organization CloudTrail reports IsLogging=true and successful recent S3,
  CloudWatch Logs and digest delivery. Budget observed actual USD 275.374.
- Two operational metric-overlap groups found: legacy/native ALB 5xx and
  unhealthy targets. Periods/evaluation/actions differ; no alarms retired.
- Operator confirmed no separate nonproduction Supabase project and could not
  identify a local backup/version. No matching backup was found in Downloads.
  [Isolated restore runbook](../runbooks/supabase-restore-drill.md) documents the
  local alternative and required evidence. No source database was restored.
- Public GitHub commit checks confirm both GitHub Actions frontend/backend and
  Jenkins checks on main. Branch protection and deliberate failing-PR enforcement
  remain unverified; duplicate workflow was preserved.
- Supabase isolated restore target remains unidentified. Production prerequisites,
  current full E2E, application restore, rollback drill, independent promotion
  approval and authoritative CI cutover remain incomplete.

Evidence: reports/readiness/2026-10-28/, particularly jenkins-evidence-review.json,
build-40-bundle/, e2e-50-scan-events.json, e2e-50-quincy-error.json,
alarm-overlap-audit.json, trail-status.json and the validation logs.

## Current status

All three phases remain PARTIAL. The findings below supersede the historical
2026-10-19 record retained later in this document. AWS observations are dated
2026-10-21 and must not be treated as fresh checks on October 28.

- Nonproduction change set bankai-readiness-20261021-01 executed successfully:
  76 changes, no resource removals, deployed build-40 image digests preserved.
  Stack reached UPDATE_COMPLETE; API/worker task revision 29 and Quincy revision
  26 reached COMPLETED with desired/running counts 1/1.
- Native monitoring, encrypted SNS, memory scaling, job-bucket versioning,
  Quincy EFS automatic backup and retention protections are deployed.
  All 34 Bankai alarms were OK. SNS admin@bankaisecurity.com subscription was
  confirmed; CloudWatch recorded successful SNS publishing afterward.
- Monthly account budget is USD 50. Latest observed actual spend was USD 211.499
  on October 21. The user allowed temporary spend for nonproduction validation;
  this is not a hard spending cap or a production-spend approval.
- CloudFormation drift detection ed03ca90-cd5c-11f1-b94a-0affec1395ad completed
  IN_SYNC with zero detected drift. This does not prove absence of orphaned
  resources or duplicate deployments.
- Synthetic S3 version recovery passed with identical SHA-256, preserving the
  current source version: measured restore/read verification 4.666 seconds,
  synthetic watermark gap 3.243 seconds. This is not database recovery evidence.
- EFS restore job b11e419a-fc16-452b-8eb1-93e85262fd1f completed into encrypted
  fs-0a2e49a860ddf2af5, preserving source fs-02c0fefc7f13112c4. Read-only validation
  found 5,791 files, five Jenkins jobs and parseable Jenkins configuration.
  Filesystem was unmounted afterward. Jenkins boot/login, credential decryption
  and complete application recovery were NOT tested; full RTO/RPO remains open.
  Restore filesystem, mount target and dedicated restore role remain retained.
- Production read-only access to account 643681121175 succeeded. Inventory found
  no Bankai-production-Foundation stack, application secrets, certificates in
  ap-south-1/us-east-1, hosted zones or CloudFront WAF ACLs. An organization
  Control Tower trail exists; logging delivery still needs verification.
  Fargate on-demand quota was 8 vCPU, below rolling-deployment headroom for the
  configured production baseline. No production mutation occurred.
- Backend: 125 unit, 4 integration, 4 Redis component and 2 container tests passed.
  Frontend: 32 tests passed. Release/promotion policy: 26 tests passed.
  Rebuilt backend image: zero fixable HIGH/CRITICAL findings under the configured
  Trivy gate, zero detected secrets; Syft/CycloneDX SBOMs generated.
  This does not certify the unchanged deployed build-40 images or Quincy image.
- Dependency audits after compatible fixes: frontend zero, backend three moderate,
  infrastructure nineteen moderate. No risk acceptance has been inferred.
- Promotion smoke evidence now requires each named check exactly once and binds
  release ID, Bankai/Quincy source SHAs and Jenkins build to the manifest.
- October 21 final local checks were blocked by disk exhaustion. October 28 has
  approximately 6.7 GiB free; deterministic synthesis and validators are rerunning.
  AWS SSO renewal is pending. No commit or push has been made.

Evidence: reports/readiness/2026-10-21/ contains change-set-review.json,
stack-after.json, services-after.json, alarms-after.json, drift-status.json,
efs-restore-validation.json, s3-restore/result.json, production-inventory/,
backend-image-vulnerabilities.json, backend-image-secrets.json and backend-sbom.*.
Some files written during disk exhaustion may be incomplete; validate before use.

## Remaining phase gates

| Phase | Status | Remaining work |
| --- | --- | --- |
| 11 | PARTIAL | Full restore/rollback drills, Supabase recovery environment, production prerequisites and least-privilege roles, remaining security findings, current live verification |
| 12 | PARTIAL | Successful immutable runtime-config release bundle, production prerequisites/configuration, independent approval role, reviewed target plan, approved apply and smoke evidence |
| 13 | PARTIAL | Jenkins required-check proof, duplicate deployment/alarm audit, orphan/ownership review, deliberate workflow cutover and rollback record |

## Historical record — October 19 (superseded)


## Final phase status

| Phase | Status | Remaining gates |
| --- | --- | --- |
| 11 readiness | **PARTIAL** | Live IAM/secrets/TLS/backup/quota/audit inventory, native monitoring deployment and notification tests, restore/rollback drills, unresolved scans/findings |
| 12 promotion | **PARTIAL** | Actual successful release bundle, environment-neutral frontend, real production config, independent approval broker, saved production plan and executable apply/smoke/rollback flow |
| 13 cutover | **PARTIAL** | Jenkins required-check proof, duplicate/orphan/drift audit, ownership record and validated alarm retirement |

No phase is COMPLETE. AWS implementation and evidence are **BLOCKED**. No AWS
resource was created, updated or deleted; no production apply was attempted.

## Local verification

| Check | Observed result |
| --- | --- |
| Backend typecheck/lint/build | PASS |
| Backend unit | PASS: 125 tests, 21 files |
| Backend API integration | PASS: 4 tests |
| Backend Redis component | BLOCKED/failed suite: no working container runtime; 4 tests skipped |
| Backend image health | BLOCKED/failed suite: no working container runtime; 2 tests skipped |
| Frontend lint/tests | PASS: 24 tests; existing lint warnings |
| Frontend reproducible build | PASS: sha256:776ce013288ea4121d87fc218b81b8622d969d64fce0bcc4ef646df54e40abcb |
| CDK build/assertions | PASS: 23 tests, including native filters, retained images, production trust deny |
| Synth nonprod/production | PASS, local placeholder configuration only |
| Deterministic synth | PASS for both environments; latest hashes retained in validation log |
| Template static policy | PASS on both emitted templates; this is not a full IaC security scan |
| Formatting | PASS |
| Jenkins PR/release/E2E/observability static policies and JCasC | PASS; 16 pinned plugins |
| Release policy tests | PASS: 13 |
| Promotion verifier tests | PASS: 9, including altered artifacts, failed smoke, wrong account and legacy manifest rejection |
| Offline E2E harness | PASS: 2 tests; no live E2E run here |
| Jenkins server-side Declarative linter | BLOCKED: authenticated Jenkins endpoint/session unavailable |
| Git whitespace check | PASS; line-ending notices only |
| Quincy independent repository tests | NOT RUN; this workspace contains patches/fixtures, not the selected release checkout |

Raw local evidence is in ignored `reports/readiness/validation/`; synthesized
definitions are in `reports/readiness/cdk-nonprod/` and `cdk-production/`.
These local files are not durable release evidence until archived by Jenkins or
copied to an approved versioned evidence store. No account/resource ID was
invented to fill missing live evidence.

Final deterministic template hashes:

- nonprod: `sha256:51dd6a9130e52ce7ae48b95fcf70ae256f63cb4c8290aad40dc9f2fb6878611b`
- production: `sha256:b629ae6302c26e576c3cb933cedf79c35e5250e80551c03f8430cf261439b341`

## Security scan results

After the user explicitly approved sending dependency metadata to the npm
registry, all three `npm audit --json` calls returned vulnerability reports:

| Package | Moderate | High | Critical | High findings |
| --- | ---: | ---: | ---: | --- |
| backend | 9 | 2 | 0 | nanoid, source-map-js |
| frontend | 2 | 5 | 0 | nanoid, postcss, react-router, react-router-dom (propagated), source-map-js |
| infrastructure | 19 | 1 | 0 | brace-expansion |

Counts include development dependencies and transitive/propagated findings;
they are not counts of independently exploitable runtime vulnerabilities.
No blanket risk acceptance or `audit fix --force` was applied. Review reachable
code paths and upgrade compatible locked versions, then rerun the full release
gates before promotion. The React Router advisory concerns RSC behavior, so the
frontend's actual usage must be checked before assigning runtime exposure.
Machine-readable findings: `reports/readiness/validation/dependency-summary.json`;
raw responses: `dependency-audits-approved.log`.

Container vulnerability/secret scans, Gitleaks history scan, Trivy IaC/image
scan and SBOM rebuild remain BLOCKED by missing Docker engine and local scanner
binaries. Existing pinned Jenkins scan stages remain required; passing unit or
template tests does not substitute for these scans. The repository cannot yet
be certified free of long-lived credentials or vulnerable images.

## Live blockers and recovery evidence

- Sandbox AWS identity: **NoCredentials** (saved in
  `reports/readiness/session-2026-10-19/identity.json`).
- Outside-sandbox identity retry: **InvalidClientTokenId — The security token
  included in the request is invalid**. Refresh approved short-lived credentials.
- Docker: `//./pipe/docker_engine` not found; Docker config also inaccessible
  to sandbox user. Start the Linux engine and rerun on an authorized agent.
- Restore evidence: **NOT RUN**, no recovery point/restore job or measured
  RPO/RTO available. Procedure is in the operations runbook.
- Rollback evidence: **NOT RUN**, no change-set execution or measured recovery
  duration available. Do not substitute Jenkins build #17 for a rollback drill.
- Production configuration, SNS recipient/budget amount, real artifact bundle,
  Supabase backup access and independent approval role remain operator inputs.

## Preserved state

Pre-existing server.ts/worker.ts edits and e2e-fixture-repo were not edited by
this task. Historical Phase 0–10 documents and existing alarms remain. Retired
Datadog sidecar log groups keep their construct identities and RETAIN policy;
their historical data must survive agent retirement. No GitHub workflow was
disabled without verifying its replacement required check. No commit or push
was made.
