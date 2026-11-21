const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bankaiDesktop', Object.freeze({
  openJenkins: (url) => ipcRenderer.invoke('bankai:open-jenkins', url),
  openExternal: (url) => ipcRenderer.invoke('bankai:open-external', url),
  getJenkinsConnection: () => ipcRenderer.invoke('bankai:jenkins-get-connection'),
  connectJenkins: (input) => ipcRenderer.invoke('bankai:jenkins-connect', input),
  listJenkinsJobs: () => ipcRenderer.invoke('bankai:jenkins-list-jobs'),
  disconnectJenkins: () => ipcRenderer.invoke('bankai:jenkins-disconnect'),
  runJenkinsJob: (url, parameters) => ipcRenderer.invoke('bankai:jenkins-run-job', url, parameters),
  getJenkinsJobParameters: (url) => ipcRenderer.invoke('bankai:jenkins-get-job-parameters', url),
  getJenkinsBuildLog: (url) => ipcRenderer.invoke('bankai:jenkins-build-log', url),
  cancelJenkinsJob: (url) => ipcRenderer.invoke('bankai:jenkins-cancel-build', url),
  onJenkinsJobProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('bankai:jenkins-job-progress', listener);
    return () => ipcRenderer.removeListener('bankai:jenkins-job-progress', listener);
  },
  platform: process.platform,
}));
