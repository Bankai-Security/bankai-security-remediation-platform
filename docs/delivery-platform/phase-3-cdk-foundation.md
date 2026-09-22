# Phase 3 — AWS CDK foundation

Status: complete and stopped for review on 2026-09-20. No AWS API changed
infrastructure, no CloudFormation change set was created, and `cdk deploy` was
not run.

## Phase 0–2 verification

The previously delivered application and artifact foundations were verified
before the CDK changes:

- Bankai backend: 122 unit tests, 4 Redis component tests, and 2 production
  container tests passed. TypeScript typecheck, oxlint, and build passed. The
  container tests prove `/healthz`, Redis connectivity, the API command, the
  worker command, and UID 10001 from the same image.
- Bankai frontend: 24 tests passed; lint exited successfully with the existing
  Fast Refresh and hook-dependency warnings; two clean builds reproduced
  `sha256:776ce013288ea4121d87fc218b81b8622d969d64fce0bcc4ef646df54e40abcb`.
- Quincy: Ruff and strict mypy passed; 688 unit tests passed, 5 were explicitly
  skipped, and coverage was 87%; 13 Docker-backed integration tests passed and
  3 live-network tests were deselected by policy. The integration suite rebuilt
  the image and verified its non-root `/health` contract.
- The pinned Trivy v0.74.0 image-secret gate passed for both rebuilt images.

The Quincy unit suite still emits its pre-existing unclosed SQLite connection
resource warnings and `TestRunResult` collection warnings. They did not fail
the established quality gate and were not redesigned in this infrastructure
phase.

## CDK organization and configuration

The original `Bankai-<stage>-Foundation` stack boundary and resource construct
IDs were retained. Splitting already-managed resources into new top-level
stacks would change CloudFormation ownership and cause replacements, so Phase 3
separates concerns inside the existing stack and through typed configuration.

`config/nonprod.json` and `config/production.json` now independently define:

- account and region;
- VPC CIDR and NAT count;
- API/frontend domains, hosted zone, certificate ARNs, and CloudFront WAF ARN;
- exact Bankai and Quincy image digests;
- service counts and Fargate CPU/memory;
- log and ECR retention;
- ElastiCache node, replica, and snapshot settings;
- cost-center tagging.

Every value is context-overridable. The loader rejects non-digest image inputs,
same-account production defaults, invalid account IDs, unsupported retention,
and non-us-east-1 CloudFront certificate/WAF identifiers. Committed ARNs,
accounts, and zero digests are synthesis-only placeholders and must be replaced
from the reviewed Jenkins release/environment configuration.

The static availability-zone context makes synthesis deterministic and removes
AWS lookup calls.

## Infrastructure properties

- Existing public and isolated subnets retain their logical IDs. New private
  application subnets and NAT gateways host ECS tasks and CodeBuild ENIs.
- Bankai API, worker, Quincy, and non-production Redis have no public IPs.
  Only the Bankai ALB is internet-facing. Quincy accepts port 8000 only from
  Bankai's application security group and remains on private Cloud Map DNS.
- ECR repositories retain their original logical IDs, immutable tags,
  scan-on-push, encryption, and environment-specific retention.
- ECS image definitions and Quincy CodeBuild use ECR
  `repository@sha256:digest` references. API and worker share the Bankai digest
  and use distinct commands.
- All ECS services use rollback circuit breakers. API and Quincy use bounded
  CPU autoscaling; worker scaling remains conservatively capped at two tasks.
- API, worker, and Quincy have 60/120/120-second stop timeouts. API/Quincy
  container health checks and ALB `/healthz` checks are explicit.
- Production Redis is an encrypted, Multi-AZ ElastiCache replication group in
  isolated subnets with snapshots and retained deletion policy. Non-production
  retains the disposable Redis ECS service.
- Quincy EFS is encrypted, mounts with TLS/IAM, is retained in production, and
  its access point now matches the hardened image's UID/GID 10001.
- Frontend and Quincy job buckets use rotating customer-managed KMS keys,
  SSL-only bucket policies, public-access blocking, and production retention.
- CloudFront uses TLS 1.2 (2021), OAC, the configured global WAFv2 ACL, and
  stage-specific DNS. The ALB drops invalid headers and uses strict desync
  mitigation.
- Secrets remain Secrets Manager references. Templates and outputs contain no
  secret values. Outputs expose only Jenkins-required repository, bucket,
  distribution, service, CodeBuild, endpoint, and digest identifiers.
- All resources receive `Application`, `Service`, `Environment`, `ManagedBy`,
  and `CostCenter` tags.
- Production cloud assembly sets `terminationProtection: true`.

## Tests and evidence

CDK validation results:

