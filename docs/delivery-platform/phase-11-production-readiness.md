# Phase 11 — Production readiness

> Updated evidence and current blockers: [validation record](phase-11-13-validation.md).
> The original checklist below includes historical pending items; consult that record
> for the successful October 21 nonproduction deployment, restores and drift audit.

Status: **PARTIAL**. Repository controls implemented; live readiness blocked.
Date: 2026-10-19. See [initial gaps](phase-11-gap-assessment.md).

## Implemented repository controls

- AWS-native CDK dashboard, bounded JSON log metric filters, SNS alarms and
  conditional email/account budget in `infrastructure/lib/native-observability.ts`.
- Application Datadog sidecars/tracer initialization and Jenkins Datadog
  configuration removed. Existing DD_SERVICE/DD_ENV/DD_VERSION variables remain
  compatibility inputs to JSON log metadata, not a network integration.
- Existing CloudWatch alarms retained. New names use `native-` to allow a
  deliberate validation window. The old CodeBuild alarm's Builds/BuildStatus
  query is superseded by a new FailedBuilds/ProjectName alarm; do not count the
  old alarm as useful coverage.
- Quincy EFS automatic backup enabled explicitly; all ECR expiry disabled so
  active and rollback image digests are not removed merely because they are old.
  ECR deletion retains repositories; Quincy EFS and logs retained. S3 job
  versioning enabled. Existing job-object expiration still applies; job results
  are not a substitute for the retained release/audit evidence store.
- API, worker and Quincy memory target tracking added at 75% alongside CPU.
  Production ALB deletion protection and DNS record retention added.
- Production role assumption defaults to explicit deny. A separately approved
  `productionApprovalRoleArn` in the production account is required. Nonprod
  agent direct trust is removed in source. Applying this IAM change itself
  requires production approval. Production roles still need a reviewed complete
  service-role/publishing policy before promotion is operational.

## Native monitoring configuration and validation

`OperationsEmail` is a CloudFormation parameter, default empty. Empty means no
email subscription. Confirm the SNS email subscription before claiming delivery.
`MonthlyBudgetUsd` defaults to zero (unconfigured). With email and a positive
amount, create an account-wide monthly USD budget with actual 80% and forecast
100% alerts. This is not a per-application budget. Check existing account budgets
before creating another one. No tracing is enabled.

Initial thresholds are hypotheses: target 5xx 5/minute, ALB 5xx 1/minute, p95
2 seconds, unhealthy targets 1, queue depth 100, oldest waiting age 5 minutes,
failed/stalled jobs 1, EFS 100 GiB and 80% IO, CodeBuild failures 1. Most require
2 of 3 periods; queue/API telemetry alarms require 10 missing/low periods.
EFS storage is a cost/usage warning, not a fixed-capacity disk-full signal.
Multiple workers report the same queue; gauges use Maximum, not Sum.

Dashboard covers ECS, ALB, EFS, CodeBuild, CloudFront/WAF, API and four queues.
Redis connectivity/error coverage uses queue samples and the nonprod Redis ECS
service. Native production ElastiCache node metrics, including memory,
connections and replication lag, remain a live-inventory follow-up. WAF WebACL
dimension must be checked against the external ACL's configured metric name.
API log-loss detection assumes periodic health/request logs; verify that before
activation. Graphs are definitions, not proof of ingestion.

Nonprod rollout: authenticate, run inventory, synth with real parameters and
exact deployed digests, review change set, reject destructive changes, execute,
observe samples, test one alarm using a dedicated synthetic metric and confirm
email/recovery, then document existing/new alarm overlap. Never delete existing
subscriptions or alarms as part of this change. An existing Datadog log forwarder
may still be active; inspect actual task log groups and subscription filters
before explicitly retiring it after native monitoring passes.

