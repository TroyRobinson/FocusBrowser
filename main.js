let electron;
try {
  electron = require('node:electron');
} catch {
  electron = require('electron');
}
const { app, BrowserWindow, Menu, session, ipcMain } = electron;
// Fallback safety if destructuring fails
if (!app || !BrowserWindow) {
  // eslint-disable-next-line no-console
  console.error('Electron module keys:', Object.keys(electron || {}));
}
const path = require('node:path');
let ElectronBlocker;
let fetch;
try {
  ({ ElectronBlocker } = require('@cliqz/adblocker-electron'));
  fetch = require('cross-fetch');
} catch {}

let mainWindow = null;
let blocker = null;
let adblockEnabled = true;
const managedSessions = new Set();

function enableBlockingIn(sess) {
  if (!blocker || !sess) return;
  try {
    blocker.enableBlockingInSession(sess);
    managedSessions.add(sess);
  } catch {}
}

function disableBlockingIn(sess) {
  if (!blocker || !sess) return;
  try {
    blocker.disableBlockingInSession(sess);
  } catch {}
}

function createWindow() {
  // Remove all menus to avoid default accelerators/shortcuts
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.show();
  });

  // Keyboard shortcuts: Cmd/Ctrl + ArrowLeft/ArrowRight, Cmd/Ctrl + R, Cmd/Ctrl + L, Esc (stop)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    try {
      const key = input.key;
      // Esc: stop loading (no modifier)
      if (key === 'Escape') {
        // Do not prevent default to avoid interfering with page ESC usage
        mainWindow?.webContents?.send('nav:action', 'stop');
        return;
      }
      const mod = input.control || input.meta;
      if (!mod) return;
      if (key === 'ArrowLeft') {
        event.preventDefault();
        mainWindow?.webContents?.send('nav:action', 'back');
      } else if (key === 'ArrowRight') {
        event.preventDefault();
        mainWindow?.webContents?.send('nav:action', 'forward');
      } else if (key === 'r' || key === 'R') {
        event.preventDefault();
        mainWindow?.webContents?.send('nav:action', 'refresh');
      } else if (key === 'l' || key === 'L') {
        event.preventDefault();
        mainWindow?.webContents?.send('nav:action', 'focus-address');
      }
    } catch {}
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Initialize ad blocker if available
  if (ElectronBlocker && fetch) {
    ElectronBlocker.fromPrebuiltAdsAndTracking(fetch).then((b) => {
      blocker = b;
      if (adblockEnabled) {
        // Enable for default session and any subsequently created webviews
        enableBlockingIn(session.defaultSession);
      }
    }).catch(() => {
      blocker = null;
    });
  }

  // When any webContents is created, ensure its session is managed (for webviews)
  app.on('web-contents-created', (_evt, contents) => {
    try {
      if (adblockEnabled && blocker) {
        enableBlockingIn(contents.session);
      }
      // Forward shortcuts when focus is inside a webview
      if (contents.getType && contents.getType() === 'webview') {
        contents.on('before-input-event', (event, input) => {
          try {
            const key = input.key;
            const mod = input.control || input.meta;
            if (mod && key === 'ArrowLeft') {
              event.preventDefault();
              mainWindow?.webContents?.send('nav:action', 'back');
            } else if (mod && key === 'ArrowRight') {
              event.preventDefault();
              mainWindow?.webContents?.send('nav:action', 'forward');
            } else if (mod && (key === 'r' || key === 'R')) {
              event.preventDefault();
              mainWindow?.webContents?.send('nav:action', 'refresh');
            } else if (mod && (key === 'l' || key === 'L')) {
              event.preventDefault();
              mainWindow?.webContents?.send('nav:action', 'focus-address');
            } else if (key === 'Escape') {
              // Let the page also handle ESC; just forward stop
              mainWindow?.webContents?.send('nav:action', 'stop');
            }
          } catch {}
        });
      }
    } catch {}
  });

  // IPC to toggle adblock globally
  ipcMain.handle('adblock:getState', async () => ({ enabled: !!adblockEnabled }));
  ipcMain.handle('adblock:setEnabled', async (_e, enabled) => {
    adblockEnabled = !!enabled;
    if (!blocker) return { enabled: adblockEnabled };
    // Apply to all known sessions
    const sessions = new Set(managedSessions);
    sessions.add(session.defaultSession);
    if (adblockEnabled) {
      for (const s of sessions) enableBlockingIn(s);
    } else {
      for (const s of sessions) disableBlockingIn(s);
    }
    return { enabled: adblockEnabled };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, apps commonly remain active until Cmd+Q. Here, quit for simplicity.
  app.quit();
});
