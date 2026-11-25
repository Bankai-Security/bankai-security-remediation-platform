const { app, BrowserWindow, WebContentsView, Menu, shell, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { buildEndpoint, resolveQueueUrl } = require('./jenkins-build-request.cjs');
const { repositoryName, pipelineUrl, pipelineConfigXml, jobsForRepository } = require('./jenkins-multibranch.cjs');
const { isCurrentIndexing, indexingFinished, summarizeIndexingLog, rateLimitDelayMs } = require('./jenkins-indexing.cjs');

// GitHub Branch Source can pause PR builds for many minutes while anonymous
// GitHub API requests are rate limited. Keep observing the same Jenkins build
// long enough for that delay instead of reporting a false timeout.
const JENKINS_BUILD_TIMEOUT_MS = 60 * 60_000;

// Bankai uses in-window controls and has no native menu commands. Remove
// Electron's default File/Edit/View/Window/Help menu on Windows.
if (process.platform === 'win32') Menu.setApplicationMenu(null);

// Host the same frontend origin as the web app. This keeps Bankai's cookie
// session, API runtime config, and OAuth callbacks on their registered origins.
const WEB_URL = process.env.BANKAI_WEB_URL || 'https://bankai-frontend-staging.up.railway.app';
const WEB_ORIGIN = new URL(WEB_URL).origin;
const isLocalDev = WEB_URL.startsWith('http://localhost:');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let mainWindow;
let jenkinsBrowserView;
const JENKINS_STORE = () => path.join(app.getPath('userData'), 'jenkins-connection.bin');

function validateJenkinsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid Jenkins address.'); }
  if (url.username || url.password || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use an HTTPS address, or an HTTP localhost address for Jenkins.');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}
async function readJenkinsCredentials() {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer.');
    const encrypted = await fs.readFile(JENKINS_STORE());
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function saveJenkinsCredentials(credentials) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer.');
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const temporary = `${JENKINS_STORE()}.tmp`;
  await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 });
  await fs.rename(temporary, JENKINS_STORE());
}
function jenkinsHeaders(credentials, extra = {}) {
  const auth = Buffer.from(`${credentials.username}:${credentials.apiToken}`).toString('base64');
  return { Authorization: `Basic ${auth}`, Accept: 'application/json', ...extra };
}
async function jenkinsFetch(credentials, url, options = {}) {
  const target = new URL(url);
  const base = new URL(credentials.url);
  if (target.username || target.password || target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')) {
    throw new Error('Jenkins returned a link outside the configured server.');
  }
  const canRetry = (options.method || 'GET').toUpperCase() === 'GET';
  for (let attempt = 0; attempt < (canRetry ? 3 : 1); attempt += 1) {
    let response;
    try {
      response = await fetch(target, { ...options, headers: jenkinsHeaders(credentials, options.headers), signal: AbortSignal.timeout(15000), redirect: 'manual' });
    } catch (error) {
      if (attempt + 1 < (canRetry ? 3 : 1)) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        continue;
      }
      if (error.name === 'TimeoutError') throw new Error('Jenkins timed out. Check its status, then reconnect or retry from the Bankai Jenkins page.');
      throw new Error('Jenkins is unreachable. Check that it is running and the address is correct, then reconnect from the Bankai Jenkins page.');
    }
    if (canRetry && (response.status === 429 || response.status >= 500) && attempt + 1 < 3) {
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfterSeconds) ? Math.min(Math.max(retryAfterSeconds, 0) * 1000, 2500) : 400 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    if (response.status === 429) throw new Error('Jenkins is rate limiting requests. Wait briefly, then refresh jobs or retry the build.');
    if (response.status >= 500) {
      const method = (options.method || 'GET').toUpperCase();
      let detail = '';
      try {
        detail = (await response.clone().text())
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, ' ')
          .replace(/(authorization|api[_-]?token|password|secret|crumb)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
          .replace(/\s+/g, ' ').trim().slice(0, 400);
      } catch { /* Jenkins may not return a readable error body. */ }
      throw new Error(`Jenkins returned HTTP ${response.status} for ${method} ${target.pathname}.${detail ? ` ${detail}` : ' Check the Jenkins controller log for this request.'}`);
    }
    if (response.status === 401 || response.status === 403) throw new Error('Jenkins rejected the saved credentials or permissions. Reconnect with a valid Jenkins API token.');
    return response;
  }
  throw new Error('Jenkins is temporarily unavailable. Check the server, then retry from Bankai.');
}
function jenkinsApiUrl(base, relative) {
  return `${base.replace(/\/$/, '')}/${relative.replace(/^\//, '')}`;
}
function validateJenkinsResourceUrl(credentials, rawUrl) {
  const target = new URL(rawUrl);
  const base = new URL(credentials.url);
  if (target.username || target.password || target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/job/')) {
    throw new Error('Choose a job or build from the connected Jenkins server.');
  }
  target.search = '';
  target.hash = '';
  return target;
}
async function getJenkinsJobParameters(credentials, jobUrl) {
  const target = validateJenkinsResourceUrl(credentials, jobUrl);
  const response = await jenkinsFetch(credentials, `${target.toString().replace(/\/$/, '')}/api/json?tree=property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]`);
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Jenkins rejected the credentials or they lack permission to inspect job parameters.' : `Could not inspect Jenkins job parameters (HTTP ${response.status}).`);
  const data = await response.json();
  const definitions = (data.property || []).flatMap((item) => item.parameterDefinitions || []);
  const sensitive = definitions.find((item) => /password|token|secret|credential|private[_-]?key/i.test(`${item.name} ${item.type}`));
  if (sensitive) return { supported: false, reason: 'This job declares a secret parameter. Remove it from the job parameters and keep secrets in Jenkins credentials.', parameters: [] };
  const parameters = definitions.map((item) => ({
    name: String(item.name || ''),
    type: String(item.type || 'StringParameterDefinition'),
    description: String(item.description || '').slice(0, 300),
    defaultValue: String(item.defaultParameterValue?.value ?? ''),
    choices: Array.isArray(item.choices) ? item.choices.map(String).slice(0, 100) : [],
  })).filter((item) => item.name && item.name.length <= 100);
  return { supported: true, reason: null, parameters };
}
async function listJenkinsJobs(credentials, repo = null) {
  const jobs = [];
  const visit = async (url, depth = 0, underMultibranch = false) => {
    if (depth > 8 || jobs.length >= 300) return;
    const response = await jenkinsFetch(credentials, `${url.replace(/\/$/, '')}/api/json?tree=jobs[name,url,color,_class,properties[*]]`);
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Jenkins rejected the credentials or they lack permission to read jobs.' : `Could not list Jenkins jobs (HTTP ${response.status}).`);
    const data = await response.json();
    for (const item of data.jobs || []) {
      const jobClass = String(item._class || '').toLowerCase();
      const isMultibranch = jobClass.includes('multibranch');
      const isFolder = jobClass.includes('folder') || isMultibranch || jobClass.includes('computedfolder');
      if (isMultibranch && item.url) jobs.push({ name: item.name, url: item.url, color: item.color || '', supportsPullRequests: true });
      if (isFolder && item.url) await visit(item.url, depth + 1, underMultibranch || isMultibranch);
      else if (!isMultibranch) {
        const properties = Array.isArray(item.properties) ? item.properties : [];
        const branch = properties.find((property) => property && (property.branch || property._class?.includes('BranchJobProperty')))?.branch;
        const head = branch?.head || {};
        const pullRequestNumber = Number(head.number ?? head.id);
        const headClass = String(head._class || '').toLowerCase();
        const pullRequest = underMultibranch && (headClass.includes('pullrequest') || headClass.includes('prhead'));
        jobs.push({ name: item.name, url: item.url, color: item.color || '', supportsPullRequests: Boolean(pullRequest),
          ...(pullRequest ? { ...(Number.isInteger(pullRequestNumber) && pullRequestNumber > 0 ? { pullRequestNumber } : {}), branchName: typeof head.name === 'string' ? head.name : undefined } : {}) });
      }
    }
  };
  await visit(credentials.url);
  return typeof repo === 'string' ? jobsForRepository(jobs, credentials.url, repo) : jobs;
}
function jenkinsCrumbHeaders(crumb) {
  return crumb?.crumbRequestField && crumb?.crumb ? { [crumb.crumbRequestField]: crumb.crumb } : {};
}
async function createRepositoryMultibranchPipeline(credentials, repo) {
  const { owner, repository, name } = repositoryName(repo);
  const jobsResponse = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'api/json?tree=jobs[name,url,_class]'));
  if (!jobsResponse.ok) throw new Error(`Could not inspect Jenkins jobs (HTTP ${jobsResponse.status}).`);
  const jobs = (await jobsResponse.json()).jobs || [];
  const existing = jobs.find((job) => job.name === name);
  if (existing) {
    if (!String(existing._class || '').toLowerCase().includes('multibranch')) throw new Error(`Jenkins already has a non-multibranch job named ${name}. Rename it before connecting this repository.`);
    const configUrl = new URL(`${String(existing.url).replace(/\/$/, '')}/config.xml`);
    const config = await jenkinsFetch(credentials, configUrl.toString(), { headers: { Accept: 'application/xml' } });
    if (!config.ok) throw new Error(`Could not verify the existing Jenkins pipeline (HTTP ${config.status}).`);
    const xml = await config.text();
    if (!xml.includes(`<repoOwner>${owner}</repoOwner>`) || !xml.includes(`<repository>${repository}</repository>`)) throw new Error(`Jenkins job ${name} exists but is configured for a different GitHub repository.`);
    const validOwnerReference = /<owner\s+class="org\.jenkinsci\.plugins\.workflow\.multibranch\.WorkflowMultiBranchProject"\s+reference="\.\.\/\.\."\s*\/>/g;
    const references = xml.match(validOwnerReference) || [];
    if (references.length !== 3 || !/<folderViews\b[^>]*>\s*<owner\b[^>]*reference="\.\.\/\.\."\s*\/>\s*<\/folderViews>/.test(xml)) {
      // Repair jobs created by older Bankai versions. Missing owner references
      // leave the multibranch view holder uninitialized and Jenkins fails to
      // render the job page. Repost the Bankai-managed pipeline configuration.
      const crumbResponse = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'crumbIssuer/api/json'));
      const crumb = crumbResponse.ok ? await crumbResponse.json() : null;
      const repair = await jenkinsFetch(credentials, configUrl.toString(), {
        method: 'POST',
        headers: { ...jenkinsCrumbHeaders(crumb), 'Content-Type': 'application/xml' },
        body: pipelineConfigXml(owner, repository),
      });
      if (![200, 201, 302, 303].includes(repair.status)) throw new Error(`Jenkins could not repair the existing multibranch pipeline (HTTP ${repair.status}).`);
    }
    return { name, url: existing.url, created: false };
  }
  const crumbResponse = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'crumbIssuer/api/json'));
  const crumb = crumbResponse.ok ? await crumbResponse.json() : null;
  const xml = pipelineConfigXml(owner, repository);
  const target = new URL(jenkinsApiUrl(credentials.url, `createItem?name=${encodeURIComponent(name)}`));
  let response;
  try {
    response = await jenkinsFetch(credentials, target.toString(), { method: 'POST', headers: { ...jenkinsCrumbHeaders(crumb), 'Content-Type': 'application/xml' }, body: xml });
  } catch (error) {
    // Jenkins can return an error after persisting an item (for example, if
    // indexing fails during the create request). Confirm whether creation
    // actually completed before reporting failure or encouraging another POST.
    if (!/HTTP 500 for POST .*\/createItem\b/i.test(error instanceof Error ? error.message : String(error))) throw error;
    try {
      const refreshed = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'api/json?tree=jobs[name,url,_class]'));
      const created = ((await refreshed.json()).jobs || []).find((job) => job.name === name
        && String(job._class || '').toLowerCase().includes('multibranch'));
      if (created?.url) {
        const config = await jenkinsFetch(credentials, `${String(created.url).replace(/\/$/, '')}/config.xml`, { headers: { Accept: 'application/xml' } });
        const savedXml = config.ok ? await config.text() : '';
        if (savedXml.includes(`<repoOwner>${owner}</repoOwner>`) && savedXml.includes(`<repository>${repository}</repository>`)) {
          return { name, url: created.url, created: true };
        }
      }
    } catch { /* Keep the original HTTP 500 as the actionable failure. */ }
    throw error;
  }
  if (![200, 201, 302].includes(response.status)) throw new Error(response.status === 404 ? 'Jenkins could not create the pipeline. Install the Pipeline: Multibranch and GitHub Branch Source plugins.' : response.status === 400 ? 'Jenkins rejected the multibranch configuration. Check that Pipeline: Multibranch and GitHub Branch Source plugins are installed.' : `Jenkins could not create the multibranch pipeline (HTTP ${response.status}). Check that this account can create jobs.`);
  return { name, url: pipelineUrl(credentials.url, name), created: true };
}
async function scanJenkinsMultibranchPipeline(credentials, jobUrl) {
  const startedAt = Date.now();
  const target = validateJenkinsResourceUrl(credentials, jobUrl);
  const detail = await jenkinsFetch(credentials, `${target.toString().replace(/\/$/, '')}/api/json?tree=_class`);
  if (!detail.ok) throw new Error(`Could not inspect the Jenkins multibranch job (HTTP ${detail.status}).`);
  const job = await detail.json();
  if (!String(job._class || '').toLowerCase().includes('multibranch')) throw new Error('Select a Jenkins multibranch pipeline for this repository.');
  const beforeResponse = await jenkinsFetch(credentials, `${target.toString().replace(/\/$/, '')}/indexing/api/json?tree=building,result,timestamp`);
  let previousTimestamp = null;
  if (beforeResponse.ok) {
    try { previousTimestamp = (await beforeResponse.json()).timestamp ?? null; } catch { /* Continue if this Jenkins version returns a different API shape. */ }
  }
  const crumbResponse = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'crumbIssuer/api/json'));
  const crumb = crumbResponse.ok ? await crumbResponse.json() : null;
  // Jenkins exposes the multibranch "Scan Now" action at the build endpoint.
  // For a computed folder this schedules branch indexing (and PR builds).
  const response = await jenkinsFetch(credentials, `${target.toString().replace(/\/$/, '')}/build`, {
    method: 'POST', headers: jenkinsCrumbHeaders(crumb),
  });
  if (![200, 201, 202, 204, 302, 303].includes(response.status)) {
    throw new Error(response.status === 404
      ? 'Jenkins could not scan the repository. Check that Pipeline: Multibranch and GitHub Branch Source plugins are installed.'
      : `Jenkins could not start branch discovery (HTTP ${response.status}). Check this account can build and scan the multibranch job.`);
  }
  return { startedAt, previousTimestamp };
}
async function getJenkinsMultibranchIndexingStatus(credentials, jobUrl, scan = {}, includeLog = false) {
  const target = validateJenkinsResourceUrl(credentials, jobUrl);
  const indexingUrl = `${target.toString().replace(/\/$/, '')}/indexing`;
  const response = await jenkinsFetch(credentials, `${indexingUrl}/api/json?tree=building,result,timestamp`);
  if (response.status === 404) return { supported: false, building: false, result: null, timestamp: null, summary: null };
  if (!response.ok) throw new Error(`Could not inspect Jenkins branch discovery (HTTP ${response.status}).`);
  const indexing = await response.json();
  const timestamp = indexing.timestamp ?? null;
  const isCurrentScan = isCurrentIndexing({ ...indexing, timestamp }, scan);
  const status = {
    supported: true,
    current: isCurrentScan,
    building: indexing.building === true,
    result: typeof indexing.result === 'string' ? indexing.result : null,
    timestamp,
    summary: null,
  };
  if (isCurrentScan && (indexingFinished(status, isCurrentScan) || includeLog || indexing.building)) {
    const log = await jenkinsFetch(credentials, `${indexingUrl}/consoleText`, { headers: { Accept: 'text/plain' } });
    if (log.ok) {
      const summary = summarizeIndexingLog(await log.text());
      status.summary = { ...summary, rateLimitDelayMs: rateLimitDelayMs(summary.rateLimitDelay) };
    }
  }
  return status;
}
async function setupRepositoryMultibranchPipeline(credentials, repo) {
  const pipeline = await createRepositoryMultibranchPipeline(credentials, repo);
  await scanJenkinsMultibranchPipeline(credentials, pipeline.url);
  const jobs = await listJenkinsJobs(credentials, repo);
  if (!jobs.some((job) => job.url.replace(/\/$/, '') === pipeline.url.replace(/\/$/, ''))) {
    jobs.unshift({ name: pipeline.name, url: pipeline.url, color: 'notbuilt', supportsPullRequests: true });
  }
  return { pipeline, jobs };
}
async function getJenkinsCheckedOutCommit(credentials, buildUrl) {
  const target = validateJenkinsResourceUrl(credentials, buildUrl);
  const response = await jenkinsFetch(credentials, `${target.toString().replace(/\/$/, '')}/consoleText`, { headers: { Accept: 'text/plain' } });
  if (!response.ok || !response.body) return null;

  // Jenkins SCM metadata is missing from some multibranch build API responses.
  // Read only the beginning of the console, where the checkout revision is logged.
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < 256 * 1024) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.byteLength;
  }
  if (size >= 256 * 1024) await reader.cancel();

  const output = Buffer.concat(chunks).toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
  const revisions = new Set([...output.matchAll(/Checking out Revision\s+([0-9a-f]{40})\b/gi)].map((match) => match[1].toLowerCase()));
  // If a pipeline checks out multiple different revisions, do not guess which one was tested.
  return revisions.size === 1 ? [...revisions][0] : null;
}
function getJenkinsBuildCommit(build) {
  const actions = Array.isArray(build?.actions) ? build.actions : [];
  // GitHub Branch Source can build a synthetic merge commit for a PR. The
  // SCMRevisionAction retains the PR's actual source SHA as pullHash; that is
  // the revision Bankai tracks on the remediation branch. Prefer it over the
  // checked-out merge SHA and changelog entries (which may be older commits).
  for (const action of actions) {
    const revision = action?.revision;
    const pullHash = revision?.pullHash;
    if (typeof pullHash === 'string' && /^[0-9a-f]{40}$/i.test(pullHash)) return pullHash.toLowerCase();
  }

  // For ordinary branch jobs, Jenkins' Git plugin records the exact revision
  // checked out for the build. Changelog commits are not a substitute: their
  // first entry can predate the revision the build actually tested.
  const checkedOut = actions.map((action) => action?.lastBuiltRevision?.SHA1).find((sha) => typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha));
  if (checkedOut) return checkedOut.toLowerCase();
  return null;
}
function progress(event, update) {
  if (!event.sender.isDestroyed()) event.sender.send('bankai:jenkins-job-progress', update);
}
async function runJenkinsJob(event, jobUrl, parameters = {}) {
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins before starting a build.');
  const target = validateJenkinsResourceUrl(credentials, jobUrl);
  const crumbResponse = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'crumbIssuer/api/json'));
  let crumbHeaders = {};
  if (crumbResponse.ok) {
    const crumb = await crumbResponse.json();
    if (crumb.crumbRequestField && crumb.crumb) crumbHeaders[crumb.crumbRequestField] = crumb.crumb;
  } else if (crumbResponse.status !== 404) {
    throw new Error(`Could not prepare Jenkins build request (HTTP ${crumbResponse.status}).`);
  }
  let buildUrl = buildEndpoint(target.toString(), false);
  let requestOptions = { method: 'POST', headers: crumbHeaders };
  const entries = Object.entries(parameters || {});
  if (parameters !== undefined) {
    const configuration = await getJenkinsJobParameters(credentials, jobUrl);
    if (!configuration.supported) throw new Error(configuration.reason || 'This Jenkins job cannot be started safely with parameters.');
    if (configuration.parameters.length > 0) {
      const definitions = new Map(configuration.parameters.map((item) => [item.name, item]));
      const form = new URLSearchParams();
      for (const [name, rawValue] of entries) {
        const definition = definitions.get(name);
        if (!definition || /password|token|secret|credential|private[_-]?key/i.test(name) || typeof rawValue !== 'string' || rawValue.length > 2000) throw new Error('Enter only non-secret values for parameters declared by this Jenkins job.');
        if (definition.choices.length && !definition.choices.includes(rawValue)) throw new Error(`Choose a listed value for ${name}.`);
        form.set(name, rawValue);
      }
      for (const definition of configuration.parameters) {
        if ((!form.has(definition.name) || !form.get(definition.name)) && !definition.defaultValue) throw new Error(`Enter a value for ${definition.name} before deploying.`);
        if (definition.choices.length && form.has(definition.name) && !definition.choices.includes(form.get(definition.name))) throw new Error(`Choose a listed value for ${definition.name}.`);
      }
      buildUrl = buildEndpoint(target.toString(), true);
      requestOptions = { method: 'POST', headers: { ...crumbHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() };
    } else if (entries.length) {
      throw new Error('The selected Jenkins job does not accept parameters.');
    }
  }
  const queued = await jenkinsFetch(credentials, buildUrl, requestOptions);
  if (![200, 201, 202].includes(queued.status)) throw new Error(queued.status === 401 || queued.status === 403 ? 'Jenkins rejected the credentials or they lack permission to start this job.' : `Jenkins could not start the build (HTTP ${queued.status}).`);
  const location = queued.headers.get('location');
  if (!location) throw new Error('Jenkins accepted the build but did not return a queue link. Check the Jenkins job page.');
  const queueUrl = resolveQueueUrl(location, buildUrl);
  progress(event, { state: 'queued', jobUrl });
  let build;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await jenkinsFetch(credentials, `${queueUrl.replace(/\/$/, '')}/api/json`);
    if (!response.ok) throw new Error(`Could not read Jenkins queue status (HTTP ${response.status}).`);
    const queue = await response.json();
    if (queue.cancelled) return { state: 'aborted', buildUrl: null, number: null };
    if (queue.executable) { build = queue.executable; break; }
  }
  if (!build?.url) throw new Error('The build is still queued. Open Jenkins to check its status.');
  progress(event, { state: 'running', buildUrl: build.url, number: build.number, jobUrl });
  const buildDeadline = Date.now() + JENKINS_BUILD_TIMEOUT_MS;
  while (Date.now() < buildDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await jenkinsFetch(credentials, `${build.url.replace(/\/$/, '')}/api/json`);
    if (!response.ok) throw new Error(`Could not read Jenkins build status (HTTP ${response.status}).`);
    const current = await response.json();
    if (!current.building && current.result) {
      const state = current.result === 'SUCCESS' ? 'success' : current.result === 'ABORTED' ? 'aborted' : 'failure';
      let commitSha = getJenkinsBuildCommit(current);
      if (!commitSha) {
        try { commitSha = await getJenkinsCheckedOutCommit(credentials, current.url || build.url); } catch { /* keep the build result; Bankai will request review if the SHA remains unknown */ }
      }
      if (!commitSha) {
        const changedCommits = [...new Set((current.changeSet?.items || []).map((item) => item.commitId).filter((sha) => typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha)).map((sha) => sha.toLowerCase()))];
        if (changedCommits.length === 1) commitSha = changedCommits[0];
      }
      const targetParameter = current.actions?.flatMap((action) => action.parameters || []).find((item) => /^(deployment_?url|deploy_?url|target_?url)$/i.test(String(item.name || '')) && typeof item.value === 'string');
      let targetUrl = null;
      if (targetParameter) {
        try { const parsedTarget = new URL(targetParameter.value); if (parsedTarget.protocol === 'https:' && !parsedTarget.username && !parsedTarget.password) { parsedTarget.search = ''; parsedTarget.hash = ''; targetUrl = parsedTarget.toString(); } } catch { /* omit Jenkins values that are not safe public URLs */ }
      }
      const result = { state, buildUrl: current.url || build.url, number: current.number, timestamp: current.timestamp || null, durationMs: current.duration || null, commitSha, targetUrl, jobUrl };
      progress(event, result);
      return result;
    }
  }
  throw new Error('The Jenkins build is still running. Open Jenkins to check its status.');
}
async function resumeJenkinsJob(event, jobUrl, existingBuildUrl) {
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins before checking the existing build.');
  const job = validateJenkinsResourceUrl(credentials, jobUrl);
  let buildUrl = existingBuildUrl;
  if (buildUrl) {
    const build = validateJenkinsResourceUrl(credentials, buildUrl);
    if (build.origin !== job.origin || !build.pathname.startsWith(`${job.pathname.replace(/\/$/, '')}/`)) throw new Error('The recorded build is outside the selected Jenkins job.');
    buildUrl = build.toString();
  } else {
    const response = await jenkinsFetch(credentials, `${job.toString().replace(/\/$/, '')}/lastBuild/api/json`);
    if (!response.ok) throw new Error(`Could not inspect the latest Jenkins build (HTTP ${response.status}).`);
    const latest = await response.json();
    if (!latest.url) throw new Error('Jenkins has no recorded build to reconcile. Check Jenkins before starting another build.');
    buildUrl = latest.url;
  }
  const validatedBuild = validateJenkinsResourceUrl(credentials, buildUrl);
  if (validatedBuild.origin !== job.origin || !validatedBuild.pathname.startsWith(`${job.pathname.replace(/\/$/, '')}/`)) throw new Error('The recorded build is outside the selected Jenkins job.');
  const build = { url: validatedBuild.toString(), number: null };
  progress(event, { state: 'running', buildUrl: build.url, jobUrl });
  const buildDeadline = Date.now() + JENKINS_BUILD_TIMEOUT_MS;
  while (Date.now() < buildDeadline) {
    const response = await jenkinsFetch(credentials, `${build.url.replace(/\/$/, '')}/api/json`);
    if (!response.ok) throw new Error(`Could not read Jenkins build status (HTTP ${response.status}).`);
    const current = await response.json();
    if (!current.building && current.result) {
      const state = current.result === 'SUCCESS' ? 'success' : current.result === 'ABORTED' ? 'aborted' : 'failure';
      let commitSha = getJenkinsBuildCommit(current);
      if (!commitSha) {
        try { commitSha = await getJenkinsCheckedOutCommit(credentials, current.url || build.url); } catch { /* Bankai will request review if the SHA remains unknown */ }
      }
      if (!commitSha) {
        const changedCommits = [...new Set((current.changeSet?.items || []).map((item) => item.commitId).filter((sha) => typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha)).map((sha) => sha.toLowerCase()))];
        if (changedCommits.length === 1) commitSha = changedCommits[0];
      }
      const result = { state, buildUrl: current.url || build.url, number: current.number ?? build.number, timestamp: current.timestamp || null,
        durationMs: current.duration || null, commitSha, jobUrl };
      progress(event, result);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error('The existing Jenkins build is still running. Open Jenkins to check its status.');
}
async function findRecentJenkinsBuild(jobUrl, since) {
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins before checking for an existing build.');
  const job = validateJenkinsResourceUrl(credentials, jobUrl);
  const threshold = Date.parse(since || '');
  if (!Number.isFinite(threshold)) return null;
  const response = await jenkinsFetch(credentials, `${job.toString().replace(/\/$/, '')}/lastBuild/api/json`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not inspect the latest Jenkins build (HTTP ${response.status}).`);
  const build = await response.json();
  const timestamp = Number(build.timestamp);
  if (!build.url || !Number.isFinite(timestamp) || timestamp < threshold - 10_000) return null;
  const target = validateJenkinsResourceUrl(credentials, build.url);
  if (target.origin !== job.origin || !target.pathname.startsWith(`${job.pathname.replace(/\/$/, '')}/`)) {
    throw new Error('Jenkins returned a recent build outside the selected pull request job.');
  }
  return { url: target.toString(), timestamp };
}
async function getJenkinsBuildLog(buildUrl) {
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins before reading build output.');
  const target = validateJenkinsResourceUrl(credentials, buildUrl);
  const response = await jenkinsFetch(credentials, `${target.toString().replace(/\/$/, '')}/consoleText`, { headers: { Accept: 'text/plain' } });
  if (!response.ok) return `Jenkins could not return console output (HTTP ${response.status}).`;
  const reader = response.body?.getReader();
  if (!reader) return 'Jenkins did not return console output.';
  const chunks = [];
  let size = 0;
  while (size < 256 * 1024) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); size += value.byteLength;
  }
  if (size >= 256 * 1024) await reader.cancel();
  let log = Buffer.concat(chunks).toString('utf8').slice(-12_000);
  const token = credentials.apiToken;
  if (token) log = log.split(token).join('[REDACTED_JENKINS_TOKEN]');
  return log.replace(/(password|token|secret|authorization|api[_-]?key)(\s*[=:]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]');
}
async function cancelJenkinsBuild(buildUrl) {
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins before stopping a build.');
  const target = validateJenkinsResourceUrl(credentials, buildUrl);
  const crumbResponse = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'crumbIssuer/api/json'));
  const headers = {};
  if (crumbResponse.ok) {
    const crumb = await crumbResponse.json();
    if (crumb.crumbRequestField && crumb.crumb) headers[crumb.crumbRequestField] = crumb.crumb;
  } else if (crumbResponse.status !== 404) throw new Error(`Could not prepare Jenkins stop request (HTTP ${crumbResponse.status}).`);
  const response = await jenkinsFetch(credentials, `${target.toString().replace(/\/$/, '')}/stop`, { method: 'POST', headers });
  if (![200, 201, 202, 302, 303].includes(response.status)) throw new Error(response.status === 404 ? 'The Jenkins build has already finished.' : `Jenkins could not stop this build (HTTP ${response.status}).`);
  return { requested: true };
}

function projectFromDeepLink(value) {
  try {
    const link = new URL(value);
    const id = link.searchParams.get('project');
    return link.protocol === 'bankai:' && link.hostname === 'open' && id && /^[\w-]+$/.test(id) ? id : null;
  } catch { return null; }
}
function desktopPageUrl(route) {
  const target = new URL(route, WEB_URL);
  target.searchParams.set('_bankaiDesktopLaunch', String(Date.now()));
  return target.toString();
}
let startupProject = process.argv.map(projectFromDeepLink).find(Boolean) || process.argv.find((arg) => arg.startsWith('--project='))?.slice('--project='.length);

function allowedBankaiUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === WEB_ORIGIN && (url.protocol === 'https:' || (isLocalDev && url.protocol === 'http:'));
  } catch { return false; }
}
function hardenBankaiWindow(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedBankaiUrl(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      if (!allowedBankaiUrl(url) && target.protocol !== 'https:') event.preventDefault();
    } catch { event.preventDefault(); }
  });
}
function assertBankaiSender(event) {
  const sourceUrl = event.senderFrame?.url;
  if (!mainWindow || event.sender !== mainWindow.webContents || !sourceUrl || !allowedBankaiUrl(sourceUrl)) {
    throw new Error('This Jenkins action can only be started from the signed-in Bankai window.');
  }
}
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 680, title: 'Bankai',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
  });
  hardenBankaiWindow(mainWindow);
  const projectId = startupProject;
  const route = projectId && /^[\w-]+$/.test(projectId) ? `/workspace/${projectId}/jenkins` : '/login';
  mainWindow.loadURL(desktopPageUrl(route));
  mainWindow.on('closed', () => { closeJenkinsBrowser(); mainWindow = undefined; });
}
function validateJenkinsBrowserUrl(credentials, rawUrl) {
  let target;
  try { target = new URL(rawUrl); } catch { throw new Error('Enter a valid Jenkins address.'); }
  const base = new URL(credentials.url);
  const basePath = base.pathname.replace(/\/$/, '');
  if (target.username || target.password || target.origin !== base.origin || (target.pathname !== basePath && !target.pathname.startsWith(basePath + '/'))
    || !['https:', 'http:'].includes(target.protocol) || (target.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
    throw new Error('Open a Jenkins page from the connected server.');
  }
  return target;
}
function setJenkinsBrowserBounds(bounds) {
  if (!jenkinsBrowserView || !mainWindow || mainWindow.isDestroyed()) return { open: false };
  const content = mainWindow.getContentBounds();
  const width = Math.max(Math.min(content.width, 280), Math.min(Math.floor(Number(bounds?.width) || 0), content.width));
  const x = Math.max(0, Math.min(Math.floor(Number(bounds?.x) || 0), content.width - width));
  const height = Math.max(Math.min(content.height, 300), Math.min(Math.floor(Number(bounds?.height) || 0), content.height));
  const y = Math.max(0, Math.min(Math.floor(Number(bounds?.y) || 0), content.height - height));
  const appliedBounds = { x, y, width, height };
  jenkinsBrowserView.setBounds({
    x: x + 1,
    y: y + 56,
    width: Math.max(1, width - 2),
    height: Math.max(120, height - 57),
  });
  return { open: true, bounds: appliedBounds };
}
async function openJenkinsBrowser(rawUrl, bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Bankai window is not available.');
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins before opening its browser.');
  const target = validateJenkinsBrowserUrl(credentials, rawUrl);
  if (!jenkinsBrowserView) {
    jenkinsBrowserView = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false, partition: 'persist:bankai-jenkins' },
    });
    jenkinsBrowserView.setBorderRadius(15);
    jenkinsBrowserView.setBackgroundColor('#ffffff');
    mainWindow.contentView.addChildView(jenkinsBrowserView);
    const base = new URL(credentials.url);
    const isJenkinsUrl = (value) => {
      try { const url = new URL(value); const basePath = base.pathname.replace(/\/$/, ''); return url.origin === base.origin && (url.pathname === basePath || url.pathname.startsWith(basePath + '/')); }
      catch { return false; }
    };
    jenkinsBrowserView.webContents.on('will-navigate', (event, value) => { if (!isJenkinsUrl(value)) event.preventDefault(); });
    jenkinsBrowserView.webContents.setWindowOpenHandler(({ url }) => {
      if (isJenkinsUrl(url)) void jenkinsBrowserView?.webContents.loadURL(url);
      return { action: 'deny' };
    });
    jenkinsBrowserView.webContents.on('will-redirect', (event, value) => { if (!isJenkinsUrl(value)) event.preventDefault(); });
    jenkinsBrowserView.webContents.on('did-navigate', (_event, value) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bankai:jenkins-browser-navigation', value);
    });
    jenkinsBrowserView.webContents.on('did-navigate-in-page', (_event, value) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bankai:jenkins-browser-navigation', value);
    });
  }
  const applied = setJenkinsBrowserBounds(bounds);
  await jenkinsBrowserView.webContents.loadURL(target.toString());
  return { ...applied, url: target.toString() };
}
function closeJenkinsBrowser() {
  if (!jenkinsBrowserView) return { closed: true };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(jenkinsBrowserView);
  if (!jenkinsBrowserView.webContents.isDestroyed()) jenkinsBrowserView.webContents.close();
  jenkinsBrowserView = undefined;
  return { closed: true };
}
ipcMain.handle('bankai:open-jenkins', (event, url, bounds) => {
  assertBankaiSender(event);
  if (typeof url !== 'string' || url.length > 2048) throw new Error('Enter a valid Jenkins address.');
  return openJenkinsBrowser(url, bounds);
});
ipcMain.handle('bankai:jenkins-browser-bounds', (event, bounds) => {
  assertBankaiSender(event);
  return setJenkinsBrowserBounds(bounds);
});
ipcMain.handle('bankai:jenkins-browser-close', (event) => {
  assertBankaiSender(event);
  return closeJenkinsBrowser();
});
ipcMain.handle('bankai:open-external', (event, value) => {
  assertBankaiSender(event);
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS links can be opened externally.');
  return shell.openExternal(url.toString());
});
ipcMain.handle('bankai:jenkins-get-connection', async (event) => {
  assertBankaiSender(event);
  const credentials = await readJenkinsCredentials();
  return credentials ? { connected: true, url: credentials.url, username: credentials.username } : { connected: false };
});
ipcMain.handle('bankai:jenkins-connect', async (event, input) => {
  assertBankaiSender(event);
  if (!input || typeof input.url !== 'string' || typeof input.username !== 'string' || typeof input.apiToken !== 'string' || typeof input.repo !== 'string' || input.username.length > 256 || input.apiToken.length > 2048) throw new Error('Enter your Jenkins address, username, API token, and connect a GitHub repository to this project.');
  const credentials = { url: validateJenkinsUrl(input.url), username: input.username.trim(), apiToken: input.apiToken };
  if (!credentials.username || !credentials.apiToken) throw new Error('Enter your Jenkins username and API token.');
  const response = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'api/json?tree=mode,nodeDescription'));
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Jenkins rejected those credentials. Use your username and Jenkins API token.' : `Jenkins connection failed (HTTP ${response.status}).`);
  try { await response.json(); } catch { throw new Error('That address did not return the Jenkins API. Check the server address.'); }
  const { pipeline, jobs } = await setupRepositoryMultibranchPipeline(credentials, input.repo);
  // Persist the connection only after setup succeeds. Otherwise Jenkins can
  // appear connected while the required repository pipeline was never made,
  // and the UI hides the connect form needed to retry setup.
  await saveJenkinsCredentials(credentials);
  return { connected: true, url: credentials.url, username: credentials.username, jobs, pipeline };
});
ipcMain.handle('bankai:jenkins-ensure-pipeline', async (event, repo) => {
  assertBankaiSender(event);
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins first.');
  const { pipeline, jobs } = await setupRepositoryMultibranchPipeline(credentials, repo);
  return { pipeline, jobs };
});
ipcMain.handle('bankai:jenkins-scan-multibranch', async (event, jobUrl) => {
  assertBankaiSender(event);
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins first.');
  return scanJenkinsMultibranchPipeline(credentials, jobUrl);
});
ipcMain.handle('bankai:jenkins-indexing-status', async (event, jobUrl, scan, includeLog) => {
  assertBankaiSender(event);
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins first.');
  return getJenkinsMultibranchIndexingStatus(credentials, jobUrl, scan, includeLog === true);
});
ipcMain.handle('bankai:jenkins-list-jobs', async (event, repo) => {
  assertBankaiSender(event);
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins first.');
  return listJenkinsJobs(credentials, typeof repo === 'string' ? repo : null);
});
ipcMain.handle('bankai:jenkins-disconnect', async (event) => {
  assertBankaiSender(event);
  await fs.rm(JENKINS_STORE(), { force: true });
  return { connected: false };
});
ipcMain.handle('bankai:jenkins-run-job', (event, url, parameters) => { assertBankaiSender(event); return runJenkinsJob(event, url, parameters); });
ipcMain.handle('bankai:jenkins-resume-job', (event, jobUrl, buildUrl) => { assertBankaiSender(event); return resumeJenkinsJob(event, jobUrl, buildUrl); });
ipcMain.handle('bankai:jenkins-find-recent-build', (event, jobUrl, since) => { assertBankaiSender(event); return findRecentJenkinsBuild(jobUrl, since); });
ipcMain.handle('bankai:jenkins-build-log', (event, url) => { assertBankaiSender(event); return getJenkinsBuildLog(url); });
ipcMain.handle('bankai:jenkins-cancel-build', (event, url) => { assertBankaiSender(event); return cancelJenkinsBuild(url); });
ipcMain.handle('bankai:jenkins-get-job-parameters', async (event, url) => {
  assertBankaiSender(event);
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins first.');
  return getJenkinsJobParameters(credentials, url);
});
app.setAsDefaultProtocolClient('bankai');
app.on('second-instance', (_event, argv) => {
  const projectId = argv.map(projectFromDeepLink).find(Boolean);
  if (projectId && /^[\w-]+$/.test(projectId)) mainWindow?.loadURL(desktopPageUrl(`/workspace/${projectId}/jenkins`));
  mainWindow?.focus();
});
app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
