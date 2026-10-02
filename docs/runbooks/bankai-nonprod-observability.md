# Bankai nonproduction observability runbook

Owner: **Bankai Platform**  
Environment: **nonprod**  
AWS account: **926827998551**  
Datadog notification route: `@team-bankai-platform` (team email channel)

This runbook covers the Bankai API, workers, Redis, Quincy, CodeBuild, EFS, and delivery telemetry. It contains investigation and recovery steps for the reviewed Phase 10 monitors. Thresholds that depend on traffic remain unset until a representative baseline is recorded.

## Shared response procedure

1. Acknowledge the alert and record its start time, Datadog monitor URL, triggering group, and current value.
2. Open the matching dashboard: **Bankai nonprod — Platform health**, **API**, **Workers**, **Quincy**, or **Delivery**.
3. Confirm the alert is scoped to `env:nonprod` and AWS account `926827998551`.
4. Check the most recent deployment ID, Git SHA, and Jenkins build before changing the service.
5. Prefer a reversible service restart or rollback through the reviewed Jenkins pipeline. Do not delete resources to test or recover an alert.
6. After recovery, confirm the monitor is `OK`, record the recovery time, and attach the relevant dashboard or log link.

## API 5xx

Query contract: ALB target 5xx over 10 minutes for `loadbalancer:app/bankai-apise-*`.

1. Check **Bankai nonprod — API** for request rate, target 5xx, and latency.
2. Search API logs for `service:bankai-api @env:nonprod @res.statusCode:[500 TO 599]`.
3. Group failures by bounded fields such as endpoint family or status code. Do not create URL or request-ID metric tags.
4. Compare the first failure with the latest deployment event and release metadata.
5. If the current release caused the errors, roll back through the nonproduction release pipeline. Otherwise restart only the unhealthy API task after capturing logs.
6. Recover when the 5xx signal remains below the approved threshold for 10 minutes.

## API p95 latency

Query contract: `aws.applicationelb.target_response_time.p95` for the Bankai API ALB over 15 minutes.

1. Compare p50, p95, and p99 latency with request rate and 5xx responses.
2. Check API task count, CPU or memory pressure when available, Redis health, and downstream Quincy or CodeBuild activity.
3. Inspect slow API logs through `bankai.api.request_latency_ms`; keep request IDs searchable but un-faceted.
4. Roll back a correlated deployment or restart an unhealthy task through the reviewed path.
5. Recover when p95 remains below the approved threshold for 15 minutes.

## Unhealthy ALB targets

Query: `max(last_5m):max:aws.applicationelb.un_healthy_host_count{targetgroup:targetgroup/bankai-apise-*} > 0`.

1. Check target health and the API ECS service desired/running counts.
2. Inspect `/healthz` responses and recent container starts or deployment events.
3. Replace an unhealthy task through ECS service reconciliation or the release pipeline.
4. Recover when unhealthy target count is zero for five minutes.

## ECS desired and running mismatch

1. Open **Bankai nonprod — Platform health** and identify the bounded `servicename` group.
2. Check ECS deployment events, stopped-task reasons, and task logs for that service.
3. Verify image availability, secrets access, networking, and task-definition health checks.
4. Roll back the most recent task definition when it caused the mismatch.
5. Recover when desired minus running is zero for 10 minutes.

## Redis connectivity

1. Check the Redis ECS task desired/running signal.
2. Search worker logs for `@service:bankai-worker @event:queue.depth.error`.
3. Confirm security-group connectivity and the worker Redis configuration without exposing secret values.
4. Restart the unhealthy Redis or worker task through ECS service reconciliation.
5. Recover after the Redis task is running and no queue-depth errors occur for 10 minutes.

## Queue depth and age

Metrics: `bankai.queue.depth` and `bankai.queue.oldest_waiting_age_ms`, grouped only by `queue`.

1. Open **Bankai nonprod — Workers** and identify the affected queue.
2. Compare waiting, active, retry, completion-duration, failed, and stalled signals.
3. Check worker desired/running count and Redis connectivity.
4. Inspect the oldest searchable job IDs without adding them as facets or metric dimensions.
5. Restore worker capacity or correct the blocking dependency. Do not purge queues without explicit owner approval.
6. Recover when depth and age remain below the approved per-queue threshold for 15 minutes.

## Failed or stalled jobs

1. Search `@service:bankai-worker @event:(queue.job.failed OR queue.job.stalled)` and group only by `queue`.
2. Follow the request ID into API and Quincy logs when correlation fields exist.
3. Check retry counts and completion duration before retrying work.
4. Correct the dependency or release problem, then use the application’s reviewed retry path.
5. Recover when no failed or stalled events occur for 10 minutes.

## Quincy failures

1. Open **Bankai nonprod — Quincy**.
2. Search `service:quincy @event:(quincy.scan.failed OR quincy.remediation.failed OR quincy.model.failed)`.
3. Confirm the Quincy ECS service is healthy and compare the failure with EFS and CodeBuild activity.
4. Check model or API failures without logging prompts, tokens, source contents, or endpoint secrets.
5. Roll back or restart Quincy through the reviewed release path.
6. Recover when the bounded failure signal is zero for 15 minutes.

## CodeBuild failures

Do not activate this monitor until a real `aws.codebuild.*` metric has been observed and its exact query recorded.

1. Open the Quincy remediation CodeBuild execution and identify the failing phase.
2. Correlate it with request ID, deployment ID, Git SHA, and Jenkins build.
3. Inspect sanitized build logs without copying source contents or secret values into Datadog.
4. Fix the build input or release and run a controlled nonproduction retry.
5. Recover when the next controlled build succeeds and the failure signal is clear for 15 minutes.

## EFS capacity

1. Identify the Quincy filesystem by its verified `filesystemid` before acting.
2. Check `aws.efs.storage_bytes` and available throughput or I/O signals.
3. Find unexpected growth using AWS and application metadata without tagging source paths or repositories as metrics.
4. Remove data only through the application’s reviewed retention or cleanup process.
5. Recover when usage remains below the approved warning level for 30 minutes.

## Missing telemetry

1. Confirm the API and worker ECS tasks are running.
2. Check the active CloudWatch groups and confirm each has exactly one Datadog Forwarder subscription.
3. Check Forwarder Lambda errors, throttles, and permissions.
4. Verify log queries use parsed attributes where required: `@service` and `@env`.
5. Recover after expected logs are visible continuously for 10 minutes.

## Post-deployment E2E failure

1. Open **Bankai nonprod — Delivery** and the failing Jenkins build.
2. Record deployment ID, Git SHA, Jenkins build, test stage, and correlation ID.
3. Follow the request from API to worker, Quincy, and CodeBuild where structured logs are available.
4. Roll back the release through `bankai-nonprod-release` when the deployment caused the failure.
5. Recover only after the next smoke or full E2E run succeeds.

## Controlled alert and recovery testing

For every critical monitor, record the trigger time, alert time, restoration time, recovery time, and Datadog/Jenkins links. Use a reversible nonproduction fault. Never delete production resources or purge live queues to create an alert.

## References

- [Phase 10 definitions](../delivery-platform/phase-10-runtime-observability.md)
- [Live validation record](../delivery-platform/observability-validation-2026-09-27.md)
- [Nonproduction deployment](../delivery-platform/phase-7-nonprod-deployment.md)
- [Integration E2E](../delivery-platform/phase-8-integration-e2e.md)
