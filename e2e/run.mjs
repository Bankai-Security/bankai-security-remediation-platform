import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'smoke';
if (!['smoke', 'full'].includes(mode)) throw new Error('--mode must be smoke or full');

const runId = process.env.E2E_RUN_ID ?? `bankai-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
const api = required('E2E_API_URL').replace(/\/$/, '');
const frontend = required('E2E_FRONTEND_URL').replace(/\/$/, '');
const quincy = required('E2E_QUINCY_URL').replace(/\/$/, '');
const localTest = process.env.E2E_ALLOW_LOCAL === '1' && process.env.NODE_ENV !== 'production';
if (!localTest) {
  for (const [name, value] of [['API', api], ['frontend', frontend]]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(nonprod|staging|test)/i.test(url.hostname)) {
      throw new Error(`${name} URL must be HTTPS and explicitly non-production: ${url.hostname}`);
    }
  }
  if (!/^https?:\/\/(quincy\.)?(nonprod|staging|test)[.-]/i.test(quincy)) {
    throw new Error('Quincy URL must use an explicitly non-production private hostname');
  }
}

const results = [];
let project = null;
let client;
let githubCleanup = null;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
function record(name, started, error = null) {
  results.push({ name, seconds: (Date.now() - started) / 1000, error: error ? String(error.stack ?? error) : null });
}
async function check(name, fn) {
  const started = Date.now();
  try { await fn(); record(name, started); }
  catch (error) { record(name, started, error); throw error; }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
async function json(response, expected) {
  const text = await response.text();
  assert(expected.includes(response.status), `expected HTTP ${expected.join('/')} from ${response.url}, received ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
async function poll(label, fn, timeoutMs = 20 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value.done) return value.value;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`${label} did not finish within ${timeoutMs}ms`);
}

