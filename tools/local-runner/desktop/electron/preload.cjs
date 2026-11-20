const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companion', {
  getState: () => ipcRenderer.invoke('companion:get-state'),
  saveSettings: (settings) => ipcRenderer.invoke('companion:save-settings', settings),
  pair: (values) => ipcRenderer.invoke('companion:pair', values),
  generateServiceToken: () => ipcRenderer.invoke('companion:generate-service-token'),
  startJenkins: () => ipcRenderer.invoke('companion:start-jenkins'),
  stopJenkins: () => ipcRenderer.invoke('companion:stop-jenkins'),
  startQuincy: () => ipcRenderer.invoke('companion:start-quincy'),
  stopQuincy: () => ipcRenderer.invoke('companion:stop-quincy'),
  startRunner: () => ipcRenderer.invoke('companion:start-runner'),
  stopRunner: () => ipcRenderer.invoke('companion:stop-runner'),
  openBankai: () => ipcRenderer.invoke('companion:open-bankai'),
  openJenkins: () => ipcRenderer.invoke('companion:open-jenkins'),
  chooseQuincyDirectory: () => ipcRenderer.invoke('companion:choose-quincy-directory'),
  chooseCertificate: () => ipcRenderer.invoke('companion:choose-certificate'),
  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('companion:event', handler);
    return () => ipcRenderer.removeListener('companion:event', handler);
  },
});
