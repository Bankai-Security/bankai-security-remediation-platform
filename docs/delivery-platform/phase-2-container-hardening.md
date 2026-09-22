# Phase 2 — Container hardening

Status: complete and stopped for review on 2026-09-20. No registry, AWS,
Terraform, or deployment resources were created or changed.

## Delivered artifacts

### Bankai backend

- Both Docker stages use the same digest-pinned Node 22 Alpine base.
- The runtime stage contains production dependencies and compiled JavaScript
  only. npm/npx and the npm package tree are removed after installation.
- The image runs as fixed UID/GID `10001:10001`, declares `SIGTERM`, and has a
  `/healthz` Docker health check.
- The default API command remains `node dist/server.js`; the same image was
  started successfully as the worker with `node dist/worker.js`.
- The container test starts Redis, the API, and the worker and verifies both
  processes run as UID 10001.
- Multer was moved from 2.2.0 to 2.3.0 because the release scan found three
  fixed High-severity advisories in 2.2.0.

### Quincy

- Both Docker stages use a digest-pinned Python 3.12 slim base.
- A build stage creates an offline wheelhouse. The runtime stage installs from
  that wheelhouse and does not contain the source tree, compiler, or Python
  build frontend.
- Runtime tools intentionally retained are `docker.io`, Git, curl, and CA
  certificates: the same artifact is the API image and the privileged
  CodeBuild job-worker image, whose documented contract requires Docker CLI
  access and repository checkout.
- The image runs as fixed UID/GID `10001:10001`, declares `SIGTERM`, and keeps
  the `/health` Docker health check.
- The production image build/start integration test asserts the non-root user
  and public health contract.

### Frontend

- `npm run build:verify` performs two clean builds and hashes sorted relative
  paths plus file bytes. Both builds produced
  `sha256:776ce013288ea4121d87fc218b81b8622d969d64fce0bcc4ef646df54e40abcb`.
- The build and local nginx images use digest-pinned bases.
- Railway's IPv6 resolver and `backend.railway.internal` name were removed.
  Local Compose uses Docker's `127.0.0.11` resolver and the `backend` service
  name. AWS deployment will publish `dist/` to S3/CloudFront and route API
  traffic through AWS infrastructure; it does not depend on this nginx image.
- The local frontend image builds and `nginx -t` passes even when the backend
  is not running.

## Security and release gates

Each repository has a portable `container-security-gate.sh`. It rejects
`:latest`, records Docker inspection metadata, emits Syft JSON and CycloneDX
JSON SBOMs, scans the image with Trivy, scans committed Git history with
Gitleaks, retains JSON reports, and then blocks on:

- any fixable `HIGH` or `CRITICAL` image vulnerability;
- any image secret found by Trivy;
- any committed secret found by Gitleaks.

Scanner images are themselves immutable:

| Tool | Pinned image digest |
| --- | --- |
| Syft v1.42.3 | `sha256:5999d209a342e55e9edf70bf8930fb5b86d8f2a783fa401178372c50e21b1d36` |
| Trivy v0.74.0 | `sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969` |
| Gitleaks v8.30.1 | `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f` |

Quincy's Gitleaks configuration extends the default rules and permits only six
exact synthetic credential strings used by its redaction tests. It does not
exclude a path or a rule, so unrelated credentials in those test files still
fail the gate.

`verify-release-reference.sh` rejects deployment references unless they use
`repository@sha256:<digest>`. CI must tag a build with the Git commit SHA, push
it once to immutable ECR, obtain the registry digest, run this verifier, and
pass only the digest reference to Terraform/ECS. A mutable SHA-shaped tag is
metadata, not the deployment identity.

## Verification evidence

Final local content identifiers (not registry release digests):

| Artifact | Local image ID |
| --- | --- |
| Bankai API/worker | `sha256:f5638cbff832a16b05521d929029112b45de653cacecd7f7841e09ad7990cb8b` |
| Quincy API/job worker | `sha256:02674d6884ee404264b149229c7e20279f65986b54d0ed050416596d08bbf7c8` |

Evidence is stored outside the Git working trees under the Phase 2 artifact
directory. Each application directory contains native and CycloneDX SBOMs,
Trivy JSON, redacted Gitleaks JSON, Docker inspect JSON, and digest metadata.

Validation completed:

- Bankai backend: 122 unit tests; typecheck, lint, and production build pass.
- Bankai container: 2 tests pass (API health/Redis plus same-image API/worker
  non-root verification).
- Frontend: two clean production builds are byte-for-byte deterministic; the
  pinned local container builds and nginx configuration validates.
- Quincy: Ruff passes; strict mypy passes for 175 source files; the hardened
  container builds and its non-root `/health` integration test passes.
- Final Trivy gates: zero fixable High/Critical vulnerabilities and zero image
  secrets for Bankai and Quincy.
- Final Gitleaks gates: zero findings in both committed histories after the
  reviewed exact-value Quincy test-fixture exceptions.
- Both shell gate scripts pass `sh -n`; a valid ECR-style digest reference is
  accepted by the immutable-reference verifier.

The Dockerfiles accept no secret build arguments, and no secret values were
present in build history or build logs. Runtime credentials remain runtime
environment/secret-store inputs for later infrastructure phases.

## Review notes and deferred work

- The repositories do not yet have dependency lock strategies that are fully
  independent of their package indexes: npm lockfiles are exact, while Quincy
  still resolves its bounded Python requirements during the wheel-build stage.
  A Python lockfile is recommended before the Jenkins release pipeline is
  enabled.
- Registry digests cannot be final until Phase 8 pushes commit-SHA-tagged
  images to immutable ECR. The digest-only verifier prevents local image IDs or
  tags from being substituted at deployment time.
- Quincy intentionally retains Docker CLI and Git in runtime because its
  CodeBuild worker contract needs them. Splitting API and job-worker artifacts
  would reduce the API image further but would violate the current same-image
  operational design and is not required by this phase.
- Phase 3 must not begin until this phase is reviewed.