- `npm ci --no-audit --no-fund`: passed (297 packages installed).
- `npm run build`: passed.
- `npm test -- --runInBand`: 10/10 assertions passed.
- `npx cdk synth -c stage=nonprod --quiet`: passed without AWS credentials.
- `npx cdk synth -c stage=production --quiet`: passed without AWS credentials.
- `npm run test:determinism`: passed two syntheses per stage:
  - non-production: `sha256:c963c62f1d49048a2effc7be0752f87efb948f7e35a331670e715765e23ed44f`
  - production: `sha256:7f63e1e5174e33a9d8e899c39fe7cdacc4c0fa526e122fe758d3e0cebd9d4ec3`
- CDK/CloudFormation default-rule schema validation: passed; there were no
  invalid template properties.
- `validate-templates.mjs`: passed both templates with no mutable image,
  secret-shaped value, sensitive output, or wildcard IAM action.
- Trivy template scan: zero unignored High/Critical findings for both stages.
- Protected logical-ID report: no baseline ECR repository, frontend bucket,
  EFS, ElastiCache, load balancer, CloudFront, ECS service, or DNS logical ID
  was removed or replaced in the available baseline synthesis.
- `aws sts get-caller-identity`: failed with `NoCredentials`; therefore
  AWS-side `validate-template` and `cdk diff` were not run. No credentials were
  requested or configured.

The evidence directory contains baseline and final cloud assemblies, Trivy JSON
reports, deterministic hashes in the command log, and protected-resource
comparison reports.

## Reviewed scanner exceptions

`.trivyignore` contains three explicit edge/network findings:

- `AWS-0053`: the Bankai ALB is intentionally internet-facing.
- `AWS-0104`: application and CodeBuild security groups require outbound access
  through NAT for GitHub, ECR, model providers, and scanner/package endpoints.
- `AWS-0164`: public subnets intentionally assign public addresses to ALB/NAT
  infrastructure; workloads select private application subnets and explicitly
  disable public IP assignment.

CloudFront WAF, ALB invalid-header handling, and S3 customer-managed encryption
findings were fixed rather than suppressed.

## Replacement and migration review

No deployment was performed, so these are expected change-set effects that
must be confirmed against the real deployed stack before Phase 7:

- Adding application subnets and NAT gateways is additive; the VPC and existing
  public/data subnet logical IDs remain stable.
- ECS task-definition revisions are expected. ECS service logical IDs remain
  stable, while network configuration changes tasks from public to private
  subnets.
- If a production Redis ECS service already exists, production deployment will
  delete that disposable service/task definition after ElastiCache is ready.
  Redis data is not migrated automatically; an explicit cutover/export decision
  is required in the reviewed change set.
- The production ElastiCache group is new and retained. It must become healthy
  before Bankai tasks receive the `rediss://` endpoint.
- Changing the Quincy EFS access point UID/GID may replace the access point;
  the EFS filesystem itself retains its logical ID and production retention.
- Existing S3 objects remain encrypted with their prior key until rewritten;
  new frontend/job objects use the new KMS keys.
- CloudFront OAC initially needs an account/distribution-pattern KMS condition
  to avoid a circular dependency. After the first controlled deployment, scope
  the key condition to the actual distribution ARN.

The baseline captured before Phase 3 synthesized only stable foundation
resources because the former application stack was conditional on image-tag
contexts. Consequently, the report proves preservation for baseline ECR and
frontend storage but cannot by itself prove physical identity of resources
that were absent from that baseline output. Their current logical IDs match the
pre-Phase-3 construct IDs and tests assert the critical stable IDs.

## Rollback

Before any future deployment, retain the pre-change cloud assembly and create a
CloudFormation change set. To roll back this source-only phase:

1. revert only the Phase 3 files under `infrastructure/` and this document;
2. restore the pre-Phase-3 `bankai-foundation-stack.ts`, bin entrypoint, tests,
   package scripts, README, and configuration state;
3. run the original CDK build/tests and synth both stages;
4. compare protected logical IDs again;
5. do not execute either assembly against AWS without a separate approval.

Because nothing was deployed, source rollback requires no AWS rollback.

## Unresolved risks and next gate

- Real account IDs, Route 53 zone IDs, ACM certificates, WAF ACLs, and ECR
  digests must be supplied and verified before a change set can be created.
- AWS-connected `cdk diff` and `validate-template` remain required with a
  read-only role.
- Confirm whether any current production Redis ECS data needs migration before
  accepting its deletion.
- Review NAT cost and outbound controls; VPC endpoints and an egress proxy can
  reduce broad HTTPS egress in a later approved change.
- Review and scope the CloudFront OAC KMS policy after the first deployment.
- Enable/confirm CloudFormation termination protection on any existing
  production stack before update.

Phase 4 has not started. Stop here for review.
