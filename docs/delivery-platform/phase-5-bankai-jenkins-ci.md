# Phase 5 — Bankai Jenkins CI

Status: source implementation complete and stopped for review on 2026-09-20.
No Jenkins, AWS, GitHub, Datadog, registry, or deployment environment was
changed.

## Outcome

The repository-root `Jenkinsfile` defines the required 22 ordered PR validation
stages. The entire build runs on a single-use `pr-container` EC2 agent so Docker
component tests and image gates share one workspace without exposing release or
deployment roles. The pipeline cannot deploy, assume a release role, or load a
Jenkins credential.

Failures are terminal. Test stages always publish JUnit evidence; infrastructure
and container scanners archive JSON reports; the final stage archives all build,
test, synth, scan, and SBOM evidence. There is no `catchError`, `returnStatus`,
`|| true`, mutable scanner tag, or conditional stage skip.

## Stage contract

1. Checkout and metadata
2. Install locked dependencies
3. Backend typecheck
4. Backend lint
5. Backend unit tests
6. Backend component tests
7. Backend integration tests
8. Backend production build
9. Frontend lint
10. Frontend unit and component tests
11. Frontend production build
12. CDK formatting and compilation
13. CDK tests
14. CDK synthesis
15. Infrastructure security scan
16. Bankai image build
17. API container health test
18. Worker container startup test
19. Container vulnerability scan
20. Secret scan
21. SBOM generation
22. Publish reports

The supporting additions are a static Jenkinsfile policy validator, backend
HTTP integration suite and JUnit scripts, an environment-selectable container
test image, and a recursive infrastructure formatting check.

## Validation results

- Jenkinsfile policy: passed; exactly 22 required stages and no deploy,
  credential-loading, trusted-agent, or failure-masking constructs.
- Backend locked install: passed (408 packages).
- Backend typecheck and lint: passed.
- Backend unit suite: 122/122 passed.
- Backend component suite: 4/4 passed against a real disposable Redis container.
- Backend integration suite: 2/2 passed using the native HTTP boundary.
- Backend TypeScript production build: passed.
- Frontend locked install and lint: passed; lint retained 17 existing non-fatal
  React hook/Fast Refresh warnings.
- Frontend unit/component suite: 24/24 passed.
- Frontend production build reproducibility: passed with SHA-256
  `776ce013288ea4121d87fc218b81b8622d969d64fce0bcc4ef646df54e40abcb`.
- Infrastructure formatting and compilation: passed for 12 checked source files.
- CDK assertions: 14/14 passed.
- Jenkins configuration validation: passed with 17 exact plugin pins and two
  multibranch jobs.
- Deterministic synth: passed. Non-production SHA-256 is
  `188b420e9a5d98b08c440da31c0f11373dd4e2f4027a7e4ab41ebe302c1b64fc`;
  production is
  `a2fddf7cbb5297db76a88b369ab3862de0a5e2e982748c4644879421e1ed2764`.
- Final non-production and production templates passed completeness, secret,
  mutable-image, sensitive-output, and wildcard-IAM validation.
- Bankai production image built successfully. API and worker container tests:
  2/2 passed.
- Digest-pinned Trivy gate: zero High/Critical fixed vulnerabilities and zero
  image-secret findings.
- Digest-pinned Gitleaks: 51 commits and about 2.37 MB scanned; no leaks found.
- Digest-pinned Syft generated both Syft JSON and CycloneDX JSON SBOMs.

Local security evidence is under the task artifact directory
`phase5/container-security`; final CDK assemblies are under `phase5/release`.
Jenkins will retain equivalent evidence per build.

## Operational activation

Jenkins and Datadog do not need to be live to merge or review this source phase.
They are required to prove the runtime exit criteria. Before enabling branch
protection, deploy the reviewed Phase 4 foundation, install/configure the GitHub
App and secrets described there, confirm all `pr-container` agents join with
exact SSH host-key verification, and verify Datadog CI Visibility receives a
harmless test build.

Then configure the Bankai repository's required check to the actual Jenkins
multibranch status context. Do this only after observing its exact name from a
real PR; guessing the context can lock every PR out of merging.

## Remaining runtime checks

- A Bankai pull request triggers this Jenkinsfile automatically.
- All 22 stages execute in order on a fresh `pr-container` agent.
- A deliberately failing test blocks the GitHub required check.
- JUnit, synth, scan, and SBOM artifacts are downloadable from Jenkins.
- The disposable agent terminates after the build and cannot access release or
  production credentials.
- Datadog shows the pipeline, stages, test visibility, and forwarded build logs.

These checks are pending because this task made no deployment and had no
external credentials. They are not represented as passed.

## Risks and rollback

Pull-request code can control its disposable Docker host for one build. The
security boundary is therefore the credential-free PR instance role, private
network placement, single-use termination, and absolute separation from
`trusted-docker`; do not attach registry-write or deployment authority to this
fleet.

The CDK synth still emits the previously documented CloudFront OAC wildcard-key
annotation and non-production desired-capacity annotations. Neither blocks the
source gate, but both require review before deployment.

Rollback is source-only: remove the root Jenkinsfile and Phase 5 support files,
then revert the Phase 4 third-fleet/GitHub-App/host-key additions if Phase 5 is
not retained. Re-run the Phase 3/4 build, assertions, deterministic synth, and
protected-resource comparison. No cloud rollback is required because nothing
was deployed.

## Review gate

Phase 5 source implementation is ready for review. Stop here; do not begin
Phase 6 and do not deploy until the remaining Phase 4 runtime prerequisites and
Phase 5 live checks are explicitly authorized.
