const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { randomBytes } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const APP_NAME = 'Bankai Companion';
const runnerConfigDir = path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'BankaiLocalRunner');
const runnerConfigPath = path.join(runnerConfigDir, 'config.json');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
let mainWindow;
let stackProcess;
let quincyProcess;
let runnerAbort;
let runnerPromise;
let runnerModule;
let jenkinsWindow;

async function getRunnerModule() {
  if (runnerModule) return runnerModule;
  const runnerPath = app.isPackaged ? path.join(process.resourcesPath, 'runner.mjs') : path.resolve(__dirname, '..', '..', 'runner.mjs');
  runnerModule = await import(require('node:url').pathToFileURL(runnerPath).href);
  return runnerModule;
}

function send(type, data = {}) {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('companion:event', { type, at: new Date().toISOString(), ...data });
}

function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return { bankaiUrl: '', quincyUrl: 'http://127.0.0.1:8000', quincyPath: '', caPath: '', allowedRepositories: '', ...parsed };
  } catch {
    return { bankaiUrl: '', quincyUrl: 'http://127.0.0.1:8000', quincyPath: '', caPath: '', allowedRepositories: '' };
  }
}

function saveSettings(input) {
  const settings = {
    bankaiUrl: String(input.bankaiUrl || '').trim().replace(/\/$/, ''),
    quincyUrl: String(input.quincyUrl || 'http://127.0.0.1:8000').trim().replace(/\/$/, ''),
    quincyPath: String(input.quincyPath || '').trim() ? path.resolve(String(input.quincyPath).trim()) : '',
    caPath: String(input.caPath || '').trim(),
    allowedRepositories: String(input.allowedRepositories || '').trim(),
  };
  if (!settings.bankaiUrl) throw new Error('Enter the Bankai backend URL.');
  const bankai = new URL(settings.bankaiUrl);
  if (bankai.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(bankai.hostname)) throw new Error('Bankai must use HTTPS outside this computer.');
  const quincy = new URL(settings.quincyUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(quincy.hostname)) throw new Error('Quincy must stay on this computer.');
  if (settings.quincyPath && !existsSync(path.join(settings.quincyPath, 'pyproject.toml'))) throw new Error('Choose the Quincy repository folder containing pyproject.toml.');
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return settings;
}

function isLocalJenkinsUrl(candidate) {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' && parsed.hostname === 'localhost' && parsed.port === '8443';
  } catch { return false; }
}

function credentialStore(action, target, secret = '') {
  const source = `using System; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public static class BankaiCredentialStore {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  public static void Write(string target, string value) { var bytes=System.Text.Encoding.Unicode.GetBytes(value); var memory=Marshal.AllocHGlobal(bytes.Length); try { Marshal.Copy(bytes,0,memory,bytes.Length); var item=new CREDENTIAL { Type=1, TargetName=target, UserName=Environment.UserName, CredentialBlobSize=(UInt32)bytes.Length, CredentialBlob=memory, Persist=2 }; if(!CredWrite(ref item,0)) throw new InvalidOperationException("credential_write_failed"); } finally { Marshal.Copy(new byte[bytes.Length],0,memory,bytes.Length); Marshal.FreeHGlobal(memory); } }
  public static string Read(string target) { IntPtr pointer; if(!CredRead(target,1,0,out pointer)) throw new InvalidOperationException("credential_read_failed"); try { var item=(CREDENTIAL)Marshal.PtrToStructure(pointer,typeof(CREDENTIAL)); return Marshal.PtrToStringUni(item.CredentialBlob,(int)item.CredentialBlobSize/2); } finally { CredFree(pointer); } }
}`;
  const script = "$r=ConvertFrom-Json ([Console]::In.ReadToEnd()); Add-Type -TypeDefinition $r.source; if($r.action -eq 'write'){[BankaiCredentialStore]::Write($r.target,$r.secret);[Console]::Out.Write('ok')}else{[Console]::Out.Write([BankaiCredentialStore]::Read($r.target))}";
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify({ action, target, secret, source }), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024,
  });
  if (result.status !== 0 || !result.stdout) throw new Error('Windows Credential Manager access failed.');
  return result.stdout;
}

function getRunnerConfig() {
  try { return JSON.parse(readFileSync(runnerConfigPath, 'utf8')); } catch { return null; }
}

function runPowerShell(scriptPath, args = []) {
  if (!existsSync(scriptPath)) throw new Error(`Could not find ${path.basename(scriptPath)} in the selected Quincy checkout.`);
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
    cwd: path.dirname(scriptPath), windowsHide: true, env: process.env,
  });
  child.stdout.on('data', (chunk) => send('log', { source: 'jenkins', message: chunk.toString().trim() }));
  child.stderr.on('data', (chunk) => send('log', { source: 'jenkins', message: chunk.toString().trim(), level: 'error' }));
  return child;
}

