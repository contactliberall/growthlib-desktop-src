const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  getJobs: () => ipcRenderer.invoke('status:get-jobs'),
  openDashboard: () => ipcRenderer.invoke('widget:open-dashboard'),
  hide: () => ipcRenderer.invoke('widget:hide'),
});
