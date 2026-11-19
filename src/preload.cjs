const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mpApi', {
  invoke: (action, input) => ipcRenderer.invoke('mp:invoke', action, input),
});
