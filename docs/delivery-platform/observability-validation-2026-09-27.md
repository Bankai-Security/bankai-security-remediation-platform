# Observability validation — updated 2026-10-11 IST

Phase 10 status: **PARTIAL**. AWS metrics, structured application logs, bounded facets, 12 log-based metrics, five dashboards, nine monitors, API/worker/Quincy APM, and controlled Redis and E2E alert/recovery tests are live. The full synthetic remediation, the remaining critical-monitor recovery tests, representative-day cost review, and owner-approved SLO activation remain open.

## Datadog trial retirement

The Datadog trial ended before the remaining live gates were completed. Commit pending from this update removes Datadog credentials, API validation, event publication, and log-search assertions from `Jenkinsfile.release` and `Jenkinsfile.e2e`. Release manifests continue to be written and uploaded to the versioned S3 release path, and the full E2E continues to require the real API → Redis worker → Quincy → CodeBuild → GitHub workflow and cleanup.

The Datadog configuration scripts and the historical evidence below remain in the repository for audit and possible future reactivation. Datadog-only monitor recovery, cost, trace-correlation, and SLO activation gates are closed as **not completed before trial expiry**; they are not reported as passed. CloudWatch logs and existing AWS alarms remain the available operational evidence.

## Live evidence

- Datadog AWS integration for account `926827998551` is Healthy. ECS, Container Insights, ELB, CloudFront, WAF, CodeBuild, and EFS collection are enabled. `AWS/Usage` is disabled.
- `aws.ecs.service.running{clustername:bankai-nonprod} by {servicename}` returns API, worker, Quincy, and Redis with one running task each. Desired count is also one.
- Verified live metrics include `aws.ecs.service.desired`, `aws.ecs.service.running`, `aws.applicationelb.httpcode_target_5xx`, `aws.applicationelb.target_response_time.p50/p95/p99`, `aws.applicationelb.un_healthy_host_count`, `aws.cloudfront.requests`, `aws.cloudfront.4xx_error_rate`, `aws.cloudfront.5xx_error_rate`, `aws.wafv2.allowed_requests`, `aws.wafv2.blocked_requests`, `aws.efs.storage_bytes`, and Jenkins metrics under `jenkins.job.*`.
- No `aws.codebuild.*` metric appeared in the 30-day catalog. A real Quincy remediation build must run before a CodeBuild query or monitor is activated.
- Release build 24 succeeded on 2026-10-03 with Bankai SHA `dd8174c80ec48cd20a18473738a7a55c6916c7c7`, Quincy SHA `20adeda4202da61f630a47377e1b156638cb670e`, deployment `bankai-dd8174c80ec4-build-24`, and Jenkins build `24`. The pipeline passed both repositories' gates, immutable builds, publication, synth, reviewed CloudFormation deployment, service stability, smoke tests, and release-event publication.
- Release build 25 then succeeded in 27 minutes with Bankai SHA `c0a1fd3dcce5c6af38f79364fa06d43ddd591cc5`, the same Quincy SHA, deployment `bankai-c0a1fd3dcce5-build-25`, and Jenkins build `25`. It passed the complete release pipeline and activated working Node trace initialization.

## CloudWatch forwarding

Each active log group has exactly one subscription to `arn:aws:lambda:ap-south-1:926827998551:function:DatadogIntegration-ForwarderStack-1BMUNJ-Forwarder-tUoSMwrLqjBa`:

- API: `bankai-nonprod-api-datadog`
- Worker: `bankai-nonprod-worker-datadog`
- Quincy: `bankai-nonprod-quincy-datadog`

The active groups are the three names specified in the Phase 10 request. Old duplicate seven-day groups were not subscribed.

## Log validation

API query `@service:bankai-api @env:nonprod` returns parsed JSON. A sampled request had UUID `a044605f-70b6-4370-9648-75d600af4468`, `@res.statusCode:200`, `@responseTime:1`, redacted request/response headers, and the exact build 18 release metadata. The earlier controlled request used UUID `7ef00ef0-f6c0-4a8f-9c71-8be4b9a51818` and returned HTTP 200.

Worker query `@service:bankai-worker @env:nonprod @event:queue.depth` returns parsed JSON for `repo-scan`, `fix-pr`, `ci-pipeline`, and `fix-retry`. Events expose bounded queue, event, count, age, and release fields. Searches for token, cookie, authorization, prompt, and source-content sentinels returned no matches in the sampled API and worker windows.

Quincy structured logging passed Jenkins build 7 and was released in build 23. The full synthetic workflow is still required to prove a single request ID and release metadata across API, worker, Quincy, and CodeBuild.

Release 24 produced live Quincy APM data in Datadog under `env:nonprod service:quincy`: 60 recent health requests, zero errors, and about 2.55 ms p95 at the validation point. A Release 24 API log showed trace/span `0`, which exposed that the deployed Node flag loaded only the ESM hook. Commit `c0a1fd3dcce5c6af38f79364fa06d43ddd591cc5` switched to Datadog's combined `dd-trace/initialize.mjs` entry point, and Bankai CI build 36 passed. During the release 25 rollout, Datadog showed 306 recent `bankai-api` traces and 117 `bankai-worker` traces. A sampled API health log had nonzero trace ID `6ac1042700000000341d64a1cf7cabb5`, request ID `857b7c0f-7836-4d58-9e63-cd18fcaf395f`, HTTP 200, redacted headers, deployment `bankai-c0a1fd3dcce5-build-25`, Git SHA/version `c0a1fd3dcce5c6af38f79364fa06d43ddd591cc5`, and Jenkins build `25`.

## Datadog configuration state