function probeHttps(url, caPath) {
  return new Promise((resolve) => {
    let ca;
    try { ca = readFileSync(caPath); } catch { resolve(false); return; }
    const request = https.get(url, { ca, rejectUnauthorized: true, timeout: 2500 }, (response) => { response.resume(); resolve(response.statusCode === 200); });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function inspectLocal() {
  const settings = readSettings();
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  let config = null;
  try { config = JSON.parse(readFileSync(runnerConfigPath, 'utf8')); } catch { /* Pairing has not happened yet. */ }
  const caPath = settings.caPath || path.join(settings.quincyPath, 'tools', 'local-jenkins', '.local', 'certs', 'jenkins.crt');
  let quincyReady = false;
  try { const response = await fetch(`${settings.quincyUrl}/health`, { signal: AbortSignal.timeout(2500) }); quincyReady = response.ok; } catch { /* Local service is offline. */ }
  const jenkinsReady = await probeHttps('https://localhost:8443/login', caPath);
  return {
    settings,
    paired: Boolean(config),
    runnerId: config?.runnerId || null,
    runnerActive: Boolean(runnerPromise),
    dockerReady: docker.status === 0 && Boolean(docker.stdout.trim()),
    jenkinsReady,
    quincyReady,
    jenkinsRunning: Boolean(stackProcess && !stackProcess.killed),
    quincyRunning: Boolean(quincyProcess && !quincyProcess.killed),
    quincyPathReady: Boolean(settings.quincyPath && existsSync(path.join(settings.quincyPath, '.venv', 'Scripts', 'python.exe'))),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160, height: 820, minWidth: 920, minHeight: 680,
    title: APP_NAME, backgroundColor: '#f4f4f5',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const localApp = url.startsWith('file://');
    let localDev = false;
    try { localDev = Boolean(devUrl) && new URL(url).origin === new URL(devUrl).origin; } catch { /* Invalid navigation. */ }
    if (!localApp && !localDev) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { runnerAbort?.abort(); quincyProcess?.kill(); });
app.on('certificate-error', (event, webContents, url, _error, _certificate, callback) => {
  if (webContents !== jenkinsWindow?.webContents || !isLocalJenkinsUrl(url)) { callback(false); return; }
  event.preventDefault();
  const settings = readSettings();
  const caPath = settings.caPath || path.join(settings.quincyPath, 'tools', 'local-jenkins', '.local', 'certs', 'jenkins.crt');
  let answered = false;
  const finish = (accepted) => { if (!answered) { answered = true; callback(accepted); } };
  let ca;
  try { ca = readFileSync(caPath); } catch { finish(false); return; }
  const request = https.get(url, { ca, rejectUnauthorized: true, timeout: 3000 }, (response) => { response.resume(); finish(response.statusCode === 200); });
  request.on('error', () => finish(false));
  request.on('timeout', () => { request.destroy(); finish(false); });
});

ipcMain.handle('companion:get-state', () => inspectLocal());
ipcMain.handle('companion:save-settings', (_event, settings) => saveSettings(settings));
ipcMain.handle('companion:generate-service-token', () => randomBytes(32).toString('base64url'));
ipcMain.handle('companion:choose-quincy-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Quincy repository' });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('companion:choose-certificate', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Certificate', extensions: ['crt', 'pem', 'cer'] }] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('companion:pair', async (_event, values) => {
  const settings = saveSettings(values.settings);
  const pairingCode = String(values.pairingCode || '').trim();
  const quincyToken = String(values.quincyToken || '').trim();
  if (!pairingCode || !quincyToken) throw new Error('Enter the one-time pairing code and local Quincy service token.');
  const caPath = String(values.caPath || '').trim();
  if (!caPath || !existsSync(caPath)) throw new Error('Select the local Jenkins CA certificate from the Quincy checkout.');
  const previous = { BANKAI_API_URL: process.env.BANKAI_API_URL, QUINCY_API_URL: process.env.QUINCY_API_URL,
    BANKAI_PAIRING_CODE: process.env.BANKAI_PAIRING_CODE, QUINCY_API_TOKEN: process.env.QUINCY_API_TOKEN,
    QUINCY_JENKINS_CA: process.env.QUINCY_JENKINS_CA };
  Object.assign(process.env, { BANKAI_API_URL: settings.bankaiUrl, QUINCY_API_URL: settings.quincyUrl,
    BANKAI_PAIRING_CODE: pairingCode, QUINCY_API_TOKEN: quincyToken, QUINCY_JENKINS_CA: caPath });
  try {
    const runner = await getRunnerModule();
    await runner.pair({ onLog: (message) => send('log', { source: 'pairing', message }) });
    return inspectLocal();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

ipcMain.handle('companion:start-jenkins', () => {
  if (stackProcess && !stackProcess.killed) return { started: true };
  const settings = readSettings();
  if (!settings.quincyPath) throw new Error('Choose the Quincy repository folder first.');
  stackProcess = runPowerShell(path.join(settings.quincyPath, 'tools', 'local-jenkins', 'start.ps1'));
  stackProcess.once('close', (code) => { send('service', { name: 'jenkins', running: code === 0 }); stackProcess = null; });
  send('service', { name: 'jenkins', running: true });
  return { started: true };
});
ipcMain.handle('companion:stop-jenkins', () => {
  const settings = readSettings();
  if (stackProcess && !stackProcess.killed) stackProcess.kill();
  const script = path.join(settings.quincyPath, 'tools', 'local-jenkins', 'stop.ps1');
  if (existsSync(script)) runPowerShell(script);
  send('service', { name: 'jenkins', running: false });
  return { stopped: true };
});

ipcMain.handle('companion:start-quincy', () => {
  if (quincyProcess && !quincyProcess.killed) return { started: true };
  const settings = readSettings();
  const python = path.join(settings.quincyPath, '.venv', 'Scripts', 'python.exe');
  const stackRoot = path.join(settings.quincyPath, 'tools', 'local-jenkins');
  const tokenFile = path.join(stackRoot, '.local', 'secrets', 'jenkins-api-token');
  const caFile = path.join(stackRoot, '.local', 'certs', 'jenkins.crt');
  const config = getRunnerConfig();
  if (!existsSync(python)) throw new Error('Quincy virtual environment is missing. Create .venv and install Quincy dependencies first.');
  if (!existsSync(tokenFile) || !existsSync(caFile)) throw new Error('Start the local Jenkins stack first so its API token and TLS certificate exist.');
  if (!config) throw new Error('Pair with Bankai first so the local Quincy token is stored in Windows Credential Manager.');
  const token = credentialStore('read', config.quincyCredentialTarget);
  const repositoryValues = settings.allowedRepositories.split(/[\n,;]/).map((v) => v.trim()).filter(Boolean);
  if (!repositoryValues.length || repositoryValues.some((v) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v))) throw new Error('Add one or more allowlisted GitHub repositories as owner/repo in Settings.');
  const tokenExpires = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const env = {
    ...process.env, SERVICE_API_TOKEN: token, JENKINS_BASE_URL: 'https://localhost:8443',
    JENKINS_JOB_NAME: 'quincy-verification', JENKINS_USERNAME: 'quincy-test',
    JENKINS_TOKEN: readFileSync(tokenFile, 'utf8').trim(), JENKINS_TOKEN_EXPIRES_AT: tokenExpires,
    JENKINS_CA_BUNDLE: caFile, ENABLED_SCANNERS: '["schrift"]',
    VERIFICATION_ALLOWED_REPOSITORIES: JSON.stringify(repositoryValues.map((repo) => `github_url:https://github.com/${repo}`)),
  };
  quincyProcess = spawn(python, ['-m', 'uvicorn', 'quincy.api.app:create_app', '--factory', '--host', '127.0.0.1', '--port', '8000', '--env-file', '.env'], {
    cwd: settings.quincyPath, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  quincyProcess.stdout.on('data', (chunk) => send('log', { source: 'quincy', message: chunk.toString().trim() }));
  quincyProcess.stderr.on('data', (chunk) => send('log', { source: 'quincy', message: chunk.toString().trim(), level: 'error' }));
  quincyProcess.once('close', () => { quincyProcess = null; send('service', { name: 'quincy', running: false }); });
  send('service', { name: 'quincy', running: true });
  return { started: true };
});
ipcMain.handle('companion:stop-quincy', () => { if (quincyProcess && !quincyProcess.killed) quincyProcess.kill(); quincyProcess = null; send('service', { name: 'quincy', running: false }); return { stopped: true }; });
ipcMain.handle('companion:start-runner', () => {
  if (runnerPromise) return { started: true };
  const config = getRunnerConfig();
  if (!config) throw new Error('Pair this computer with Bankai first.');
  runnerAbort = new AbortController();
  runnerPromise = getRunnerModule().then((runner) => runner.main({
    signal: runnerAbort.signal,
    onLog: (level, message) => send('log', { source: 'runner', message, level }),
  })).catch(() => send('log', { source: 'runner', message: 'Companion stopped after an unexpected runner error.', level: 'error' }))
    .finally(() => { runnerPromise = null; runnerAbort = null; send('service', { name: 'runner', running: false }); });
  send('service', { name: 'runner', running: true });
  return { started: true };
});
ipcMain.handle('companion:stop-runner', () => { runnerAbort?.abort(); return { stopping: true }; });
ipcMain.handle('companion:open-bankai', () => { const settings = readSettings(); return shell.openExternal(settings.bankaiUrl); });

ipcMain.handle('companion:open-jenkins', () => {
  const settings = readSettings();
  const caFile = path.join(settings.quincyPath, 'tools', 'local-jenkins', '.local', 'certs', 'jenkins.crt');
  if (!existsSync(caFile)) throw new Error('Jenkins certificate is not available. Start Jenkins first.');
  jenkinsWindow = new BrowserWindow({ width: 1080, height: 760, title: 'Local Jenkins · Bankai Companion', parent: mainWindow,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  jenkinsWindow.webContents.on('will-navigate', (event, url) => { if (!isLocalJenkinsUrl(url)) event.preventDefault(); });
  jenkinsWindow.webContents.setWindowOpenHandler(({ url }) => isLocalJenkinsUrl(url) ? { action: 'allow' } : { action: 'deny' });
  jenkinsWindow.loadURL('https://localhost:8443/login');
  return { opened: true };
});
