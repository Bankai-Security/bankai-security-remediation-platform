# Phase 7 — Non-production AWS deployment

Status: source implementation complete on 2026-09-21. Live deployment is
blocked intentionally because `infrastructure/config/nonprod.json` still
contains placeholder account, DNS, certificate, WAF, Jenkins, GitHub, and SSH
values. No AWS, Jenkins, ECR, S3, CloudFront, ECS, GitHub, or Datadog resource
was changed while implementing this phase.

## Release contract

`bankai-nonprod-release` is a dedicated Jenkins pipeline job. A successful
`bankai/main` build triggers it; the job checks out the exact Bankai main head
and exact Quincy main head on a single-use `trusted-docker` agent. It then:

1. verifies the AWS caller account and rejects committed placeholders;
2. reruns Bankai and Quincy quality gates;
3. builds each service image once and retains the verified local image;
4. uses the already-built reproducible frontend output as one release artifact;
5. assumes the short-lived ECR publishing role, pushes SHA tags to immutable
   repositories, and resolves registry digests;
6. synthesizes `Bankai-nonprod-Foundation` with those exact digests and retains
   the cloud assembly;
7. asks CDK to prepare (not execute) one named CloudFormation change set;
8. archives the property-level change set and rejects every removal and every
   true or conditional replacement;
9. executes only that reviewed change-set ID and waits for the stack;
10. waits for Quincy, API, and worker ECS services in dependency order;
11. uploads the frontend to a versioned release prefix, promotes the same files
    to the origin root, and invalidates CloudFront;
12. checks the public API health contract and frontend boot document;
13. stores a release manifest in Jenkins and the versioned S3 release prefix,
    then sends a Datadog deployment event.

The manifest records Bankai and Quincy Git SHAs and ECR digests, frontend
artifact path and SHA-256, Jenkins build URL, CDK Git SHA, reviewed change-set
ID, AWS account, region, environment, and UTC timestamp. Failed gates, uploads,
waiters, smoke checks, or telemetry calls fail the build. Existing ECR images,
S3 versions/release prefixes, CloudFormation rollback, and prior manifests are
left intact for rollback.

## One-time activation prerequisites

Do not enable the upstream release trigger until all items are true:

- replace every placeholder in `infrastructure/config/nonprod.json` except the
  two application image digests, which the release supplies as CDK context;
- configure the real non-production account, Route 53 zone, regional API and
  Jenkins ACM certificates, us-east-1 CloudFront certificate and WAF ACL;
- configure the reviewed digest-pinned Jenkins controller image, GitHub App ID,
  exact Ed25519 agent host public key, repository names, and trusted role ARN;
- create the documented Jenkins/GitHub/Datadog/agent secrets in Secrets Manager
  and apply their credential-discovery tags where required;
- bootstrap the non-production account/region with the modern CDK bootstrap
  stack and confirm its deploy, file-publishing, image-publishing, and lookup
  roles use the standard `hnb659fds` qualifier;
- deploy/upgrade the Phase 3–4 foundation through a separately reviewed initial
  change set using `-c initialProvisioning=true`; this creates the ECR
  repositories, Jenkins controller, release roles, and
  `Bankai-nonprod-Foundation` stack while holding the API, worker, and Quincy
  ECS services at zero tasks until immutable images have been published;
- confirm the backend and Quincy runtime secrets exist and that DNS/certificates
  are valid before the first application update;
- run `npm run validate:release`, `npm run build`, and `npm test -- --runInBand`
  from `infrastructure/`.

The existing-stack prerequisite is deliberate: application images cannot be
pushed before their ECR repositories exist, so initial foundation provisioning
is not hidden inside the application release.

For an existing pre-Phase-3 non-production stack, pin the currently deployed
ECR tags to their resolved immutable digests before migration. Preserve the
existing Quincy access-point UID/GID 1000 during that in-place upgrade; moving
the access point and stored data to UID/GID 10001 requires a separately
reviewed data migration and must not be combined with Jenkins activation.

## Review and recovery

Release evidence is under `release/` in the Jenkins archive and under
`s3://<frontend-bucket>/releases/<release-id>/`. To roll back, select a prior
manifest, synthesize with its recorded image digests, review a new change set,
execute it, wait for ECS stability, promote that release's frontend files, and
invalidate CloudFront. Never retag an image or mutate a prior manifest.

The policy is intentionally stricter than CloudFormation: even conditional
replacement fails and requires a separately authorized migration.