- Standard `service`, `env`, and `version` fields are parsed. The AWS resource tags still use `service:delivery-platform` and `environment:nonprod`, so searches must use parsed attributes (`@service`, `@env`) until a pipeline remapper is added.
- Bounded facets are active for `service`, `env`, `version`, `git.sha`, `deployment.id`, `jenkins.build`, `queue`, `event`, and `status_code`. No job, repository, project, user, ticket, prompt, source-file, or URL facet was created.
- Jenkins observability build 5 created the 12 reviewed `bankai.queue.*` and `bankai.api.*` log-based metrics and finished successfully on 2026-09-29.
- Jenkins observability build 7, using commit `265eee703fff409480cd2fcc1189b0eaee58d8bf`, created the five reviewed dashboards and finished successfully on 2026-09-29. Every dashboard has `env` and `service` template variables.
- Jenkins observability build 10 collected a three-day baseline after the scoped application key gained `timeseries_query`. API target 5xx and unhealthy targets remained zero; API p95 latency peaked near 10 ms; all four ECS services stayed at desired/running 1; each queue depth stayed zero; API request telemetry was continuous; queue age, failed, and stalled series were absent. EFS storage was about 646–648 MB on `fs-02c0fefc7f13112c4` and 403,456 bytes on `fs-08078be2d934c4a61`.
- Monitor metadata is resolved: owner `Bankai Platform`, runbook `docs/runbooks/bankai-nonprod-observability.md`, and nonproduction route `@team-bankai-platform` using the team email channel. Jenkins observability build 13 validated all nine definitions against the Datadog API, and build 14 activated them. The live monitor IDs are API 5xx `327392066`, API p95 `327392070`, unhealthy targets `327392072`, ECS mismatch `327392074`, Redis unavailable `327392075`, failed/stalled queue jobs `327392076`, API telemetry missing `327392080`, worker telemetry missing `327392082`, and post-deployment E2E failure `327392084`.
- Immediately after activation, seven monitors evaluated `OK`. The failed/stalled queue and post-deployment E2E monitors showed `No Data` because no matching bounded group existed in their evaluation windows; neither monitor pages on missing data.
- Full E2E build 13 selected `full`, passed the four smoke checks, and failed closed before creating customer-shaped data because Jenkins could not resolve the required `bankai-e2e-user` credential. Datadog monitor `327392084` entered `ALERT` from that controlled failure, proving the alert transition and runbook metadata. The archived smoke evidence recorded run ID `bankai-e2e-1790999097508-40205d9c` and request ID `b06c07d4-b447-42bc-a53b-98be59524036`.
- The Redis monitor recovery test scaled only the nonproduction Redis ECS service to desired/running `0/0`, verified the monitor entered `ALERT` at 2026-10-03 18:17:35 IST, restored ECS to `1/1` at 2026-10-03 12:55:16 UTC, and verified `OK` at 18:32:35 IST. Datadog sent both transitions to the single configured team recipient. No resource was deleted.
- The controlled E2E failure revealed that sparse event-count monitors retained their last alert state after the event series stopped. Commit `11f9e51efcfb881679f06f0eccaa64574d0cc664` sets `on_missing_data: resolve` for API 5xx, failed/stalled queues, and post-deployment E2E failure monitors, with a policy assertion covering all three. Jenkins observability build 16 validated the definitions, build 17 applied them, and monitor `327392084` changed to `OK` at 2026-10-03 18:57:44 IST and sent one recovery notification. Commit `a078cd0f1bbea99fde77f9ade05880806435f820` aligns its recovery message with the actual quiet-window condition; Bankai CI build 38 and observability apply build 18 both passed.
- No SLOs are active. Owner approval of exact SLO targets remains required.
- The exact bounded facet, metric, dashboard, monitor, and SLO definitions are in `phase-10-runtime-observability.md`.

## Cost and cardinality review

- Jenkins observability build 15 archived a second three-day baseline with Datadog estimated-usage queries. `datadog.estimated_usage.logs.ingested_bytes` was present, ranging from 307,480 to 5,523,332 bytes per reporting point and ending at 924,260 bytes.
- The pre-APM baseline returned no series for custom-metric usage or APM ingested bytes, spans, traces, or indexed spans. Release 24 now supplies Quincy spans with a 100% nonproduction trace sample rate. Recollect estimated usage after one representative traced day.
- The nonproduction CloudWatch retention configured in `infrastructure/config/nonprod.json` is 14 days.
- Cardinality remains bounded to `service`, `env`, and `queue` on log-derived metrics. The only queue values are `repo-scan`, `fix-pr`, `ci-pipeline`, and `fix-retry`; job, repository, project, user, ticket, prompt, path, and URL fields are not metric dimensions.
- A Datadog monthly estimate is unavailable from the current trial's Plan & Usage view. Recheck when that view exposes an estimate; no estimate is inferred from partial usage points.

## Remaining live gates

1. Rerun `Jenkinsfile.e2e` in `full` mode with the existing dedicated nonproduction user and single-repository GitHub credential.
2. Verify the real remediation produces a CodeBuild result and synthetic pull request, then confirm cleanup removes the isolated project, webhook, branch, and pull request.
3. Keep owner-approved SLO activation deferred unless a monitoring platform is restored and new representative traffic is observed.

## Rollback

- Revert the Phase 10 commit and run the nonproduction release pipeline to restore the previous task definitions.
- Remove only the three Phase 10 subscription filters if forwarding itself must be rolled back; do not touch old groups or production resources.
- Keep existing CloudWatch alarms until Datadog monitors have passed alert and recovery tests.
- If the Datadog subscription is not renewed, disable its AWS log subscriptions and runtime sidecars in a separately reviewed infrastructure change after confirming CloudWatch coverage; the pipeline retirement does not delete cloud resources.
