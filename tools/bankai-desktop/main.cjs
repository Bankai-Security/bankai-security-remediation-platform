const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('node:path');

// Host the same frontend origin as the web app. This keeps Bankai's cookie
// session, API runtime config, and OAuth callbacks on their registered origins.
const WEB_URL = process.env.BANKAI_WEB_URL || 'https://bankai-frontend-staging.up.railway.app';
const WEB_ORIGIN = new URL(WEB_URL).origin;
const isLocalDev = WEB_URL.startsWith('http://localhost:');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let mainWindow;
let browserWindow;

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
