const { app, BrowserWindow, shell, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

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
  await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(credentials)));
  await fs.rename(temporary, JENKINS_STORE());
}
function jenkinsHeaders(credentials, extra = {}) {
  const auth = Buffer.from(`${credentials.username}:${credentials.apiToken}`).toString('base64');
  return { Authorization: `Basic ${auth}`, Accept: 'application/json', ...extra };
}
async function jenkinsFetch(credentials, url, options = {}) {
  const target = new URL(url);
  const base = new URL(credentials.url);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')) {
    throw new Error('Jenkins returned a link outside the configured server.');
  }
  let response;
  try {
    response = await fetch(target, { ...options, headers: jenkinsHeaders(credentials, options.headers), signal: AbortSignal.timeout(15000), redirect: 'manual' });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('Jenkins did not respond in time. Check the address and try again.');
    throw new Error('Could not reach Jenkins. Check that the server is running and the address is correct.');
  }
  return response;
}
function jenkinsApiUrl(base, relative) {
  return `${base.replace(/\/$/, '')}/${relative.replace(/^\//, '')}`;
}
async function listJenkinsJobs(credentials) {
  const jobs = [];
  const visit = async (url, depth = 0) => {
    if (depth > 8 || jobs.length >= 300) return;
    const response = await jenkinsFetch(credentials, `${url.replace(/\/$/, '')}/api/json?tree=jobs[name,url,color,_class]`);
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Jenkins rejected the credentials or they lack permission to read jobs.' : `Could not list Jenkins jobs (HTTP ${response.status}).`);
    const data = await response.json();
    for (const item of data.jobs || []) {
      const isFolder = String(item._class || '').toLowerCase().includes('folder');
      if (isFolder && item.url) await visit(item.url, depth + 1);
      else jobs.push({ name: item.name, url: item.url, color: item.color || '' });
    }
  };
  await visit(credentials.url);
  return jobs;
}
function progress(event, update) {
  if (!event.sender.isDestroyed()) event.sender.send('bankai:jenkins-job-progress', update);
}
async function runJenkinsJob(event, jobUrl) {
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins before starting a build.');
  const target = new URL(jobUrl);
  if (target.origin !== new URL(credentials.url).origin || !target.pathname.startsWith(new URL(credentials.url).pathname.replace(/\/$/, '') + '/job/')) throw new Error('Choose a job from the connected Jenkins server.');
  const crumbResponse = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'crumbIssuer/api/json'));
  let crumbHeaders = {};
  if (crumbResponse.ok) {
    const crumb = await crumbResponse.json();
    if (crumb.crumbRequestField && crumb.crumb) crumbHeaders[crumb.crumbRequestField] = crumb.crumb;
  } else if (crumbResponse.status !== 404) {
    throw new Error(`Could not prepare Jenkins build request (HTTP ${crumbResponse.status}).`);
  }
  const queued = await jenkinsFetch(credentials, `${target.toString().replace(/\/$/, '')}/build`, { method: 'POST', headers: crumbHeaders });
  if (![200, 201, 202].includes(queued.status)) throw new Error(queued.status === 401 || queued.status === 403 ? 'Jenkins rejected the credentials or they lack permission to start this job.' : `Jenkins could not start the build (HTTP ${queued.status}).`);
  const queueUrl = queued.headers.get('location');
  if (!queueUrl) throw new Error('Jenkins accepted the build but did not return a queue link. Check the Jenkins job page.');
  progress(event, { state: 'queued' });
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
  progress(event, { state: 'running', buildUrl: build.url, number: build.number });
  for (let i = 0; i < 180; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await jenkinsFetch(credentials, `${build.url.replace(/\/$/, '')}/api/json`);
    if (!response.ok) throw new Error(`Could not read Jenkins build status (HTTP ${response.status}).`);
    const current = await response.json();
    if (!current.building && current.result) {
      const state = current.result === 'SUCCESS' ? 'success' : current.result === 'ABORTED' ? 'aborted' : 'failure';
      const changeCommit = current.changeSet?.items?.find((item) => item.commitId)?.commitId;
      const revisionCommit = current.actions?.map((action) => action.lastBuiltRevision?.SHA1).find(Boolean);
      const result = { state, buildUrl: current.url || build.url, number: current.number, timestamp: current.timestamp || null, durationMs: current.duration || null, commitSha: changeCommit || revisionCommit || null };
      progress(event, result);
      return result;
    }
  }
  throw new Error('The Jenkins build is still running. Open Jenkins to check its status.');
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
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 680, title: 'Bankai',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
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
ipcMain.handle('bankai:open-jenkins', (_event, url) => {
  if (typeof url !== 'string' || url.length > 2048) throw new Error('Enter a valid Jenkins address.');
  return openJenkinsBrowser(url);
});
ipcMain.handle('bankai:open-external', (_event, value) => {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS links can be opened externally.');
  return shell.openExternal(url.toString());
});
ipcMain.handle('bankai:jenkins-get-connection', async () => {
  const credentials = await readJenkinsCredentials();
  return credentials ? { connected: true, url: credentials.url, username: credentials.username } : { connected: false };
});
ipcMain.handle('bankai:jenkins-connect', async (_event, input) => {
  if (!input || typeof input.url !== 'string' || typeof input.username !== 'string' || typeof input.apiToken !== 'string' || input.username.length > 256 || input.apiToken.length > 2048) throw new Error('Enter your Jenkins address, username, and API token.');
  const credentials = { url: validateJenkinsUrl(input.url), username: input.username.trim(), apiToken: input.apiToken };
  if (!credentials.username || !credentials.apiToken) throw new Error('Enter your Jenkins username and API token.');
  const response = await jenkinsFetch(credentials, jenkinsApiUrl(credentials.url, 'api/json?tree=mode,nodeDescription'));
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Jenkins rejected those credentials. Use your username and Jenkins API token.' : `Jenkins connection failed (HTTP ${response.status}).`);
  try { await response.json(); } catch { throw new Error('That address did not return the Jenkins API. Check the server address.'); }
  await saveJenkinsCredentials(credentials);
  return { connected: true, url: credentials.url, username: credentials.username, jobs: await listJenkinsJobs(credentials) };
});
ipcMain.handle('bankai:jenkins-list-jobs', async () => {
  const credentials = await readJenkinsCredentials();
  if (!credentials) throw new Error('Connect to Jenkins first.');
  return listJenkinsJobs(credentials);
});
ipcMain.handle('bankai:jenkins-disconnect', async () => {
  await fs.rm(JENKINS_STORE(), { force: true });
  return { connected: false };
});
ipcMain.handle('bankai:jenkins-run-job', (event, url) => runJenkinsJob(event, url));
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
