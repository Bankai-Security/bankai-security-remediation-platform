# Observability validation — updated 2026-09-29 IST

Phase 10 status: **PARTIAL**. AWS metrics, application logs, bounded facets, 12 log-based metrics, and five dashboards are live. Quincy logs remain unstructured, so monitor, SLO, correlation, recovery, and cost gates are not complete.

## Live evidence

- Datadog AWS integration for account `926827998551` is Healthy. ECS, Container Insights, ELB, CloudFront, WAF, CodeBuild, and EFS collection are enabled. `AWS/Usage` is disabled.
- `aws.ecs.service.running{clustername:bankai-nonprod} by {servicename}` returns API, worker, Quincy, and Redis with one running task each. Desired count is also one.
- Verified live metrics include `aws.ecs.service.desired`, `aws.ecs.service.running`, `aws.applicationelb.httpcode_target_5xx`, `aws.applicationelb.target_response_time.p50/p95/p99`, `aws.applicationelb.un_healthy_host_count`, `aws.cloudfront.requests`, `aws.cloudfront.4xx_error_rate`, `aws.cloudfront.5xx_error_rate`, `aws.wafv2.allowed_requests`, `aws.wafv2.blocked_requests`, `aws.efs.storage_bytes`, and Jenkins metrics under `jenkins.job.*`.
- No `aws.codebuild.*` metric appeared in the 30-day catalog. A real Quincy remediation build must run before a CodeBuild query or monitor is activated.
- Release build 18 succeeded with Bankai SHA `e6c7cf8ca00989c0bb54397e072f301f4be108d2`, Quincy SHA `210e45488e279394eea12506b65824753e1eb934`, deployment `bankai-e6c7cf8ca009-build-18`, and Jenkins build `18`.

## CloudWatch forwarding

Each active log group has exactly one subscription to `arn:aws:lambda:ap-south-1:926827998551:function:DatadogIntegration-ForwarderStack-1BMUNJ-Forwarder-tUoSMwrLqjBa`:

- API: `bankai-nonprod-api-datadog`
- Worker: `bankai-nonprod-worker-datadog`
- Quincy: `bankai-nonprod-quincy-datadog`

The active groups are the three names specified in the Phase 10 request. Old duplicate seven-day groups were not subscribed.

## Log validation

API query `@service:bankai-api @env:nonprod` returns parsed JSON. A sampled request had UUID `a044605f-70b6-4370-9648-75d600af4468`, `@res.statusCode:200`, `@responseTime:1`, redacted request/response headers, and the exact build 18 release metadata. The earlier controlled request used UUID `7ef00ef0-f6c0-4a8f-9c71-8be4b9a51818` and returned HTTP 200.

Worker query `@service:bankai-worker @env:nonprod @event:queue.depth` returns parsed JSON for `repo-scan`, `fix-pr`, `ci-pipeline`, and `fix-retry`. Events expose bounded queue, event, count, age, and release fields. Searches for token, cookie, authorization, prompt, and source-content sentinels returned no matches in the sampled API and worker windows.

Quincy logs arrive from the correct group but are plain Uvicorn access lines, for example `GET /health HTTP/1.1 200 OK`. They are tagged `service:delivery-platform` and do not expose request ID or release fields. Do not claim API → worker → Quincy → CodeBuild correlation until a Quincy image with structured logging is released.

## Datadog configuration state

- Standard `service`, `env`, and `version` fields are parsed. The AWS resource tags still use `service:delivery-platform` and `environment:nonprod`, so searches must use parsed attributes (`@service`, `@env`) until a pipeline remapper is added.
- Bounded facets are active for `service`, `env`, `version`, `git.sha`, `deployment.id`, `jenkins.build`, `queue`, `event`, and `status_code`. No job, repository, project, user, ticket, prompt, source-file, or URL facet was created.
- Jenkins observability build 5 created the 12 reviewed `bankai.queue.*` and `bankai.api.*` log-based metrics and finished successfully on 2026-09-29.
- Jenkins observability build 7, using commit `265eee703fff409480cd2fcc1189b0eaee58d8bf`, created the five reviewed dashboards and finished successfully on 2026-09-29. Every dashboard has `env` and `service` template variables.
- No monitors or SLOs are active. Owner, runbook, notification route, representative baselines, and owner-approved SLO targets remain required.
- The exact bounded facet, metric, dashboard, monitor, and SLO definitions are in `phase-10-runtime-observability.md`.

## Remaining live gates

1. Release structured Quincy logging with request ID and all six release fields.
2. Deploy the repository changes and run `Jenkinsfile.e2e` in `full` mode.
3. Observe representative nonproduction traffic and record baselines for every threshold-based monitor.
4. Obtain owner, runbook, and notification-route values before monitor creation and explicit owner approval before SLO activation.
5. Trigger and recover each critical nonproduction monitor.
6. Activate SLOs only after their exact targets and owners are approved.
7. Review ingestion, metric cardinality, trace sampling, retention, and estimated monthly cost after one representative day.

## Rollback

- Revert the Phase 10 commit and run the nonproduction release pipeline to restore the previous task definitions.
- Remove only the three Phase 10 subscription filters if forwarding itself must be rolled back; do not touch old groups or production resources.
- Keep existing CloudWatch alarms until Datadog monitors have passed alert and recovery tests.
