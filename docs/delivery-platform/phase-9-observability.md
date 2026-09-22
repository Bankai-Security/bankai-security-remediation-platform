# Phase 9 — observability rollout

Status: **repository instrumentation staged; live integration and exit criteria pending**. Do not treat a successful CDK synth as evidence that Datadog receives data. No stack or Datadog account changes were made while preparing this phase.

Connected Datadog baseline on 2026-09-22: Jenkins metrics (`jenkins.job.completed`, `jenkins.job.duration`, `jenkins.queue.size`, `jenkins.node.online`) and four Bankai-related events were visible over seven days, including a failed `bankai-nonprod-e2e` build. Searches returned no `aws`/`ecs` metrics, no Bankai API/worker/Quincy logs, and no Bankai dashboards or monitors. The connected Datadog MCP session reports **write access disabled for this organization**; it cannot create dashboards or monitors. These findings are a point-in-time observation, not a statement that later ingestion failed.

The user reported `DatadogIntegration` in ap-south-1 as `CREATE_COMPLETE` on 2026-09-22. This confirms CloudFormation finished, but AWS/ECS/ELB/CodeBuild metrics were still absent from the connected Datadog catalog at the next check. Verify the account appears as healthy in Datadog's AWS integration page and recheck after the first collection interval before subscribing application logs.

Later on 2026-09-22 the AWS integration began ingesting ECS, ALB, EFS, CloudFront, WAF, and Lambda metrics. `aws.ecs.service.running{clustername:bankai-nonprod} by {servicename}` returned 1 each for API, worker, Quincy, and the nonprod Redis service. This verifies AWS metric collection only; application logs and traces still require separate setup. Metric tag inspection confirmed `clustername`, `servicename`, `region`, `aws_account`, `environment`, and `costcenter` are available for ECS service metrics.

The user identified a Datadog Forwarder Lambda in ap-south-1 and two CloudWatch log groups each for API, worker, and Quincy (one 7-day and one 14-day). **Do not subscribe both blindly**. Resolve the active ECS task definitions' `awslogs-group` values first, then check existing subscription filters before adding one scoped subscription per active group. The CodeBuild remediation log group currently has no retention policy and needs a separately reviewed retention change before forwarding.

Current task definitions reported the active 14-day groups as:

- API: `Bankai-nonprod-Foundation-ApiServiceTaskDefwebLogGroup57352A09-Uwj6aMoMxR9h`
- Worker: `Bankai-nonprod-Foundation-WorkerTaskWorkerLogGroupC4516CEB-M9r8IZ7erWd4`
- Quincy: `Bankai-nonprod-Foundation-QuincyTaskQuincyLogGroupECD2184C-kcbYzTQLRB0Z`

The Forwarder Lambda ARN reported by the user is `arn:aws:lambda:ap-south-1:926827998551:function:DatadogIntegration-ForwarderStack-1BMUNJ-Forwarder-tUoSMwrLqjBa`. Before adding a trigger, list each active group's current subscription filters and avoid overwriting or duplicating an existing delivery path.

An API-only CloudWatch Logs trigger was added by the user. Datadog returned a parsed `request completed` log with `GET` and status `200`; its current service tag is `delivery-platform`, not `bankai-api`, because the Phase 9 application tagging changes have not yet been released. Do **not** forward the current worker group's logs yet: the deployed worker image predates the edit that removes `job.data` from lifecycle logs. Quincy also logs repository URLs, callback URLs, and some exception strings, so its forwarding should follow a redaction review. The API pilot is proof of transport, not proof that all payload fields have passed a privacy review.

The staged Bankai logger now redacts entire request and response header maps, not just cookie and authorization fields. Worker lifecycle payload logging has been removed, queue age/stall/active telemetry added, and Quincy endpoint URLs removed from three Bankai log sites. These changes passed backend typecheck and 124 unit tests locally, but **none is in the running image**. Release the code through the reviewed nonprod pipeline, then validate Datadog `service`, `version`, `git.sha`, `deployment.id`, and a synthetic request before enabling the worker trigger. Quincy requires its own logging review and image release.

## Current telemetry contract

- API, worker, and Quincy ECS tasks receive `DD_ENV`, `DD_SERVICE`, `DD_VERSION`, `GIT_SHA`, `DEPLOYMENT_ID`, and `JENKINS_BUILD`. The release pipeline supplies exact Git SHAs, release ID, and Jenkins build number at synthesis. A manual synth falls back to image digests and `manual-synth`.
- Bankai Pino logs are JSON in production. Request logs carry `service`, `env`, `version`, `git.sha`, `deployment.id`, and `jenkins.build`. Keep raw URLs, project IDs, job IDs, repository names, and user IDs as *log attributes only*, never Datadog metric tags.
- The worker logs `queue.job.active`, `queue.job.completed`, `queue.job.failed`, `queue.job.stalled`, and once-per-minute `queue.depth` for the four bounded queue names. The depth sample includes `oldestWaitingAgeMs`, obtained with one bounded oldest-job lookup per nonempty queue. Payloads are not logged by worker lifecycle handlers, and the worker startup log no longer emits the Quincy URL. `durationMs`, `waitMs`, `attempt`, `waiting`, `active`, `delayed`, `failed`, and `oldestWaitingAgeMs` are numeric attributes. Job IDs may remain log attributes for investigation but must never be metric tags.
- Jenkins posts a release event tagged with environment, services, version, Git SHA, deployment ID, and build number after the smoke test. It uses the existing Secrets Manager-backed Jenkins credential.

