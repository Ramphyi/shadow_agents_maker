const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shadow', {
  connection: () => ipcRenderer.invoke('shadow:connection'),
  platform: process.platform,
});
