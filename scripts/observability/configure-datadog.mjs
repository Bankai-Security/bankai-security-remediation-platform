import { writeFile, mkdir } from 'node:fs/promises';

const site = process.env.DATADOG_SITE ?? 'datadoghq.com';
const apiKey = process.env.DD_API_KEY?.trim();
const appKey = process.env.DD_APP_KEY?.trim();
const dryRun = process.argv.includes('--dry-run');
const collectBaseline = process.argv.includes('--baseline');
const validateMonitorsOnly = process.argv.includes('--monitor-validate');
const applyMetrics = process.argv.includes('--metrics') || process.argv.includes('--all');
const applyDashboards = process.argv.includes('--dashboards') || process.argv.includes('--all');
const applyMonitors = process.argv.includes('--monitors') || process.argv.includes('--all');

if (!applyMetrics && !applyDashboards && !applyMonitors && !validateMonitorsOnly && !collectBaseline) {
  throw new Error('choose --metrics, --dashboards, --monitor-validate, --monitors, --baseline, or --all');
}
if (!dryRun && [applyMetrics, applyDashboards, applyMonitors, validateMonitorsOnly, collectBaseline].filter(Boolean).length > 1) {
  throw new Error('live combined apply is disabled: run one reviewed observability gate at a time');
}
if (!dryRun && (!apiKey || !appKey)) {
  throw new Error('DD_API_KEY and DD_APP_KEY are required');
}

const boundedGroups = [
  { path: 'service', tag_name: 'service' },
  { path: '@env', tag_name: 'env' },
  { path: '@queue', tag_name: 'queue' },
];

const logMetrics = [
  metric('bankai.queue.depth', '@event:queue.depth', 'distribution', '@waiting'),
  metric('bankai.queue.oldest_waiting_age_ms', '@event:queue.depth', 'distribution', '@oldestWaitingAgeMs'),
  metric('bankai.queue.active', '@event:queue.depth', 'distribution', '@active'),
  metric('bankai.queue.completed', '@event:queue.job.completed'),
  metric('bankai.queue.failed', '@event:queue.job.failed'),
  metric('bankai.queue.stalled', '@event:queue.job.stalled'),
  metric('bankai.queue.retries', '@event:queue.job.active @attempt:>0'),
  metric('bankai.queue.completion_duration_ms', '@event:queue.job.completed', 'distribution', '@durationMs'),
  metric('bankai.api.requests', 'service:bankai-api "request completed"'),
  metric('bankai.api.errors_4xx', 'service:bankai-api @res.statusCode:[400 TO 499]'),
  metric('bankai.api.errors_5xx', 'service:bankai-api @res.statusCode:[500 TO 599]'),
  metric('bankai.api.request_latency_ms', 'service:bankai-api "request completed"', 'distribution', '@responseTime'),
];

function metric(id, query, aggregationType = 'count', path) {
  const compute = { aggregation_type: aggregationType };
  if (path) compute.path = path;
  if (aggregationType === 'distribution') compute.include_percentiles = true;
  return {
    data: {
      id,
      type: 'logs_metrics',
      attributes: { compute, filter: { query }, group_by: id.startsWith('bankai.queue.') ? boundedGroups : boundedGroups.slice(0, 2) },
    },
  };
}

const variables = [
  { name: 'env', prefix: 'env', default: 'nonprod' },
  { name: 'service', prefix: 'service', default: '*' },
];
const metricWidget = (title, queries) => ({
  definition: {
    type: 'timeseries', title, show_legend: true,
    requests: queries.map((query, index) => ({
      q: query,
      display_type: 'line',
      style: { palette: ['dog_classic', 'warm', 'cool', 'green', 'purple'][index % 5], line_type: 'solid', line_width: 'normal' },
    })),
  },
});
const logWidget = (title, query) => ({
  definition: { type: 'log_stream', title, query, columns: ['timestamp', 'service', 'message'], message_display: 'expanded-md', show_date_column: true, show_message_column: true },
});
const note = (content) => ({ definition: { type: 'note', content, background_color: 'gray', font_size: '14', text_align: 'left', vertical_align: 'top', show_tick: false } });
const dashboard = (title, widgets) => ({
  title,
  description: 'Bankai nonproduction runtime observability. Managed from scripts/observability/configure-datadog.mjs.',
  layout_type: 'ordered',
  reflow_type: 'fixed',
  template_variables: variables,
  widgets: widgets.map((widget, index) => ({
    ...widget,
    layout: {
      x: (index % 3) * 4,
      y: Math.floor(index / 3) * 3,
      width: 4,
      height: 3,
    },
  })),
});

