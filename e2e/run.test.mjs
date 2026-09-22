import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('smoke runner verifies Redis, Quincy rejection, CloudFront, and cleanup', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.setHeader('access-control-allow-origin', `http://127.0.0.1:${server.address().port}`);
      return send(response, 200, { status: 'ok', redis: 'PONG', quincyConfigured: true, queues: { repoScan: {}, fixPr: {}, pipeline: {} } });
    }
    if (request.url === '/health') return send(response, 200, { status: 'ok' });
    if (request.url === '/triage/scan') return send(response, 401, { detail: 'invalid token' });
    if (request.url === '/assets/app.js') { response.writeHead(200, { 'content-type': 'application/javascript' }); return response.end('const api="127.0.0.1";'); }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<div id="root"></div><script src="/assets/app.js"></script>');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  const directory = mkdtempSync(join(tmpdir(), 'bankai-e2e-test-'));
  const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const child = spawn(process.execPath, [runner, '--mode', 'smoke'], { cwd: directory, env: { ...process.env, E2E_ALLOW_LOCAL: '1', E2E_API_URL: `http://127.0.0.1:${port}`, E2E_FRONTEND_URL: `http://127.0.0.1:${port}`, E2E_QUINCY_URL: `http://127.0.0.1:${port}` } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolveExit) => child.on('exit', resolveExit));
  server.close();
  assert.equal(status, 0, stderr);
  const report = readFileSync(join(directory, 'reports/e2e/junit.xml'), 'utf8');
  assert.match(report, /tests="4" failures="0"/);
  assert.match(report, /Cleanup isolated E2E resources/);
});

test('runner refuses production-looking targets before making requests', async () => {
  const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const child = spawn(process.execPath, [runner, '--mode', 'smoke'], { env: { ...process.env,
    E2E_API_URL: 'https://api.bankaisecurity.com', E2E_FRONTEND_URL: 'https://app.bankaisecurity.com',
    E2E_QUINCY_URL: 'http://quincy.production.bankai.local:8000',
  } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolveExit) => child.on('exit', resolveExit));
  assert.notEqual(status, 0);
  assert.match(stderr, /explicitly non-production/);
});

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