class SessionClient {
  cookies = new Map();
  async request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('origin', frontend);
    headers.set('x-bankai-e2e-run-id', runId);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const response = await fetch(`${api}${path}`, { ...options, headers, signal: AbortSignal.timeout(30_000) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }
  post(path, body) { return this.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
}

async function smoke() {
  await check('Bankai API reaches Redis and exposes queue health', async () => {
    const response = await fetch(`${api}/healthz`, { headers: { origin: frontend, 'x-bankai-e2e-run-id': runId }, signal: AbortSignal.timeout(20_000) });
    const health = await json(response, [200]);
    assert(health.status === 'ok' && health.redis === 'PONG', 'Bankai health did not confirm Redis PONG');
    assert(health.quincyConfigured === true, 'Bankai is not configured for Quincy');
    assert(['repoScan', 'fixPr', 'pipeline'].every((queue) => health.queues?.[queue]), 'Bankai queue health is incomplete');
    assert(response.headers.get('access-control-allow-origin') === frontend, 'Bankai does not allow the CloudFront frontend origin');
  });
  await check('Quincy health and token rejection', async () => {
    const health = await json(await fetch(`${quincy}/health`, { signal: AbortSignal.timeout(20_000) }), [200]);
    assert(health.status === 'ok' || health.status === 'healthy', 'Quincy health response is not healthy');
    const rejected = await fetch(`${quincy}/triage/scan`, { method: 'POST', headers: { authorization: 'Bearer bankai-e2e-intentionally-invalid', 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20_000) });
    assert([401, 403].includes(rejected.status), `Quincy accepted an invalid service token (${rejected.status})`);
  });
  await check('CloudFront serves the frontend configured for Bankai', async () => {
    const response = await fetch(`${frontend}/`, { signal: AbortSignal.timeout(30_000) });
    const html = await response.text();
    assert(response.ok && /<div id=["']root["']/.test(html), 'CloudFront did not return the frontend boot document');
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)].map((match) => new URL(match[1], `${frontend}/`).href);
    assert(assets.length > 0, 'frontend document contains no versioned JS/CSS assets');
    const bodies = await Promise.all(assets.filter((url) => url.endsWith('.js')).map((url) => fetch(url).then((result) => result.text())));
    assert(bodies.some((body) => body.includes(new URL(api).hostname)), 'frontend bundle is not configured for the non-production Bankai API');
  });
}

async function fullWorkflow() {
  const email = required('E2E_USER_EMAIL');
  const password = required('E2E_USER_PASSWORD');
  const githubToken = required('E2E_GITHUB_TOKEN');
  const repository = required('E2E_GITHUB_REPOSITORY');
  const expectedRule = process.env.E2E_EXPECTED_RULE_ID ?? 'BANKAI-E2E-001';
  if (!/(^|\/|-)bankai-e2e([-/]|$)/i.test(repository)) throw new Error('E2E_GITHUB_REPOSITORY must be a dedicated bankai-e2e repository');
  githubCleanup = { repository, token: githubToken, pullRequest: null };
  client = new SessionClient();
  await check('Supabase-backed login and session', async () => {
    await json(await client.post('/api/auth/login', { email, password }), [200]);
    const session = await json(await client.request('/api/auth/session'), [200]);
    assert(session.user?.email?.toLowerCase() === email.toLowerCase(), 'Supabase session user mismatch');
  });
  const projectName = `Bankai E2E ${runId}`;
  await check('Create isolated E2E project', async () => {
    const result = await json(await client.post('/api/projects', { name: projectName, description: `Owned by ${runId}; safe to delete`, teamIds: [], services: ['e2e'] }), [201]);
    project = { id: result.project.id, name: projectName };
  });
  await check('Connect synthetic vulnerable repository', async () => {
    await json(await client.post(`/api/projects/${project.id}/github/connect`, { repo: repository, token: githubToken }), [200]);
  });
  await check('GitHub webhook rejects a bad signature', async () => {
    const response = await fetch(`${api}/api/webhooks/github/${project.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=bad' }, body: '{}', signal: AbortSignal.timeout(20_000) });
    assert(response.status === 401, `invalid webhook signature returned ${response.status}`);
  });
  let scan;
  await check('API enqueues scan and worker completes it', async () => {
    const queued = await json(await client.post(`/api/projects/${project.id}/github/scan`, {}), [202]);
    scan = await poll('synthetic repository scan', async () => {
      const current = await json(await client.request(`/api/projects/${project.id}/scans/${queued.scan.id}`), [200]);
      if (current.scan.status === 'Failed') throw new Error(`scan failed: ${current.scan.errorMessage ?? 'unknown error'}`);
      return { done: current.scan.status === 'Done', value: current.scan };
    });
    assert(scan.status === 'Done', 'worker did not complete the scan');
  });
  let ticket;
  await check('Seeded vulnerability becomes a remediation ticket', async () => {
    const listing = await json(await client.request(`/api/projects/${project.id}/findings`), [200]);
    const finding = listing.findings.find((item) => item.externalId === expectedRule);
    assert(finding, `expected seeded vulnerability ${expectedRule} was not detected`);
    const created = await json(await client.post(`/api/projects/${project.id}/tickets`, { findingIds: [finding.id] }), [201]);
    assert(created.tickets.length === 1 && created.queued.includes(finding.id), 'ticket was not created and queued for remediation');
    ticket = created.tickets[0];
  });
  await check('Quincy remediation, PR, verification, and ticket state converge', async () => {
    ticket = await poll('remediation workflow', async () => {
      const listing = await json(await client.request(`/api/projects/${project.id}/tickets`), [200]);
      const current = listing.tickets.find((item) => item.id === ticket.id);
      if (!current) throw new Error('ticket disappeared during remediation');
      const failure = current.githubPrError || current.ciError;
      if (failure && current.ciStatus === 'failed') throw new Error(`remediation failed: ${failure}`);
      return { done: Boolean(current.githubPrNumber) && current.ciStatus === 'passed', value: current };
    }, 45 * 60_000);
    assert(['In Review', 'Done'].includes(ticket.status), `unexpected final ticket status ${ticket.status}`);
    githubCleanup.pullRequest = ticket.githubPrNumber;
  });
  await check('Datadog receives correlation and no sentinel secret', async () => {
    const apiKey = required('DD_API_KEY');
    const appKey = required('DD_APP_KEY');
    const site = process.env.DATADOG_SITE ?? 'datadoghq.com';
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const search = async (query) => fetch(`https://api.${site}/api/v2/logs/events/search`, { method: 'POST', headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey, 'content-type': 'application/json' }, body: JSON.stringify({ filter: { from: 'now-30m', to: 'now', query }, page: { limit: 10 } }), signal: AbortSignal.timeout(30_000) }).then(async (response) => json(response, [200]));
    const correlated = await search(`env:nonprod ${runId}`);
    assert(correlated.data?.length > 0, 'Datadog has no correlated E2E telemetry');
    const leaked = await search(`"bankai-e2e-intentionally-invalid"`);
    assert((leaked.data?.length ?? 0) === 0, 'the secret-redaction sentinel appeared in Datadog logs');
  });
}

async function cleanup() {
  const errors = [];
  if (githubCleanup?.pullRequest) {
    try {
      const response = await fetch(`https://api.github.com/repos/${githubCleanup.repository}/pulls/${githubCleanup.pullRequest}`, {
        method: 'PATCH', headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${githubCleanup.token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
        body: JSON.stringify({ state: 'closed' }), signal: AbortSignal.timeout(30_000),
      });
      if (![200, 404].includes(response.status)) errors.push(`synthetic PR cleanup failed with HTTP ${response.status}`);
    } catch (error) { errors.push(`synthetic PR cleanup failed: ${error}`); }
  }
  if (project && client) {
    try {
      const response = await client.request(`/api/projects/${project.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmName: project.name }) });
      if (![200, 204, 404].includes(response.status)) errors.push(`project cleanup failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    } catch (error) { errors.push(`project cleanup failed: ${error}`); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}
async function writeReport() {
  await mkdir('reports/e2e', { recursive: true });
  const failures = results.filter((result) => result.error).length;
  const cases = results.map((result) => `<testcase classname="bankai.${mode}" name="${escapeXml(result.name)}" time="${result.seconds.toFixed(3)}">${result.error ? `<failure>${escapeXml(result.error)}</failure>` : ''}</testcase>`).join('');
  await writeFile('reports/e2e/junit.xml', `<?xml version="1.0" encoding="UTF-8"?><testsuite name="bankai-${mode}-e2e" tests="${results.length}" failures="${failures}">${cases}</testsuite>\n`);
  await writeFile('reports/e2e/result.json', `${JSON.stringify({ runId, mode, results }, null, 2)}\n`, { mode: 0o600 });
}
function escapeXml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

let failure;
try { await smoke(); if (mode === 'full') await fullWorkflow(); }
catch (error) { failure = error; }
finally {
  const cleanupStarted = Date.now();
  try { await cleanup(); record('Cleanup isolated E2E resources', cleanupStarted); }
  catch (error) { failure ??= error; record('Cleanup isolated E2E resources', cleanupStarted, error); }
  await writeReport();
}
if (failure) throw failure;
console.log(`Bankai ${mode} E2E passed (${runId}); ${results.length} checks, cleanup complete.`);
