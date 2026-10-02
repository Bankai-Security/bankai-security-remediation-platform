import { writeFile, mkdir } from 'node:fs/promises';

const site = process.env.DATADOG_SITE ?? 'datadoghq.com';
const apiKey = process.env.DD_API_KEY?.trim();
const appKey = process.env.DD_APP_KEY?.trim();
const dryRun = process.argv.includes('--dry-run');
const collectBaseline = process.argv.includes('--baseline');
const applyMetrics = process.argv.includes('--metrics') || process.argv.includes('--all');
const applyDashboards = process.argv.includes('--dashboards') || process.argv.includes('--all');

if (!applyMetrics && !applyDashboards && !collectBaseline) {
  throw new Error('choose --metrics, --dashboards, --baseline, or --all');
}
if (!dryRun && applyMetrics && applyDashboards) {
  throw new Error('live --all is disabled: apply and verify metrics before applying dashboards');
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
  const output = { logMetrics: applyMetrics ? logMetrics : [], dashboards: applyDashboards ? dashboards : [] };
  await writeFile('reports/observability/datadog-plan.json', `${JSON.stringify(output, null, 2)}\n`);
  console.log(`validated ${output.logMetrics.length} log metrics and ${output.dashboards.length} dashboards`);
} else {
  if (collectBaseline) await collectBaselines();
  if (applyMetrics) await reconcileMetrics();
  if (applyDashboards) await reconcileDashboards();
}
