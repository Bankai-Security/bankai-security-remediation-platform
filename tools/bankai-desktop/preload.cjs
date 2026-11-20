const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bankaiDesktop', Object.freeze({
  openJenkins: (url) => ipcRenderer.invoke('bankai:open-jenkins', url),
  openExternal: (url) => ipcRenderer.invoke('bankai:open-external', url),
  platform: process.platform,
}));