const dashboards = [
  dashboard('Bankai nonprod — Platform health', [
    metricWidget('ECS desired versus running', ['avg:aws.ecs.service.desired{clustername:bankai-nonprod} by {servicename}', 'avg:aws.ecs.service.running{clustername:bankai-nonprod} by {servicename}']),
    metricWidget('ALB target 5xx', ['sum:aws.applicationelb.httpcode_target_5xx{loadbalancer:app/bankai-apise-*}.as_count()']),
    metricWidget('ALB p95 latency', ['avg:aws.applicationelb.target_response_time.p95{loadbalancer:app/bankai-apise-*}']),
    metricWidget('Redis service health', ['avg:aws.ecs.service.running{clustername:bankai-nonprod,servicename:*redis*} by {servicename}']),
    metricWidget('EFS storage bytes', ['max:aws.efs.storage_bytes{*} by {filesystemid}']),
    metricWidget('CloudFront requests and errors', ['sum:aws.cloudfront.requests{*} by {distributionid}.as_count()', 'avg:aws.cloudfront.4xx_error_rate{*}', 'avg:aws.cloudfront.5xx_error_rate{*}']),
    metricWidget('WAF activity', ['sum:aws.wafv2.allowed_requests{*} by {webacl}.as_count()', 'sum:aws.wafv2.blocked_requests{*} by {webacl}.as_count()']),
    note('CodeBuild widget pending the first observed aws.codebuild.* metric. Do not invent a query before it is visible.'),
  ]),
  dashboard('Bankai nonprod — API', [
    metricWidget('Request rate', ['sum:aws.applicationelb.request_count{loadbalancer:app/bankai-apise-*}.as_rate()']),
    metricWidget('Target 4xx and 5xx', ['sum:aws.applicationelb.httpcode_target_4xx{loadbalancer:app/bankai-apise-*}.as_count()', 'sum:aws.applicationelb.httpcode_target_5xx{loadbalancer:app/bankai-apise-*}.as_count()']),
    metricWidget('Latency p50 p95 p99', ['avg:aws.applicationelb.target_response_time.p50{loadbalancer:app/bankai-apise-*}', 'avg:aws.applicationelb.target_response_time.p95{loadbalancer:app/bankai-apise-*}', 'avg:aws.applicationelb.target_response_time.p99{loadbalancer:app/bankai-apise-*}']),
    logWidget('Health checks', 'service:bankai-api @req.url:/healthz'),
    logWidget('Authentication failures', 'service:bankai-api @req.url:/api/auth/* @res.statusCode:[400 TO 499]'),
    logWidget('Webhook failures', 'service:bankai-api @req.url:/api/webhooks/* @res.statusCode:[400 TO 599]'),
  ]),
  dashboard('Bankai nonprod — Workers', [
    metricWidget('Four queue depths', ['max:bankai.queue.depth{env:$env,service:$service} by {queue}']),
    metricWidget('Oldest waiting age', ['max:bankai.queue.oldest_waiting_age_ms{env:$env,service:$service} by {queue}']),
    metricWidget('Active jobs', ['max:bankai.queue.active{env:$env,service:$service} by {queue}']),
    metricWidget('Failed and stalled jobs', ['sum:bankai.queue.failed{env:$env,service:$service} by {queue}.as_count()', 'sum:bankai.queue.stalled{env:$env,service:$service} by {queue}.as_count()']),
    metricWidget('Retries', ['sum:bankai.queue.retries{env:$env,service:$service} by {queue}.as_count()']),
    metricWidget('Completion duration p50 p95 p99', ['p50:bankai.queue.completion_duration_ms{env:$env,service:$service} by {queue}', 'p95:bankai.queue.completion_duration_ms{env:$env,service:$service} by {queue}', 'p99:bankai.queue.completion_duration_ms{env:$env,service:$service} by {queue}']),
  ]),
  dashboard('Bankai nonprod — Quincy', [
    logWidget('Scan, remediation, and model failures', 'service:quincy @event:(quincy.scan.failed OR quincy.remediation.failed OR quincy.model.failed)'),
    metricWidget('Quincy service health', ['avg:aws.ecs.service.running{clustername:bankai-nonprod,servicename:bankai-nonprod-quincy}']),
    metricWidget('EFS capacity', ['max:aws.efs.storage_bytes{*} by {filesystemid}']),
    note('CodeBuild failure widget pending the first observed aws.codebuild.* metric.'),
  ]),
  dashboard('Bankai nonprod — Delivery', [
    metricWidget('Jenkins builds', ['sum:jenkins.job.started{*} by {job}.as_count()', 'sum:jenkins.job.completed{*} by {job,result}.as_count()']),
    metricWidget('Jenkins build duration', ['avg:jenkins.job.build_duration{*} by {job}']),
    logWidget('Deployment events', 'source:jenkins "Bankai nonprod deployment"'),
    logWidget('Release metadata', '@deployment.id:* @git.sha:* @jenkins.build:*'),
    logWidget('Post-deployment smoke and E2E results', 'source:jenkins ("Bankai smoke E2E passed" OR "Bankai full E2E passed" OR "E2E failure")'),
  ]),
];

