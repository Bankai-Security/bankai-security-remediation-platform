#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import https from 'node:https';

const configDir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'BankaiLocalRunner');
const configPath = join(configDir, 'config.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => `sha256-${createHash('sha256').update(bytes).digest('hex')}`;

function credentialStore(action, target, secret = '') {
  const source = `using System; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public static class BankaiCredentialStore {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  public static void Write(string target, string value) {
    var bytes = System.Text.Encoding.Unicode.GetBytes(value); var memory = Marshal.AllocHGlobal(bytes.Length);
    try { Marshal.Copy(bytes,0,memory,bytes.Length); var credential = new CREDENTIAL { Type=1, TargetName=target, UserName=Environment.UserName, CredentialBlobSize=(UInt32)bytes.Length, CredentialBlob=memory, Persist=2 };
      if (!CredWrite(ref credential,0)) throw new InvalidOperationException("credential_write_failed");
    } finally { Marshal.ZeroFreeGlobalAllocUnicode(memory); }
  }
  public static string Read(string target) {
    IntPtr pointer; if (!CredRead(target,1,0,out pointer)) throw new InvalidOperationException("credential_read_failed");
    try { var credential=(CREDENTIAL)Marshal.PtrToStructure(pointer,typeof(CREDENTIAL)); return Marshal.PtrToStringUni(credential.CredentialBlob,(int)credential.CredentialBlobSize/2); }
    finally { CredFree(pointer); }
  }
}`;
  const script = "$request=ConvertFrom-Json ([Console]::In.ReadToEnd()); Add-Type -TypeDefinition $request.source; if ($request.action -eq 'write') { [BankaiCredentialStore]::Write($request.target,$request.secret); [Console]::Out.Write('ok') } else { [Console]::Out.Write([BankaiCredentialStore]::Read($request.target)) }";
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify({ action, target, secret, source }), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024,
  });
  if (result.status !== 0 || !result.stdout) throw new Error('Windows Credential Manager access failed.');
  return result.stdout;
}

function saveConfig(config) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function loadConfig() {
  try { readFileSync(configPath, 'utf8'); } catch { throw new Error('Runner is not paired. Set BANKAI_API_URL, BANKAI_PAIRING_CODE, QUINCY_API_URL, and QUINCY_API_TOKEN, then run pair.'); }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  return { ...config, bankaiToken: credentialStore('read', config.bankaiCredentialTarget), quincyToken: credentialStore('read', config.quincyCredentialTarget) };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  if (!response.ok) throw new Error(`Service request failed (${response.status}).`);
  return response.json();
}

