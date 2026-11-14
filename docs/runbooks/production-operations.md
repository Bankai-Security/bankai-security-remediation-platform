# Bankai operations and recovery

Owner: Bankai Platform. Incident responder and notification address must be
assigned before production. All procedures start by recording UTC time, STS
account/role, region, release ID, affected service and last successful manifest.
Preserve logs/events and use request IDs for investigation, never metric labels.
Production mutation requires explicit approval; practice on nonprod first.

## failed-deployment

Stop later release stages. Inspect CloudFormation stack events and ECS deployment
failure reason, compare image digests and task definitions with prior manifest.
Let CloudFormation/circuit-breaker rollback finish; do not submit overlapping
updates. If rollback fails, escalate the exact failed resources. Prepare a new
no-removal rollback change set from prior digests and restore prior frontend
object versions. Wait for services, smoke and alarm recovery before closing.

## ecs-0
## ecs-1
## ecs-2
## ecs-3

Task crash loop: describe service events and stopped task reasons, then the
active task's CloudWatch log group. Check image architecture, memory/OOM,
Secrets Manager/KMS access, startup command, network/image pull and health
grace period. Do not print environment secret values. Restore the prior task
definition through a reviewed release; verify desired equals running for ten
minutes. Increasing desired count does not repair a broken image.

## unhealthy-targets
## target-5xx
## alb-5xx
## latency
## api-errors
## api-telemetry

Inspect target-health reason codes, listener/certificate, security-group source,
container port and `/healthz` dependency health. Separate target 5xx from ALB
5xx; inspect p95 and saturation over the same window. Restore previous task or
listener configuration only through the relevant approval. Verify health from
inside the VPC and the public API, CORS and sustained target health. For absent
logs check active awslogs group, retention, execution-role permissions and
metric filter JSON compatibility before assuming no traffic.

## redis-connectivity

Check queue.depth.error, Redis ECS health (nonprod) or ElastiCache failover,
memory, connections, network and TLS (prod). Pause new remediation dispatch if
queue safety is uncertain. Do not flush Redis or restart the disposable nonprod
task to test recovery: its AOF resides on ephemeral storage. For restore use a
new isolated Redis target, check queue counts/checkpoints and idempotency, then
perform a separately reviewed connection cutover. Verify worker throughput and
no duplicate external PRs before resuming dispatch.

## repo-scan-depth
## repo-scan-age
## ci-pipeline-depth
## ci-pipeline-age
## fix-pr-depth
## fix-pr-age
## fix-retry-depth
## fix-retry-age
## jobs-failed
## jobs-stalled

Queue backlog: compare arrivals, completions, oldest waiting age, active jobs,
worker CPU/memory and Quincy/CodeBuild availability. Investigate failure logs by
request ID; never log payloads. Scale only within tested concurrency and quota
bounds. Retry one synthetic/idempotent job after the cause is fixed; do not bulk
retry externally mutating jobs. Close only after backlog age decreases and
failed/stalled rate returns to baseline. Missing queue telemetry means check
worker health and filter queue names first, not assume zero backlog.

## quincy-failure

Check private DNS, `/health`, token authorization, task logs and CodeBuild job
state. Inspect EFS mount permission/UID and SQLite integrity before running
multiple replicas or replaying writes. Check provider rate limits without
exposing prompts/tokens. Preserve request/result objects and restore prior
Quincy digest if regression is proven. Validate one isolated remediation.

## codebuild

Inspect failed build phase, CloudWatch logs, pinned image availability, ECR/KMS
permissions, VPC egress and request/result object keys. Confirm privileged
sandbox isolation; never grant broad permissions as a diagnostic shortcut.
Classify timeout/provider/scanner failure separately. Rerun a synthetic request,
verify result persistence and worker reconciliation, then restore dispatch.

## certificate-dns

Verify DNS aliases and authoritative zone ownership; check ACM status, SANs,
expiry and renewal validation records in the correct region. CloudFront certs
are in us-east-1; ALB certs in ap-south-1. Compare listener/distribution references
to the prior record. Do not delete a certificate or validation CNAME. Restore
known-good approved references; verify TLS hostname/chain and external routing.

## secret-rotation

Identify secret version stages/rotation status using metadata only. Check
consumer role and KMS grants, then exercise an isolated health/authentication
test. Revert AWSCURRENT to the previously validated version only with the secret
owner and deployment approval. TOKEN_ENC_KEY requires a data re-encryption plan;
blind rotation can make stored credentials unreadable. Restart consumers through
a reviewed release after rotation, never print secret JSON to build logs.

## efs-storage
## efs-io
## data-restore

Non-destructive restore drill, currently **NOT RUN**:

1. Record start UTC, source ARN, recovery point/version timestamp and expected
   synthetic record/checksum. Verify source and target are nonprod. Target must
   have a distinct ID, isolated network and no production credentials/webhooks.
2. EFS: use AWS Backup restore metadata and StartRestoreJob into a **new**
   encrypted filesystem; preserve source. Wait COMPLETED, mount through a
   separate maintenance host/access point, verify UID/GID, file hashes and
   SQLite `integrity_check`/application read. Do not attach production writers.
3. S3: GetObject with the selected VersionId, copy to an isolated bucket/prefix,
   compare SHA-256 and KMS access. Do not overwrite or delete source versions.
4. Redis: restore a snapshot into a new isolated replication group; for disposable
   nonprod Redis, create a consistent synthetic export via an approved isolated
   maintenance procedure first. Verify counts and idempotency without consuming
   production queues. Nonprod ECS AOF alone is not a backup.
5. Supabase: owner exports or restores an available backup/PITR into a separate
   project/database. Disable outbound hooks; test schema, RLS, encrypted-token
   continuity and synthetic data. Never restore over the live project.
6. Record ready UTC and data watermark. RTO = ready minus start; RPO = simulated
   incident time minus latest successfully restored data watermark. Record job
   IDs, hashes, functional results, costs and reviewer. Do not infer RPO from
   snapshot retention or claim RTO from an AWS job alone. Retain evidence and
   source/restore targets until the operator approves any later cleanup.

## rollback-drill

Nonprod only, currently **NOT RUN**. Select two successful known-good manifests,
verify both sets of digests/frontend bytes, record current stack/task/frontend
versions and queue state. Schedule a synthetic-only interval. Prepare a change
set using the prior manifest, reject data/edge deletion or replacement, then
execute and wait for stack/ECS stability. Restore exact prior frontend bytes,
wait for invalidation, run smoke/full synthetic validation and inspect native
alarms across their windows. Record start/healthy times and elapsed recovery.
Return to the starting release through another reviewed change set and repeat
health checks. Preserve both manifests, CloudTrail IDs and all logs. Failure
means stop and escalate; no fabricated "pass" or zero-second recovery time.