const owner = 'Bankai Platform';
const runbook = 'https://github.com/Bankai-Security/bankai-security-remediation-platform/blob/main/docs/runbooks/bankai-nonprod-observability.md';
const notificationRoute = '@team-bankai-platform';
const monitorMessage = (severity, condition, recovery) => [
  `severity: ${severity}`,
  `owner: ${owner}`,
  `runbook: ${runbook}`,
  `alert condition: ${condition}`,
  `{{#is_alert}}Investigate in the matching Bankai nonprod dashboard and follow the runbook. ${notificationRoute}{{/is_alert}}`,
  `{{#is_recovery}}Recovery: ${recovery} ${notificationRoute}{{/is_recovery}}`,
].join('\n');
const monitor = (name, query, severity, condition, recovery, options = {}) => ({
  name,
  type: 'metric alert',
  query,
  message: monitorMessage(severity, condition, recovery),
  tags: ['env:nonprod', 'team:bankai-platform', `severity:${severity}`, 'managed-by:bankai-observability'],
  priority: severity === 'critical' ? 1 : 2,
  options: {
    include_tags: true,
    notify_audit: false,
    require_full_window: false,
    thresholds: { critical: Number(query.match(/ ([<>]) ([0-9.]+)$/)?.[2]) },
    ...options,
  },
});