export async function pair({ onLog = (message) => console.log(message) } = {}) {
  const bankaiUrl = process.env.BANKAI_API_URL?.replace(/\/$/, '');
  const quincyUrl = process.env.QUINCY_API_URL?.replace(/\/$/, '');
  const pairingCode = process.env.BANKAI_PAIRING_CODE;
  const quincyToken = process.env.QUINCY_API_TOKEN;
  if (!bankaiUrl || !quincyUrl || !pairingCode || !quincyToken) throw new Error('Pairing requires BANKAI_API_URL, BANKAI_PAIRING_CODE, QUINCY_API_URL, and QUINCY_API_TOKEN.');
  const bankaiOrigin = new URL(bankaiUrl);
  const quincyOrigin = new URL(quincyUrl);
  if (bankaiOrigin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(bankaiOrigin.hostname)) throw new Error('Bankai API must use HTTPS outside loopback development.');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(quincyOrigin.hostname) || !['http:', 'https:'].includes(quincyOrigin.protocol)) throw new Error('Local Quincy API must use a loopback address.');
  const readiness = await checkReadiness(quincyUrl);
  const publicKey = randomBytes(32).toString('base64url');
  const enrolled = await requestJson(`${bankaiUrl}/api/local-runner/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairingCode, public_key: publicKey, capabilities: {
      protocol_version: '1', companion_version: '0.1.0', platforms: ['windows'], ...readiness, max_concurrent_jobs: 1,
    } }),
  });
  const bankaiCredentialTarget = `BankaiLocalRunner:${enrolled.runner_id}:BankaiApi`;
  const quincyCredentialTarget = `BankaiLocalRunner:${enrolled.runner_id}:QuincyApi`;
  credentialStore('write', bankaiCredentialTarget, enrolled.access_token);
  credentialStore('write', quincyCredentialTarget, quincyToken);
  saveConfig({ bankaiUrl, quincyUrl, publicKey, runnerId: enrolled.runner_id,
    bankaiCredentialTarget, quincyCredentialTarget,
    jenkinsCaPath: process.env.QUINCY_JENKINS_CA || null });
  delete process.env.BANKAI_PAIRING_CODE;
  delete process.env.QUINCY_API_TOKEN;
  onLog(`Paired runner ${enrolled.runner_id}. Credentials are protected for this Windows user.`);
}

function httpsHealth(url, caPath) {
  return new Promise((resolve) => {
    let ca;
    try { ca = caPath ? readFileSync(caPath) : undefined; } catch { resolve(false); return; }
    const request = https.get(url, { ca, rejectUnauthorized: true, timeout: 3000 }, (response) => {
      response.resume(); resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function checkReadiness(quincyUrl, caPath = process.env.QUINCY_JENKINS_CA) {
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const dockerReady = docker.status === 0 && Boolean(docker.stdout.trim());
  const jenkinsReady = await httpsHealth('https://localhost:8443/login', caPath);
  let quincyReady = false;
  try { const response = await fetch(`${quincyUrl}/health`, { signal: AbortSignal.timeout(3000) }); quincyReady = response.ok; } catch { /* Report not ready without exposing service details. */ }
  return { docker_ready: dockerReady, jenkins_ready: jenkinsReady, quincy_ready: quincyReady };
}

async function api(config, path, options = {}) {
  return requestJson(`${config.bankaiUrl}/api/local-runner${path}`, {
    ...options, headers: { authorization: `Bearer ${config.bankaiToken}`, ...options.headers },
  });
}

async function quincy(config, path, options = {}) {
  return requestJson(`${config.quincyUrl}${path}`, {
    ...options, headers: { authorization: `Bearer ${config.quincyToken}`, ...options.headers },
  });
}

async function reportProgress(config, task, sequence, stage, status, message) {
  return api(config, `/tasks/${encodeURIComponent(task.execution_id)}/progress`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      protocol_version: '1', lease_id: task.lease_id, execution_id: task.execution_id,
      sequence, stage, status, occurred_at: new Date().toISOString(), message,
      idempotency_key: `progress:${task.execution_id}:${sequence}`,
    }),
  });
}

async function runTask(config, task, signal) {
  let sequence = 0;
  await reportProgress(config, task, sequence++, 'preparing_environment', 'started', 'Checking local Quincy and Jenkins readiness.');
  const request = {
    schema_version: '1.0', idempotency_key: `bankai-local-attempt:${task.attempt_id}`,
    repository: { kind: 'github_url', value: `https://github.com/${task.repository}` },
    repository_id: `quincy-repository-${createHash('sha256').update(`github_url:https://github.com/${task.repository}`).digest('hex')}`,
    baseline_sha: task.baseline_sha, candidate_sha: task.candidate_sha,
    target: { legacy_fingerprint: task.target.legacy_fingerprint, occurrence_id: task.target.occurrence_id,
      rule_id: task.target.external_id, file_path: task.target.file_path },
    profile: task.profile, timeout_seconds: 1800, policy_id: task.policy_id,
    bankai_correlation: { remediation_id: task.remediation_id, attempt_id: task.attempt_id,
      finding_id: task.finding_id, base_sha: task.baseline_sha },
  };
  const started = await quincy(config, '/v1/verifications', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  });
  const quincyId = started.execution_id;
  await reportProgress(config, task, sequence++, 'checkout', 'started', 'Quincy accepted the exact candidate revision.');
  let lastHeartbeat = 0;
  let cancelSent = false;
  let status;
  while (true) {
    if (Date.now() - lastHeartbeat > 20_000) {
      await api(config, `/tasks/${encodeURIComponent(task.execution_id)}/heartbeat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          protocol_version: '1', lease_id: task.lease_id, execution_id: task.execution_id,
          heartbeat_id: `heartbeat:${task.execution_id}:${randomUUID()}`, reported_at: new Date().toISOString(),
        }),
      });
      lastHeartbeat = Date.now();
    }
    const control = await api(config, `/tasks/${encodeURIComponent(task.execution_id)}`);
    if ((control.cancel_requested || signal?.aborted) && !cancelSent) {
      await quincy(config, `/v1/verifications/${encodeURIComponent(quincyId)}/cancel`, { method: 'POST' }).catch(() => undefined);
      cancelSent = true;
    }
    status = await quincy(config, `/v1/verifications/${encodeURIComponent(quincyId)}`);
    if (!['queued', 'running'].includes(status.state)) break;
    await sleep(2500);
  }
  const manifest = status.verification_manifest;
  if (!manifest) throw new Error('Quincy did not finalize a verification manifest.');
  const rawArtifacts = {};
  for (const name of ['build-log', 'test-report', 'scan-evidence']) {
    const response = await fetch(`${config.quincyUrl}/v1/verifications/${encodeURIComponent(quincyId)}/artifacts/${name}`, {
      headers: { authorization: `Bearer ${config.quincyToken}` },
    });
    if (!response.ok) throw new Error(`Quincy ${name} artifact could not be retrieved.`);
    rawArtifacts[name] = Buffer.from(await response.arrayBuffer());
  }
  await reportProgress(config, task, sequence++, 'artifact_upload', 'started', 'Transferring Quincy artifacts to Bankai.');
  const descriptors = [];
  for (const [name, bytes] of Object.entries(rawArtifacts)) {
    const form = new FormData();
    form.set('lease_id', task.lease_id);
    form.set('name', name);
    form.set('artifact', new Blob([bytes], { type: 'application/octet-stream' }), `${name}.bin`);
    const response = await fetch(`${config.bankaiUrl}/api/local-runner/tasks/${encodeURIComponent(task.execution_id)}/artifacts`, {
      method: 'POST', headers: { authorization: `Bearer ${config.bankaiToken}` }, body: form,
    });
    if (!response.ok) throw new Error(`Bankai rejected the ${name} artifact (${response.status}).`);
    descriptors.push({ name, size_bytes: bytes.byteLength, digest: sha256(bytes), content_type: 'application/octet-stream' });
  }
  await reportProgress(config, task, sequence++, 'artifact_upload', 'completed', 'All Quincy artifacts were uploaded and hashed.');
  const outcome = ({ passed: 'passed', failed: 'failed', cancelled: 'cancelled', timed_out: 'incomplete', incomplete: 'incomplete', infrastructure_failure: 'infrastructure_failure' })[manifest.state];
  if (!outcome) throw new Error('Quincy returned an unsupported terminal state.');
  return api(config, `/tasks/${encodeURIComponent(task.execution_id)}/result`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      protocol_version: '1', lease_id: task.lease_id, execution_id: task.execution_id,
      quincy_execution_id: quincyId, attempt_id: task.attempt_id,
      idempotency_key: `result:${task.execution_id}:${manifest.integrity_digest}`,
      outcome, manifest, artifacts: descriptors, completed_at: new Date().toISOString(),
    }),
  });
}

export async function main({ signal, onLog = (level, message) => console[level === 'error' ? 'error' : 'log'](message) } = {}) {
  if (process.argv[2] === 'pair') return pair();
  const config = loadConfig();
  let readiness = { docker_ready: false, jenkins_ready: false, quincy_ready: false };
  const refreshReadiness = async () => {
    readiness = await checkReadiness(config.quincyUrl, config.jenkinsCaPath);
    await api(config, '/capabilities', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      protocol_version: '1', companion_version: '0.1.0', platforms: ['windows'], ...readiness, max_concurrent_jobs: 1,
    }) });
  };
  await refreshReadiness();
  while (!signal?.aborted) {
    if (!readiness.docker_ready || !readiness.jenkins_ready || !readiness.quincy_ready) {
      onLog('info', 'Waiting for Docker Desktop, trusted local Jenkins TLS, and local Quincy API readiness.');
      await sleep(15_000);
      if (signal?.aborted) break;
      try { await refreshReadiness(); } catch { /* Keep the last safe capabilities; next retry refreshes them. */ }
      continue;
    }
    try {
      const { task } = await api(config, '/tasks/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!task) { await sleep(3000); continue; }
      onLog('info', `Claimed verification ${task.execution_id} for ${task.repository} at ${task.candidate_sha.slice(0, 12)}.`);
      try { await runTask(config, task, signal); onLog('info', `Completed local verification ${task.execution_id}.`); }
      catch { onLog('error', `Verification ${task.execution_id} stopped without an accepted result; lease recovery will mark it incomplete.`); }
    } catch {
      onLog('error', 'Bankai runner request failed; retrying shortly.');
      await sleep(5000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Local runner failed.'); process.exitCode = 1; });
}