Metric contracts checked against AWS documentation:
[ECS](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Container-Insights-metrics-ECS.html),
[CodeBuild](https://docs.aws.amazon.com/codebuild/latest/userguide/cloudwatch_metrics-codebuild.html),
[EFS](https://docs.aws.amazon.com/efs/latest/ug/efs-metrics.html).

## Readiness checklist and evidence required

| Control | Repository status | Live evidence required before production |
| --- | --- | --- |
| Account separation | Loader rejects shared account; production config placeholder | STS identity for each role, Organizations/account ownership |
| Least privilege/approval | PR isolation; production trust deny until configured | IAM policy simulator and real denied PR/nonprod assumption; independent approver policy |
| Break glass/audit | Procedure only | MFA-protected role, owner, tested access, CloudTrail status/digest validation and retained bucket |
| Credentials | No new credential values written | Gitleaks working tree/history and image secret scan; review findings privately |
| Secrets | Names `bankai/production/backend`, `bankai/production/quincy-api-token`, ap-south-1 | DescribeSecret, resource policies, KMS grants, AWSCURRENT version and rotation owner; never export values |
| ACM/DNS/WAF | References only | Issued API cert in ap-south-1, frontend in us-east-1, validation CNAME ownership, ACL managed rules/rate limits and direct-ALB bypass assessment |
| Redis | Prod TLS/encryption, two nodes, 7-day snapshots | Snapshot success, restore, auth/ACL review, connection and memory capacity |
| EFS | Encrypted/TLS/IAM and backup enabled | DescribeBackupPolicy, recovery point, isolated restore and SQLite integrity |
| S3 | Private/KMS/SSL/versioning | Versions/lifecycle/KMS restore access; restore a selected object version to isolated destination |
| Supabase | External dependency | Plan/PITR entitlement, last backup, isolated DB restore, RLS/auth/storage consistency |
| Deletion protection | Prod stack protection, ALB, RETAIN policies | Stack EnableTerminationProtection; retained keys/secrets/certs/ACL and independent owner policies |
| ECS rollback | Circuit breakers | Timed prior-manifest rollback and post-rollback E2E |
| Capacity | Bounded CPU/memory target tracking | Load baseline, headroom, quotas and concurrency safety |
| Notification/cost | Parameterized SNS/budget | Email confirmation and delivery, budget history and approved amount |
| Security | See unresolved findings below | Fresh complete scan artifacts and accountable risk acceptance |

## Capacity and cost review

Production configured min/max: API 2/10 (1 vCPU, 2 GiB each), worker 1/2
(1 vCPU, 2 GiB), Quincy 2/6 (2 vCPU, 4 GiB). CPU triggers are 60/70/65%;
memory 75%. Baseline task demand is 7 vCPU/14 GiB, maximum 24 vCPU/48 GiB,
excluding deployment surge. Check regional Fargate on-demand vCPU quota against
at least twice maximum during a rolling update plus unrelated workloads.
Confirm ARM64 image/platform alignment. EC2 Jenkins fleets, CodeBuild concurrent
builds, ECR API/storage, ENIs/IPs, ALB targets and ElastiCache quotas also matter.
Inventory collects available service quotas; quotas are not inferred from defaults.

No measured request/queue throughput or Redis connection limit is available.
Record p95/p99, queue arrivals/completion, max memory, Redis CurrConnections,
evictions and replication lag under isolated load before claiming a supported
load limit. EFS throughput mode and burst/IO behavior require live evidence.
Quincy SQLite on shared EFS with two or more processes is an unresolved integrity
and concurrency concern; do not use autoscaling as evidence that it is safe.

Monthly planning envelopes (USD, **not measured bills or quotes**): nonprod
$300–900, production $900–2,500 at low steady traffic. These intentionally broad
engineering allowances assume 730 hours, configured minimum tasks, NAT gateways,
ALBs, modest EFS/log volumes and intermittent Jenkins/CodeBuild. They exclude
model/API provider and Supabase charges, taxes/support, large egress, sustained
builds and scaling to maximum. Replace them with a saved Mumbai-region AWS
calculator estimate and 30-day Cost Explorer actuals before setting budgets.
Compute is task CPU/memory-hours; NAT includes hours and bytes; logs include
ingestion/retention/query costs. Review current 14/90-day application retention,
CodeBuild log retention (not yet explicitly managed here), EFS backups, public
IPv4, Container Insights and inter-AZ/Internet transfer.
Sources: [Fargate pricing](https://aws.amazon.com/fargate/pricing/),
[VPC pricing](https://aws.amazon.com/vpc/pricing/),
[CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/).

## Security findings and risk disposition

No findings are automatically accepted. Owner: Bankai Platform, acceptance due
before production approval. Known review items: internal Quincy HTTP; Redis
auth/ACL not configured; anonymous EFS access flag requires policy review;
privileged CodeBuild sandbox; broad egress; direct public ALB bypass of the
CloudFront ACL; CloudFront KMS policy scope; unverified external WAF rate limits;
Jenkins bootstrap administrator; production placeholders; shared SQLite/EFS.
Fresh container, image, IaC and Git-history scans require Docker/scanner access.
Dependency audit results and test evidence are in the validation record.

## Operator unblock steps

1. Refresh existing credentials with `aws sso login --profile <approved-profile>`
   (or your organization's short-lived credential mechanism). Set AWS_PROFILE
   for this session and confirm STS account **926827998551**. Outside the sandbox
   STS returned **InvalidClientTokenId**; inside it returned **NoCredentials**.
2. Run `node scripts/operations/inventory.mjs` from the repository. Use metadata
   permissions for CloudFormation/ECS/Logs/CloudWatch/SNS/Budgets/SecretsManager/
   ECR/EFS/ElastiCache/Backup/ACM/Route53/CloudTrail/IAM/EC2/WAF/ServiceQuotas/S3.
   No GetSecretValue permission is needed. Review denied calls individually.
3. Start Docker Desktop's Linux engine and rerun component/container/scanner
   gates. Refresh the Jenkins controller image/plugin lock through normal CI
   when applying removal of the Datadog plugin.
4. Supply notification recipient, monthly budget, real production configuration,
   independent approval role and Supabase restore access through approved
   configuration channels. Do not place secret values in Git or chat.
5. Follow [operations runbooks](../runbooks/production-operations.md), then record
   measured RPO/RTO and rollback evidence. No drill has run in this session.