// Thresholds are based on the three-day baseline collected by Jenkins build #10.
// Deferred: queue depth/age (zero/no series), Quincy and CodeBuild (no bounded signal),
// and EFS capacity (elastic storage with no approved capacity policy).
const monitors = [
  monitor(
    '[nonprod] Bankai API target 5xx',
    'sum(last_10m):sum:aws.applicationelb.httpcode_target_5xx{loadbalancer:app/bankai-apise-*}.as_count() > 0',
    'critical',
    'Any ALB target 5xx in 10 minutes; the observed three-day baseline was zero.',
    'ALB target 5xx remains zero for 10 minutes.',
  ),
  monitor(
    '[nonprod] Bankai API p95 latency',
    'avg(last_15m):avg:aws.applicationelb.target_response_time.p95{loadbalancer:app/bankai-apise-*} > 0.05',
    'warning',
    'ALB p95 latency exceeds 50 ms for 15 minutes; the observed maximum was about 10 ms.',
    'ALB p95 latency remains at or below 50 ms for 15 minutes.',
  ),
  monitor(
    '[nonprod] Bankai API unhealthy ALB targets',
    'max(last_5m):max:aws.applicationelb.un_healthy_host_count{targetgroup:targetgroup/bankai-apise-*} > 0',
    'critical',
    'One or more API ALB targets are unhealthy for five minutes.',
    'Unhealthy target count remains zero for five minutes.',
  ),
  monitor(
    '[nonprod] Bankai ECS desired/running mismatch',
    'max(last_10m):max:aws.ecs.service.desired{clustername:bankai-nonprod} by {servicename} - max:aws.ecs.service.running{clustername:bankai-nonprod} by {servicename} > 0',
    'critical',
    'Desired tasks exceed running tasks for a bounded ECS service for 10 minutes.',
    'Desired and running task counts match for 10 minutes.',
    { new_group_delay: 300 },
  ),
  monitor(
    '[nonprod] Bankai Redis service unavailable',
    'min(last_10m):min:aws.ecs.service.running{clustername:bankai-nonprod,servicename:*redis*} by {servicename} < 1',
    'critical',
    'The Redis ECS service has fewer than one running task for 10 minutes.',
    'The Redis task remains running for 10 minutes.',
    { new_group_delay: 300 },
  ),
  monitor(
    '[nonprod] Bankai failed or stalled queue jobs',
    'sum(last_10m):sum:bankai.queue.failed{env:nonprod} by {queue}.as_count() + sum:bankai.queue.stalled{env:nonprod} by {queue}.as_count() > 0',
    'critical',
    'A failed or stalled job is observed in a bounded queue within 10 minutes.',
    'No failed or stalled jobs are observed for 10 minutes.',
    { new_group_delay: 300 },
  ),
  monitor(
    '[nonprod] Bankai API telemetry missing',
    'sum(last_10m):sum:bankai.api.requests{env:nonprod}.as_count() < 1',
    'warning',
    'No parsed API request events are observed for 10 minutes; the baseline showed continuous traffic.',
    'Parsed API request telemetry remains visible for 10 minutes.',
    { notify_no_data: true, no_data_timeframe: 10 },
  ),
  monitor(
    '[nonprod] Bankai worker telemetry missing',
    'max(last_10m):max:bankai.queue.depth{env:nonprod} by {queue} < 0',
    'warning',
    'No queue-depth telemetry is observed for 10 minutes across the four bounded queues.',
    'Queue-depth telemetry remains visible for 10 minutes.',
    { notify_no_data: true, no_data_timeframe: 10, new_group_delay: 300 },
  ),
  monitor(
    '[nonprod] Bankai post-deployment E2E failure',
    'sum(last_10m):sum:jenkins.job.completed{job:bankai-nonprod-e2e,result:failure}.as_count() > 0',
    'critical',
    'The nonproduction E2E Jenkins job reports a failure within 10 minutes.',
    'The next post-deployment E2E run succeeds.',
  ),
];

