// Safe bridge APIs
let electron;
try {
  electron = require('node:electron');
} catch {
  electron = require('electron');
}
const { contextBridge, ipcRenderer } = electron || {};

if (contextBridge && ipcRenderer) {
  contextBridge.exposeInMainWorld('adblock', {
    getState: async () => {
      try {
        return await ipcRenderer.invoke('adblock:getState');
      } catch {
        return { enabled: false };
      }
    },
    setEnabled: async (enabled) => {
      try {
        return await ipcRenderer.invoke('adblock:setEnabled', !!enabled);
      } catch {
        return { enabled: false };
      }
    },
  });
}
