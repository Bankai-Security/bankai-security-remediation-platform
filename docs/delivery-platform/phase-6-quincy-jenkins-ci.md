# Phase 6 — Quincy Jenkins CI

Status: source implementation complete and stopped for review on 2026-09-20.
No Jenkins, AWS, GitHub, Datadog, registry, or deployment environment was
changed.

## Outcome

The Quincy repository now has a 13-stage PR `Jenkinsfile` running on the
single-use, credential-free `pr-container` fleet. Docker-backed integration
tests can control only their disposable host; the pipeline cannot select the
release-authorized `trusted-docker` fleet, load Jenkins credentials, assume a
release role, or deploy.

Stages are ordered as required: checkout/metadata, hash-locked dependencies,
Ruff, mypy, unit tests, component tests, Docker integration tests, image build,
health verification, vulnerability scan, secret scan, SBOM generation, and
report publication.

## Implementation

- Added a static Jenkinsfile policy validator covering all 13 stages and
  forbidden deploy, credential, trusted-agent, and failure-masking constructs.
- Added Python 3.12 to the CDK-managed Jenkins agent bootstrap.
- Added a Python 3.12/Linux `pylock.toml` for CI/development and a separate
  `pylock.prod.toml` for the runtime image. Both contain exact artifact hashes.
- Updated the production Dockerfile to build exclusively from the production
  lock. Quincy itself is built from the checked-out source with dependency
  resolution disabled.
- Split the deterministic test runner into unit, component, and Docker-backed
  integration partitions. JUnit is parsed after each successful run and any
  skip fails a `--fail-on-skip` gate.
- Added a real component test for FastAPI lifecycle, SQLite initialization,
  public health, and the service-token boundary.
- Reused the production image for the dedicated health stage instead of
  silently rebuilding it.
- Split the pinned container-security helper into independently reportable
  vulnerability, secret, and SBOM modes while retaining the combined mode.

All integration inputs are local synthetic fixtures committed under Quincy’s
tests. The network-marked knowledge-ingestion checks are deliberately excluded
from PR validation and are not counted as skipped integration tests. No test
loads `.env`, a production repository, or a production secret.

## Validation results

- Static Jenkinsfile policy: passed; 13 stages in order and no forbidden
  construct.
- Clean Python 3.12/Linux install from `pylock.toml`: passed with hash
  enforcement; `pip check` reported no broken requirements.
- Ruff: passed.
- Strict mypy: passed for 178 source files.
- Unit partition: 688 passed, zero skipped; five integration-marked tests were
  deselected into the integration partition. Coverage was 87%.
- Component partition: 1 passed, zero skipped.
- Docker integration partition: 18 passed, zero skipped; 692 non-integration
  tests were deselected. Coverage was 65%.
- Final production-only locked image: built successfully as
  `quincy-service:phase6-validation` for local validation.
- Final `/health` test: 1 passed; image runs as UID/GID `10001:10001`.
- Digest-pinned Trivy: zero fixed High/Critical vulnerabilities and zero image
  secret findings.
- Digest-pinned Gitleaks: 51 commits and about 1.39 MB scanned; no leaks found.
- Digest-pinned Syft: Syft JSON and CycloneDX JSON SBOMs generated.
- Jenkins foundation formatting/build: passed.
- CDK assertions: 14/14 passed.
- Jenkins JCasC validation: passed with 17 pinned plugins and two multibranch
  jobs.
- Deterministic synth: non-production SHA-256
  `188b420e9a5d98b08c440da31c0f11373dd4e2f4027a7e4ab41ebe302c1b64fc`;
  production SHA-256
  `a2fddf7cbb5297db76a88b369ab3862de0a5e2e982748c4644879421e1ed2764`.

Existing pytest collection and SQLite resource warnings remain non-fatal and
were present in the existing suite. They should be cleaned up, but no test was
failed or skipped by them.

Security evidence is retained in the task artifact directory under
`phase6/container-security`. JUnit and coverage evidence is under Quincy’s
ignored local `reports` directory and will be archived by Jenkins per build.

## Runtime checks still pending

- A real Quincy pull request triggers the multibranch job and reports status to
  GitHub.
- All 13 stages execute on a newly provisioned `pr-container` agent.
- An intentional Ruff, mypy, pytest, or scanner failure blocks the required
  GitHub check.
- Jenkins exposes JUnit, coverage, scanner, and SBOM artifacts.
- The agent terminates after one build and cannot read publishing, deployment,
  or production credentials.
- Datadog receives Quincy pipeline and test visibility telemetry.

These checks need the reviewed Phase 4 foundation, GitHub App, Jenkins, and
Datadog to be live. They are not represented as passed.

## Risks and rollback

`pip lock` and consuming `pylock.toml` are marked experimental by pip 26.2.1.
The pipeline pins that pip version, validates all hashes, and keeps CI and
runtime locks separate, but upgrades require an explicit lock regeneration and
clean Linux validation.

Pull-request code controls Docker on its disposable agent. The security boundary
is the credential-free PR role, private host, one-build lifetime, and strict
separation from `trusted-docker`. Never grant this fleet ECR write, deployment,
CloudFormation mutation, or production role-assumption authority.

Rollback is source-only: revert Quincy’s Jenkinsfile, locks, test-runner,
component/health tests, Dockerfile, and security helper; then remove Python 3.12
from the agent bootstrap if no other job requires it. Re-run the Phase 4 CDK
build/assertions/deterministic synth. No cloud rollback is needed because
nothing was deployed.

## Review gate

Phase 6 source implementation is ready for review. Stop here; do not begin
Phase 7 and do not deploy without explicit authorization.
