import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
const pipeline = readFileSync(new URL('Jenkinsfile.observability', root), 'utf8');
for (const required of [
  "label 'linux'",
  "choices: ['metrics', 'dashboards', 'dry-run']",
  'jenkins-datadog-api-key',
  'jenkins-datadog-app-key',
  'configure-datadog.mjs --metrics',
  'configure-datadog.mjs --dashboards',
  'configure-datadog.mjs --all --dry-run',
]) {
  if (!pipeline.includes(required)) throw new Error(`missing observability pipeline control: ${required}`);
}
for (const forbidden of ['choices: [\'metrics\', \'dashboards\', \'all\'', 'configure-datadog.mjs --all ;;', 'monitor', 'slo']) {
  if (pipeline.toLowerCase().includes(forbidden)) throw new Error(`forbidden observability pipeline construct: ${forbidden}`);
}

const run = spawnSync(process.execPath, ['scripts/observability/configure-datadog.mjs', '--all', '--dry-run'], {
  cwd: root,
  encoding: 'utf8',
});
if (run.status !== 0) throw new Error(`observability dry-run failed:\n${run.stderr || run.stdout}`);

const reportUrl = new URL('reports/observability/datadog-plan.json', root);
const plan = JSON.parse(readFileSync(reportUrl, 'utf8'));
const expectedMetrics = [
  'bankai.queue.depth', 'bankai.queue.oldest_waiting_age_ms', 'bankai.queue.active',
  'bankai.queue.completed', 'bankai.queue.failed', 'bankai.queue.stalled',
  'bankai.queue.retries', 'bankai.queue.completion_duration_ms', 'bankai.api.requests',
  'bankai.api.errors_4xx', 'bankai.api.errors_5xx', 'bankai.api.request_latency_ms',
];
const metricIds = plan.logMetrics.map((item) => item.data.id);
if (JSON.stringify(metricIds) !== JSON.stringify(expectedMetrics)) throw new Error('unexpected or reordered log metric definitions');
if (new Set(metricIds).size !== metricIds.length) throw new Error('duplicate log metric id');

const allowedTags = new Set(['service', 'env', 'queue']);
for (const item of plan.logMetrics) {
  const tags = item.data.attributes.group_by.map((group) => group.tag_name);
  if (tags.some((tag) => !allowedTags.has(tag))) throw new Error(`unbounded group on ${item.data.id}: ${tags.join(', ')}`);
  if (item.data.id.startsWith('bankai.api.') && tags.includes('queue')) throw new Error(`API metric grouped by queue: ${item.data.id}`);
}

const expectedDashboards = [
  'Bankai nonprod — Platform health', 'Bankai nonprod — API', 'Bankai nonprod — Workers',
  'Bankai nonprod — Quincy', 'Bankai nonprod — Delivery',
];
if (JSON.stringify(plan.dashboards.map((item) => item.title)) !== JSON.stringify(expectedDashboards)) {
  throw new Error('expected exactly the five reviewed dashboards');
}
for (const dashboard of plan.dashboards) {
  const variables = dashboard.template_variables.map((item) => item.name).sort();
  if (JSON.stringify(variables) !== JSON.stringify(['env', 'service'])) throw new Error(`invalid template variables on ${dashboard.title}`);
}

rmSync(new URL('reports/observability', root), { recursive: true, force: true });
console.log('Observability policy passed: 12 bounded log metrics, 5 ordered dashboards, and no live combined apply.');
