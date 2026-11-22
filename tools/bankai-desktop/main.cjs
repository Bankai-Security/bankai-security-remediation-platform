const { app, BrowserWindow, Menu, shell, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { buildEndpoint, resolveQueueUrl } = require('./jenkins-build-request.cjs');

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
let browserWindow;
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
    if (response.status >= 500) throw new Error('Jenkins is temporarily unavailable. Check the server, then retry from Bankai.');
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
async function listJenkinsJobs(credentials) {
  const jobs = [];
  const visit = async (url, depth = 0, underMultibranch = false) => {
    if (depth > 8 || jobs.length >= 300) return;
    const response = await jenkinsFetch(credentials, `${url.replace(/\/$/, '')}/api/json?tree=jobs[name,url,color,_class]`);
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Jenkins rejected the credentials or they lack permission to read jobs.' : `Could not list Jenkins jobs (HTTP ${response.status}).`);
    const data = await response.json();
    for (const item of data.jobs || []) {
      const jobClass = String(item._class || '').toLowerCase();
      const isMultibranch = jobClass.includes('multibranch');
      const isFolder = jobClass.includes('folder') || isMultibranch || jobClass.includes('computedfolder');
      if (isMultibranch && item.url) jobs.push({ name: item.name, url: item.url, color: item.color || '', supportsPullRequests: true });
      if (isFolder && item.url) await visit(item.url, depth + 1, underMultibranch || isMultibranch);
      else if (!isMultibranch) jobs.push({ name: item.name, url: item.url, color: item.color || '', supportsPullRequests: underMultibranch });
    }
  };
  await visit(credentials.url);
  return jobs;
}
function jenkinsCrumbHeaders(crumb) {
  return crumb?.crumbRequestField && crumb?.crumb ? { [crumb.crumbRequestField]: crumb.crumb } : {};
}
async function createRepositoryMultibranchPipeline(credentials, repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Connect a GitHub repository to this Bankai project before setting up Jenkins.');
  const [owner, repository] = repo.split('/');
  const name = `bankai-${owner}-${repository}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100);
  const root = new URL(credentials.url);
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
    return { name, url: existing.url, created: false };
  }
  const crumbResponse = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'crumbIssuer/api/json'));
  const crumb = crumbResponse.ok ? await crumbResponse.json() : null;
  const xml = `<?xml version="1.1" encoding="UTF-8"?>\n<org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject plugin="workflow-multibranch"><actions/><description>Created by Bankai for ${owner}/${repository}</description><properties/><folderViews class="jenkins.branch.MultiBranchProjectViewHolder"/><healthMetrics/><icon class="jenkins.branch.MetadataActionFolderIcon"/><orphanedItemStrategy class="com.cloudbees.hudson.plugins.folder.computed.DefaultOrphanedItemStrategy"><pruneDeadBranches>true</pruneDeadBranches><daysToKeep>-1</daysToKeep><numToKeep>-1</numToKeep><abortBuilds>true</abortBuilds></orphanedItemStrategy><triggers/><sources class="jenkins.branch.MultiBranchProject$BranchSourceList"><data><jenkins.branch.BranchSource><source class="org.jenkinsci.plugins.github_branch_source.GitHubSCMSource"><id>bankai-${owner}-${repository}</id><repoOwner>${owner}</repoOwner><repository>${repository}</repository><traits><org.jenkinsci.plugins.github__branch__source.BranchDiscoveryTrait><strategyId>3</strategyId></org.jenkinsci.plugins.github__branch__source.BranchDiscoveryTrait><org.jenkinsci.plugins.github__branch__source.OriginPullRequestDiscoveryTrait><strategyId>1</strategyId></org.jenkinsci.plugins.github__branch__source.OriginPullRequestDiscoveryTrait><org.jenkinsci.plugins.github__branch__source.ForkPullRequestDiscoveryTrait><strategyId>1</strategyId><trust class="org.jenkinsci.plugins.github_branch_source.ForkPullRequestDiscoveryTrait$TrustPermission"/></org.jenkinsci.plugins.github__branch__source.ForkPullRequestDiscoveryTrait></traits></source><strategy class="jenkins.branch.DefaultBranchPropertyStrategy"><properties class="empty-list"/></strategy></jenkins.branch.BranchSource></data><owner class="org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject"/></sources><factory class="org.jenkinsci.plugins.workflow.multibranch.WorkflowBranchProjectFactory"><owner class="org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject"/><scriptPath>Jenkinsfile</scriptPath></factory></org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject>`;
  const target = new URL(jenkinsApiUrl(credentials.url, `createItem?name=${encodeURIComponent(name)}`));
  const response = await jenkinsFetch(credentials, target.toString(), { method: 'POST', headers: { ...jenkinsCrumbHeaders(crumb), 'Content-Type': 'application/xml' }, body: xml });
  if (![200, 201, 302].includes(response.status)) throw new Error(response.status === 404 ? 'Jenkins could not create the pipeline. Install the Pipeline: Multibranch and GitHub Branch Source plugins.' : response.status === 400 ? 'Jenkins rejected the multibranch configuration. Check that Pipeline: Multibranch and GitHub Branch Source plugins are installed.' : `Jenkins could not create the multibranch pipeline (HTTP ${response.status}). Check that this account can create jobs.`);
  return { name, url: new URL(`job/${encodeURIComponent(name)}/`, root).toString(), created: true };
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
  for (let i = 0; i < 180; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await jenkinsFetch(credentials, `${build.url.replace(/\/$/, '')}/api/json`);
    if (!response.ok) throw new Error(`Could not read Jenkins build status (HTTP ${response.status}).`);
    const current = await response.json();
    if (!current.building && current.result) {
      const state = current.result === 'SUCCESS' ? 'success' : current.result === 'ABORTED' ? 'aborted' : 'failure';
      const changeCommit = current.changeSet?.items?.find((item) => item.commitId)?.commitId;
      const revisionCommit = current.actions?.map((action) => action.lastBuiltRevision?.SHA1).find(Boolean);
      let commitSha = changeCommit || revisionCommit || null;
      if (!commitSha) {
        try { commitSha = await getJenkinsCheckedOutCommit(credentials, current.url || build.url); } catch { /* keep the build result; Bankai will request review if the SHA remains unknown */ }
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
  for (let i = 0; i < 180; i += 1) {
    const response = await jenkinsFetch(credentials, `${build.url.replace(/\/$/, '')}/api/json`);
    if (!response.ok) throw new Error(`Could not read Jenkins build status (HTTP ${response.status}).`);
    const current = await response.json();
    if (!current.building && current.result) {
      const state = current.result === 'SUCCESS' ? 'success' : current.result === 'ABORTED' ? 'aborted' : 'failure';
      const changeCommit = current.changeSet?.items?.find((item) => item.commitId)?.commitId;
      const revisionCommit = current.actions?.map((action) => action.lastBuiltRevision?.SHA1).find(Boolean);
      let commitSha = changeCommit || revisionCommit || null;
      if (!commitSha) {
        try { commitSha = await getJenkinsCheckedOutCommit(credentials, current.url || build.url); } catch { /* Bankai will request review if the SHA remains unknown */ }
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
  const route = projectId && /^[\w-]+$/.test(projectId) ? `/workspace/${projectId}/jenkins` : '/projects';
  mainWindow.loadURL(WEB_URL.replace(/\/$/, '') + route);
  mainWindow.on('closed', () => { mainWindow = undefined; });
}
function openJenkinsBrowser(rawUrl) {
  const target = new URL(rawUrl);
  if (!['https:', 'http:'].includes(target.protocol) || (target.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(target.hostname))) {
    throw new Error('Jenkins must use HTTPS or a localhost address.');
  }
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.close();
  browserWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 800, minHeight: 600, title: 'Jenkins · Bankai', parent: mainWindow,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:bankai-jenkins' },
  });
  const origin = target.origin;
  browserWindow.webContents.on('will-navigate', (event, value) => {
    try { if (new URL(value).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); }
  });
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).origin === origin) return { action: 'allow' }; } catch { /* reject invalid URLs */ }
    return { action: 'deny' };
  });
  browserWindow.on('closed', () => { browserWindow = undefined; });
  return browserWindow.loadURL(target.toString());
}
ipcMain.handle('bankai:open-jenkins', (event, url) => {
  assertBankaiSender(event);
  if (typeof url !== 'string' || url.length > 2048) throw new Error('Enter a valid Jenkins address.');
  return openJenkinsBrowser(url);
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
  await saveJenkinsCredentials(credentials);
  const pipeline = await createRepositoryMultibranchPipeline(credentials, input.repo);
  const jobs = await listJenkinsJobs(credentials);
  return { connected: true, url: credentials.url, username: credentials.username, jobs, pipeline };
});
ipcMain.handle('bankai:jenkins-list-jobs', async (event) => {
  assertBankaiSender(event);
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins first.');
  return listJenkinsJobs(credentials);
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
  if (projectId && /^[\w-]+$/.test(projectId)) mainWindow?.loadURL(WEB_URL.replace(/\/$/, '') + `/workspace/${projectId}/jenkins`);
  mainWindow?.focus();
});
app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
