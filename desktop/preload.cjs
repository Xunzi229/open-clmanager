const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  status: () => ipcRenderer.invoke('service:status'),
  start: () => ipcRenderer.invoke('service:start'),
  stop: () => ipcRenderer.invoke('service:stop'),
  setPort: value => ipcRenderer.invoke('service:set-port', value),
  openBrowser: () => ipcRenderer.invoke('service:open-browser'),
  onStatus: callback => ipcRenderer.on('service-status', (_event, status) => callback(status)),
}));
