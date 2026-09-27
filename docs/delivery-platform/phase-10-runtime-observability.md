# Phase 10 — runtime observability E2E

This document contains the reviewed nonproduction definitions. A query is marked **verified** only when the metric or parsed field was observed in Datadog on 2026-09-27.

## Bounded log schema

Create facets only for `service`, `env`, `version`, `git.sha`, `deployment.id`, `jenkins.build`, `queue`, `event`, and `status_code` (`@res.statusCode`). Keep `jobId`, `projectId`, `repository`, `userId`, `ticketId`, `prompt`, source paths/content, and URLs as un-faceted searchable attributes.

Create these log-based metrics after the facets exist. Every metric may group only by `service`, `env`, and `queue`.

| Metric | Filter | Computation |
| --- | --- | --- |
| `bankai.queue.depth` | `@event:queue.depth` | gauge from `@waiting` |
| `bankai.queue.oldest_waiting_age_ms` | `@event:queue.depth` | gauge from `@oldestWaitingAgeMs` |
| `bankai.queue.active` | `@event:queue.depth` | gauge from `@active` |
| `bankai.queue.completed` | `@event:queue.job.completed` | count |
| `bankai.queue.failed` | `@event:queue.job.failed` | count |
| `bankai.queue.stalled` | `@event:queue.job.stalled` | count |
| `bankai.queue.retries` | `@event:queue.job.active @attempt:>0` | count |
| `bankai.queue.completion_duration_ms` | `@event:queue.job.completed` | distribution from `@durationMs` |
| `bankai.api.requests` | `@service:bankai-api "request completed"` | count |
| `bankai.api.errors_4xx` | `@service:bankai-api @res.statusCode:[400 TO 499]` | count |
| `bankai.api.errors_5xx` | `@service:bankai-api @res.statusCode:[500 TO 599]` | count |
| `bankai.api.request_latency_ms` | `@service:bankai-api "request completed"` | distribution from `@responseTime` |

## Dashboard definitions

All dashboards use template variables `env` and `service`. Only the following live AWS queries are currently verified.

### Platform health

- ECS desired: `avg:aws.ecs.service.desired{clustername:bankai-nonprod} by {servicename}`
- ECS running: `avg:aws.ecs.service.running{clustername:bankai-nonprod} by {servicename}`
- ALB target 5xx: `sum:aws.applicationelb.httpcode_target_5xx{loadbalancer:app/bankai-apise-*}.as_count()`
- ALB p95 latency: `avg:aws.applicationelb.target_response_time.p95{loadbalancer:app/bankai-apise-*}`
- Redis health: desired/running series filtered to the Redis service plus `@service:bankai-worker @event:queue.depth.error`
- EFS storage: `max:aws.efs.storage_bytes{*} by {filesystemid}`
- CloudFront: `sum:aws.cloudfront.requests{*} by {distributionid}.as_count()`, `avg:aws.cloudfront.4xx_error_rate{*}`, `avg:aws.cloudfront.5xx_error_rate{*}`
- WAF: `sum:aws.wafv2.allowed_requests{*} by {webacl}.as_count()`, `sum:aws.wafv2.blocked_requests{*} by {webacl}.as_count()`
- CodeBuild: leave a note widget until a live `aws.codebuild.*` metric is observed.

### Bankai API

- Request rate: `sum:aws.applicationelb.request_count{loadbalancer:app/bankai-apise-*}.as_rate()`
- 4xx/5xx: `sum:aws.applicationelb.httpcode_target_4xx{loadbalancer:app/bankai-apise-*}.as_count()` and the verified 5xx query above
- Latency: `avg:aws.applicationelb.target_response_time.p50/p95/p99{loadbalancer:app/bankai-apise-*}`
- Health: `@service:bankai-api @req.url:/healthz` grouped by `@res.statusCode`
- Authentication failures: `@service:bankai-api @req.url:/api/auth/* @res.statusCode:[400 TO 499]`
- Webhook failures: `@service:bankai-api @req.url:/api/webhooks/* @res.statusCode:[400 TO 599]`

### Bankai workers

Use the eight `bankai.queue.*` metrics above, grouped only by `queue`. Show four queue-depth series, oldest waiting age, active jobs, failures, stalls, retries, and completion duration.

### Quincy

- Service health: `avg:aws.ecs.service.running{clustername:bankai-nonprod,servicename:bankai-nonprod-quincy}`
- Failures: structured `@service:quincy @event:(quincy.scan.failed OR quincy.remediation.failed OR quincy.model.failed)` after the Quincy logging gate is fixed
- CodeBuild failures: pending first live CodeBuild metric
- EFS capacity: verified `aws.efs.storage_bytes` query, scoped to the Quincy filesystem after confirming its `filesystemid`

