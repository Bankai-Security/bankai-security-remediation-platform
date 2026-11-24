const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bankaiDesktop', Object.freeze({
  openJenkins: (url, bounds) => ipcRenderer.invoke('bankai:open-jenkins', url, bounds),
  setJenkinsBrowserBounds: (bounds) => ipcRenderer.invoke('bankai:jenkins-browser-bounds', bounds),
  closeJenkinsBrowser: () => ipcRenderer.invoke('bankai:jenkins-browser-close'),
  onJenkinsBrowserNavigation: (callback) => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on('bankai:jenkins-browser-navigation', listener);
    return () => ipcRenderer.removeListener('bankai:jenkins-browser-navigation', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('bankai:open-external', url),
  getJenkinsConnection: () => ipcRenderer.invoke('bankai:jenkins-get-connection'),
  connectJenkins: (input) => ipcRenderer.invoke('bankai:jenkins-connect', input),
  ensureJenkinsPipeline: (repo) => ipcRenderer.invoke('bankai:jenkins-ensure-pipeline', repo),
  scanJenkinsMultibranch: (jobUrl) => ipcRenderer.invoke('bankai:jenkins-scan-multibranch', jobUrl),
  getJenkinsMultibranchIndexingStatus: (jobUrl, scan, includeLog) => ipcRenderer.invoke('bankai:jenkins-indexing-status', jobUrl, scan, includeLog),
  listJenkinsJobs: (repo) => ipcRenderer.invoke('bankai:jenkins-list-jobs', repo),
  disconnectJenkins: () => ipcRenderer.invoke('bankai:jenkins-disconnect'),
  runJenkinsJob: (url, parameters) => ipcRenderer.invoke('bankai:jenkins-run-job', url, parameters),
  resumeJenkinsJob: (jobUrl, buildUrl) => ipcRenderer.invoke('bankai:jenkins-resume-job', jobUrl, buildUrl),
  findRecentJenkinsBuild: (jobUrl, since) => ipcRenderer.invoke('bankai:jenkins-find-recent-build', jobUrl, since),
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