## Required live setup (not yet performed)

1. In Datadog's AWS integration, generate the account-specific external ID and confirm the Datadog AWS principal for the selected site. Create a dedicated read-only integration role in account `926827998551` using Datadog's current official CloudFormation integration template or documented least-privilege policy. Do not reuse the Jenkins task role. Enable only the required CloudWatch namespaces (ECS/ContainerInsights, ECS, ELB, CloudFront, WAF, CodeBuild, EFS) and EventBridge events. Exclude unused namespaces, especially `AWS/Usage`, to constrain API and custom-metric charges.
2. Choose the log intake route. Existing tasks use `awslogs`, which a Fargate Agent sidecar **cannot read**. Use a scoped Datadog Lambda Forwarder subscription on the API, worker, Quincy, and CodeBuild CloudWatch log groups, or migrate to FireLens in a reviewed change set. Set a short nonprod retention and explicit exclusion rules for health checks and noisy debug events. Do not enable both routes for the same log group.
3. Provision a dedicated runtime Datadog API-key secret in ap-south-1, separate from Jenkins credentials. Add a digest-pinned Datadog Agent sidecar to API, worker, and Quincy Fargate tasks, with resource headroom and task-level secret injection. Set ECS Fargate and unified-service-tagging variables. Enable APM only after application tracers are loaded before other imports; sample traces and propagate context across Bankai → Quincy. The current repository does **not** yet ship those sidecars or tracers.
4. For Quincy CodeBuild jobs, export the same deployment identifiers into the build and container. Forward CodeBuild logs. Do not put model prompts, source files, GitHub tokens, or scanner findings in tags or trace payloads.
5. Create Datadog log pipelines and log-based metrics with bounded facets. Queue depth can use the `queue.depth` sample and queue outcomes can use `queue.job.*`. Verify source timestamps and numeric parsing before monitoring.

## Dashboards and alert design

Create five dashboards: platform health (ECS desired/running, ALB 5xx/p95, Redis, EFS, CodeBuild), Bankai API (requests, 4xx/5xx, p50/p95/p99, auth/webhooks/external-client outcomes), Bankai workers (four queue depths, oldest waiting age, duration, retries, stalls, outcomes), Quincy (scan/remediation/model/CodeBuild/EFS), and delivery (Jenkins builds, deployment events, release SHA, post-deploy E2E). Use `env` and `service` template variables; never template on job or customer identifiers.

Until the AWS integration is live, the delivery dashboard can use verified metric names: `jenkins.job.completed{job:bankai-nonprod-e2e,result:failure}`, `jenkins.job.duration{job:bankai-nonprod-e2e}`, `jenkins.queue.size{*}`, and `jenkins.node.online{*}`. `jenkins.job.completed` is a **rate**, not a raw count; use `.as_count()` or an appropriate rollup for build totals. Do not invent ECS or application metric names before they appear in the Datadog catalog.

Create monitors with runbook URLs for: API 5xx/error-budget burn, p95 latency, unhealthy ALB targets, ECS desired-versus-running, Redis connectivity, queue depth/age and failed/stalled jobs, Quincy remediation and model failures, CodeBuild failures, EFS capacity, missing telemetry, and post-deploy E2E failure. Route severity and ownership explicitly; use multi-alert only on bounded service/queue names. Start thresholds in nonprod from measured baselines, then tune before production.

Proposed SLOs (targets require owner approval): API availability, API p95 latency, remediation completion, queue processing timeliness, and successful deployments. Each must specify the exact Datadog query, good/total definition, window, target, owner, alert, and runbook before being activated. Do not invent targets from absent traffic.

## Exit checks before declaring Phase 9 complete

- Show a real nonprod request and one remediation workflow linked by trace/correlation ID across API, worker, Quincy, and CodeBuild, with matching release metadata and no secrets in logs.
- Show Datadog AWS integration healthy and live metrics, logs, traces, and a Jenkins deployment event from the same release.
- Demonstrate all five dashboards with real data, actionable monitors firing and recovering in a controlled test, runbook links, and approved SLO queries/targets.
- Review Datadog ingest volumes, tag cardinality, sample rates, log retention, and monthly cost after at least one representative day.

Rollback: disable the new Datadog subscriptions/sidecars and revert the observability-only CDK change set; retain existing CloudWatch logs and alarms. Do not delete customer logs or security audit evidence.

References: [Datadog AWS integration](https://docs.datadoghq.com/integrations/amazon-web-services/), [manual role setup](https://docs.datadoghq.com/integrations/guide/aws-manual-setup/), [Fargate Agent](https://docs.datadoghq.com/integrations/aws-fargate/), [ECS logs](https://docs.datadoghq.com/containers/amazon_ecs/logs/), [unified service tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/).
