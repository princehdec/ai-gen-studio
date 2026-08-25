const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopInfo', {
  get: () => ipcRenderer.invoke('app:info'),
});

contextBridge.exposeInMainWorld('desktopMenu', {
  onAction: (listener) => {
    const handler = (_event, action) => listener(action);
    ipcRenderer.on('menu-action', handler);
    return () => ipcRenderer.removeListener('menu-action', handler);
  },
});

contextBridge.exposeInMainWorld('desktopUpdates', {
  getStatus: () => ipcRenderer.invoke('updates:status'),
  check: () => ipcRenderer.invoke('updates:check'),
  download: () => ipcRenderer.invoke('updates:download'),
  install: () => ipcRenderer.invoke('updates:install'),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('updates:state', handler);
    return () => ipcRenderer.removeListener('updates:state', handler);
  },
});
