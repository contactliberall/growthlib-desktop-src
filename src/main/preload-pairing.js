const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pairingAPI', {
  login: (email, password) => ipcRenderer.invoke('pairing:login', email, password),
  listAccounts: () => ipcRenderer.invoke('pairing:list-accounts'),
  selectAccount: (id) => ipcRenderer.invoke('pairing:select-account', id),
});
