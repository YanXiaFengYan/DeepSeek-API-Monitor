const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchStats: () => ipcRenderer.invoke('fetch-stats'),
  toggleSize: (collapsed) => ipcRenderer.send('toggle-size', collapsed),
  zoom: (delta) => ipcRenderer.invoke('zoom', delta),
  quit: () => ipcRenderer.send('quit-app'),

  // 登录相关
  verifyKey: (key) => ipcRenderer.invoke('verify-key', key),
  saveLogin: (creds) => ipcRenderer.invoke('save-login', creds),
  logout: () => ipcRenderer.send('logout'),

  onRefresh: (callback) => {
    ipcRenderer.on('refresh', () => callback());
    return () => ipcRenderer.removeAllListeners('refresh');
  },
});
