const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('statusAPI', {
  getJobs: () => ipcRenderer.invoke('status:get-jobs'),
});