### Delivery pipeline

- Jenkins starts/completions/duration: `jenkins.job.started`, `jenkins.job.completed`, and `jenkins.job.build_duration`, grouped by the bounded job/result tags exposed by the Jenkins integration
- Deployment event stream: `source:jenkins "Bankai nonprod deployment"`
- Release metadata log stream: `@deployment.id:* @git.sha:* @jenkins.build:*`
- Post-deployment smoke/full results: Jenkins job result plus E2E JUnit artifacts. Add a log/event metric only after one result is visible.

## Monitor definitions

Do not create monitors until owner, runbook URL, and nonproduction notification route are supplied. Use `env:nonprod`, and use multi-alert only for `service` or `queue`.

| Monitor | Query or condition | Recovery |
| --- | --- | --- |
| API 5xx | ALB target 5xx rate over 10m; set threshold from representative traffic | below threshold for 10m |
| API p95 | verified ALB p95 query over 15m; set threshold from baseline | below threshold for 15m |
| Unhealthy targets | `max(last_5m):max:aws.applicationelb.un_healthy_host_count{targetgroup:targetgroup/bankai-apise-*} > 0` | zero for 5m |
| ECS mismatch | desired minus running by service is nonzero for 10m | zero for 10m |
| Redis connectivity | worker `queue.depth.error` count is nonzero or Redis task running is zero | no errors and task running for 10m |
| Queue depth/age | `bankai.queue.depth` / `bankai.queue.oldest_waiting_age_ms` by queue; threshold after baseline | below threshold for 15m |
| Failed/stalled jobs | `bankai.queue.failed` or `bankai.queue.stalled` > 0 in 10m | zero in 10m |
| Quincy failures | bounded Quincy failure events > 0 in 10m | zero in 15m |
| CodeBuild failures | first verified CodeBuild failure metric > 0 | zero in 15m |
| EFS capacity | use storage bytes or percent-I/O limit after identifying the Quincy filesystem and capacity policy | below warning for 30m |
| Missing telemetry | no API/worker logs for 10m while ECS running is one | logs resume for 10m |
| Post-deploy E2E | Jenkins full/smoke result fails for a deployment ID | next run succeeds |

Every message must contain `severity`, `owner`, `runbook`, the alert condition, a recovery message, and the nonproduction route. These values are intentionally `TBD` rather than fabricated.

## Proposed SLO contracts

Targets and alert thresholds remain `TBD` until representative traffic is observed and the owner approves activation.

| SLO | Exact query contract | Good / total | Window | Owner / runbook |
| --- | --- | --- | --- | --- |
| API availability | ALB 2xx/3xx divided by all ALB target responses for `loadbalancer:app/bankai-apise-*` | good = 2xx+3xx; total = 2xx+3xx+4xx+5xx | proposed 30d | TBD / TBD |
| API p95 latency | `aws.applicationelb.target_response_time.p95{loadbalancer:app/bankai-apise-*}` | good = requests below approved latency; total = all requests | proposed 30d | TBD / TBD |
| Remediation completion | `@event:queue.job.completed @queue:fix-pr` / (`completed` + `failed`) | good = completed; total = completed+failed | proposed 30d | TBD / TBD |
| Queue timeliness | `bankai.queue.oldest_waiting_age_ms` against approved per-queue bounds | good = samples within bound; total = all depth samples | proposed 30d | TBD / TBD |
| Successful deployments | successful Jenkins nonprod releases / completed nonprod releases | good = release and smoke/full success; total = completed releases | proposed 30d | TBD / TBD |

## Synthetic correlation contract

`Jenkinsfile.e2e` reads `DEPLOYMENT_ID`, `GIT_SHA`, and `JENKINS_BUILD` from the deployed API task definition. `e2e/run.mjs` creates a UUID, sends it as `x-request-id`, carries it through BullMQ and Quincy, and requires matching API, worker, and Quincy Datadog logs before passing. It writes the correlation and release values to `reports/e2e/result.json` and deletes the isolated project/PR during cleanup.

## Cost and cardinality review

After one representative day record: `datadog.estimated_usage.logs.ingested_bytes`, custom metric count, trace ingestion, sampling settings, unique values for each allowed tag, CloudWatch retention, and the Datadog monthly estimate. Remove any tag that grows with jobs, repositories, projects, users, tickets, source paths, or URLs.
