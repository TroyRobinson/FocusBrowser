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

  // Navigation shortcut bridge
  contextBridge.exposeInMainWorld('nav', {
    onNavigate: (handler) => {
      try {
        if (typeof handler !== 'function') return;
        const listener = (_evt, action) => {
          try { handler(action); } catch {}
        };
        ipcRenderer.on('nav:action', listener);
        // Return a simple unsubscribe if needed
        return () => ipcRenderer.removeListener('nav:action', listener);
      } catch {}
    },
    onOpenURL: (handler) => {
      try {
        if (typeof handler !== 'function') return () => {};
        const listener = (_evt, payload) => { try { handler(payload); } catch {} };
        ipcRenderer.on('webview:open-url', listener);
        return () => ipcRenderer.removeListener('webview:open-url', listener);
      } catch { return () => {}; }
    }
  });

  // Dev logging bridge (network and other main->renderer logs)
  contextBridge.exposeInMainWorld('devlog', {
    onNet: (handler) => {
      try {
        if (typeof handler !== 'function') return () => {};
        const listener = (_evt, payload) => {
          try { handler(payload); } catch {}
        };
        ipcRenderer.on('devlog:net', listener);
        return () => ipcRenderer.removeListener('devlog:net', listener);
      } catch {
        return () => {};
      }
    },
    onConsole: (handler) => {
      try {
        if (typeof handler !== 'function') return () => {};
        const listener = (_evt, payload) => {
          try { handler(payload); } catch {}
        };
        ipcRenderer.on('devlog:console', listener);
        return () => ipcRenderer.removeListener('devlog:console', listener);
      } catch {
        return () => {};
      }
    },
  });

  // Reliable storage API that persists across dev/packaged versions
  contextBridge.exposeInMainWorld('focusStorage', {
    get: async (key) => {
      try {
        return await ipcRenderer.invoke('storage:get', key);
      } catch {
        return null;
      }
    },
    set: async (key, value) => {
      try {
        return await ipcRenderer.invoke('storage:set', key, value);
      } catch {
        return false;
      }
    },
    remove: async (key) => {
      try {
        return await ipcRenderer.invoke('storage:remove', key);
      } catch {
        return false;
      }
    }
  });
}
