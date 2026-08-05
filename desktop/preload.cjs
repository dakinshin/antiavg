/**
 * Мост между окном и главным процессом.
 *
 * Окно не имеет доступа к Node и файловой системе: contextIsolation включён,
 * наружу отдаётся только этот явный список операций.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('antiavg', {
  getState: () => ipcRenderer.invoke('guard:getState'),
  getEvents: () => ipcRenderer.invoke('guard:getEvents'),
  start: () => ipcRenderer.invoke('guard:start'),
  stop: () => ipcRenderer.invoke('guard:stop'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (values) => ipcRenderer.invoke('settings:save', values),
  openLogFolder: () => ipcRenderer.invoke('app:openLogFolder'),

  onState: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('guard:state', h);
    return () => ipcRenderer.removeListener('guard:state', h);
  },
  onEvent: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('guard:event', h);
    return () => ipcRenderer.removeListener('guard:event', h);
  },
});