const baselineQueries = {
  api_5xx_count: 'sum:aws.applicationelb.httpcode_target_5xx{loadbalancer:app/bankai-apise-*}.as_count()',
  api_p95_latency: 'avg:aws.applicationelb.target_response_time.p95{loadbalancer:app/bankai-apise-*}',
  unhealthy_targets: 'max:aws.applicationelb.un_healthy_host_count{targetgroup:targetgroup/bankai-apise-*}',
  ecs_desired: 'avg:aws.ecs.service.desired{clustername:bankai-nonprod} by {servicename}',
  ecs_running: 'avg:aws.ecs.service.running{clustername:bankai-nonprod} by {servicename}',
  redis_running: 'avg:aws.ecs.service.running{clustername:bankai-nonprod,servicename:*redis*} by {servicename}',
  queue_depth: 'max:bankai.queue.depth{env:nonprod} by {queue}',
  queue_oldest_waiting_age_ms: 'max:bankai.queue.oldest_waiting_age_ms{env:nonprod} by {queue}',
  queue_failed: 'sum:bankai.queue.failed{env:nonprod} by {queue}.as_count()',
  queue_stalled: 'sum:bankai.queue.stalled{env:nonprod} by {queue}.as_count()',
  api_requests: 'sum:bankai.api.requests{env:nonprod}.as_count()',
  efs_storage_bytes: 'max:aws.efs.storage_bytes{*} by {filesystemid}',
  e2e_failures: 'sum:jenkins.job.completed{job:bankai-nonprod-e2e,result:failure}.as_count()',
  usage_logs_ingested_bytes: 'sum:datadog.estimated_usage.logs.ingested_bytes{*}.as_count()',
  usage_custom_metrics: 'max:datadog.estimated_usage.metrics.custom.ingested{*}',
  usage_apm_ingested_bytes: 'sum:datadog.estimated_usage.apm.ingested_bytes{*}.as_count()',
  usage_apm_ingested_spans: 'sum:datadog.estimated_usage.apm.ingested_spans{*}.as_count()',
  usage_apm_ingested_traces: 'sum:datadog.estimated_usage.apm.ingested_traces{*}.as_count()',
  usage_apm_indexed_spans: 'sum:datadog.estimated_usage.apm.indexed_spans{*}.as_count()',
};

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.${site}${path}`, {
    method,
    headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}

async function reconcileMetrics() {
  const current = await request('/api/v2/logs/config/metrics');
  const existing = new Set((current.data ?? []).map((item) => item.id));
  for (const definition of logMetrics) {
    if (existing.has(definition.data.id)) {
      const attributes = definition.data.attributes;
      await request(`/api/v2/logs/config/metrics/${encodeURIComponent(definition.data.id)}`, { method: 'PATCH', body: { data: { id: definition.data.id, type: 'logs_metrics', attributes } } });
      console.log(`updated log metric ${definition.data.id}`);
    } else {
      await request('/api/v2/logs/config/metrics', { method: 'POST', body: definition });
      console.log(`created log metric ${definition.data.id}`);
    }
  }
}

async function reconcileDashboards() {
  const current = await request('/api/v1/dashboard');
  const byTitle = new Map((current.dashboards ?? []).map((item) => [item.title, item.id]));
  for (const definition of dashboards) {
    const id = byTitle.get(definition.title);
    if (id) {
      await request(`/api/v1/dashboard/${encodeURIComponent(id)}`, { method: 'PUT', body: definition });
      console.log(`updated dashboard ${definition.title}`);
    } else {
      await request('/api/v1/dashboard', { method: 'POST', body: definition });
      console.log(`created dashboard ${definition.title}`);
    }
  }
}

async function reconcileMonitors() {
  await validateMonitorDefinitions();
  const current = await request('/api/v1/monitor?with_downtimes=false');
  const byName = new Map((current ?? []).map((item) => [item.name, item.id]));
  for (const definition of monitors) {
    const id = byName.get(definition.name);
    if (id) {
      await request(`/api/v1/monitor/${encodeURIComponent(id)}`, { method: 'PUT', body: definition });
      console.log(`updated monitor ${definition.name}`);
    } else {
      await request('/api/v1/monitor', { method: 'POST', body: definition });
      console.log(`created monitor ${definition.name}`);
    }
  }
}

async function validateMonitorDefinitions() {
  for (const definition of monitors) {
    await request('/api/v1/monitor/validate', { method: 'POST', body: definition });
    console.log(`validated monitor ${definition.name}`);
  }
}

function summarizeSeries(series) {
  const values = (series.pointlist ?? []).map(([, value]) => value).filter(Number.isFinite);
  return {
    scope: series.scope,
    expression: series.expression,
    unit: series.unit?.[0]?.name ?? null,
    points: values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    average: values.length ? values.reduce((total, value) => total + value, 0) / values.length : null,
    last: values.at(-1) ?? null,
  };
}

async function collectBaselines() {
  const to = Math.floor(Date.now() / 1000);
  const from = to - (3 * 24 * 60 * 60);
  const report = { from, to, window_days: 3, queries: {} };
  for (const [name, query] of Object.entries(baselineQueries)) {
    try {
      const path = `/api/v1/query?from=${from}&to=${to}&query=${encodeURIComponent(query)}`;
      const response = await request(path);
      report.queries[name] = { query, status: response.status, series: (response.series ?? []).map(summarizeSeries) };
      console.log(`baseline ${name}: ${report.queries[name].series.length} series`);
    } catch (error) {
      report.queries[name] = { query, error: error.message };
      console.log(`baseline ${name}: unavailable (${error.message})`);
    }
  }
  await writeFile('reports/observability/datadog-baseline.json', `${JSON.stringify(report, null, 2)}\n`);
}

await mkdir('reports/observability', { recursive: true });
if (dryRun) {
  const output = {
    logMetrics: applyMetrics ? logMetrics : [],
    dashboards: applyDashboards ? dashboards : [],
    monitors: applyMonitors || validateMonitorsOnly ? monitors : [],
  };
  await writeFile('reports/observability/datadog-plan.json', `${JSON.stringify(output, null, 2)}\n`);
  console.log(`validated ${output.logMetrics.length} log metrics and ${output.dashboards.length} dashboards`);
} else {
  if (collectBaseline) await collectBaselines();
  if (validateMonitorsOnly) await validateMonitorDefinitions();
  if (applyMetrics) await reconcileMetrics();
  if (applyDashboards) await reconcileDashboards();
  if (applyMonitors) await reconcileMonitors();
}
