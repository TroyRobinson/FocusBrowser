const { app, BrowserWindow, Menu, session, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
let ElectronBlocker;
let fetch;
try {
  ({ ElectronBlocker } = require('@cliqz/adblocker-electron'));
  fetch = require('cross-fetch');
} catch {}

let mainWindow = null;
let blocker = null;
let adblockEnabled = true;
let devToolsEnabled = false;
const managedSessions = new Set();

// Coalesce navigation events to avoid duplicates from multiple sources
let _lastNavAction = '';
let _lastNavAt = 0;
function sendNav(action) {
  try {
    const now = Date.now();
    // Drop if same action fired very recently (e.g., from nested webContents)
    if (_lastNavAction === action && (now - _lastNavAt) < 120) return;
    _lastNavAction = action;
    _lastNavAt = now;
    mainWindow?.webContents?.send('nav:action', action);
  } catch {}
}

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
    devTools: devToolsEnabled,
    webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.show();
  });

  // Keyboard shortcuts: Cmd/Ctrl + ArrowLeft/ArrowRight, Cmd/Ctrl + R, Cmd/Ctrl + L, Cmd/Ctrl + N (toggle element select), Esc (stop)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    try {
      if (input?.type && input.type !== 'keyDown') return;
      const key = input.key;
      // F12: toggle devtools (no modifier)
      if (key === 'F12' && devToolsEnabled) {
        event.preventDefault();
        if (mainWindow?.webContents?.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools();
        } else {
          mainWindow.webContents.openDevTools();
        }
        return;
      }
      // Esc: stop loading (no modifier) and exit element selection
      if (key === 'Escape') {
        // Do not prevent default to avoid interfering with page ESC usage
        sendNav('stop');
        sendNav('exit-element-select');
        return;
      }
      const mod = input.control || input.meta;
      if (!mod) return;
      if (key === 'ArrowLeft') {
        // Do not prevent default so text inputs keep word/line navigation
        sendNav('back');
      } else if (key === 'ArrowRight') {
        // Do not prevent default so text inputs keep word/line navigation
        sendNav('forward');
      } else if (key === 'r' || key === 'R') {
        event.preventDefault();
        const action = input.shift ? 'refresh-shift' : 'refresh';
        sendNav(action);
      } else if (key === 'l' || key === 'L') {
        event.preventDefault();
        sendNav('focus-address');
      } else if (key === 'n' || key === 'N') {
        event.preventDefault();
        sendNav('toggle-element-select');
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
            if (input?.type && input.type !== 'keyDown') return;
            const key = input.key;
            const mod = input.control || input.meta;
            if (mod && key === 'ArrowLeft') {
              // Do not prevent default so text inputs keep word/line navigation
              sendNav('back');
            } else if (mod && key === 'ArrowRight') {
              // Do not prevent default so text inputs keep word/line navigation
              sendNav('forward');
            } else if (mod && (key === 'r' || key === 'R')) {
              event.preventDefault();
              const action = input.shift ? 'refresh-shift' : 'refresh';
              sendNav(action);
            } else if (mod && (key === 'l' || key === 'L')) {
              event.preventDefault();
              sendNav('focus-address');
            } else if (mod && (key === 'n' || key === 'N')) {
              event.preventDefault();
              sendNav('toggle-element-select');
            } else if (key === 'Escape') {
              // Let the page also handle ESC; forward stop and selection-exit
              sendNav('stop');
              sendNav('exit-element-select');
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

  // IPC to toggle devtools
  ipcMain.handle('devtools:getState', async () => ({ enabled: !!devToolsEnabled }));
  ipcMain.handle('devtools:setEnabled', async (_e, enabled) => {
    devToolsEnabled = !!enabled;
    return { enabled: devToolsEnabled };
  });

  // Persistent storage API that survives dev/packaged switches
  const userDataPath = app.getPath('userData');
  const dataFile = path.join(userDataPath, 'focus-data.json');

  function safeReadData() {
    try {
      if (!fs.existsSync(dataFile)) return {};
      const raw = fs.readFileSync(dataFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Failed to read data, starting fresh:', err.message);
      return {};
    }
  }

  function safeWriteData(data) {
    try {
      if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath, { recursive: true });
      }
      const backup = dataFile + '.backup';
      if (fs.existsSync(dataFile)) {
        fs.copyFileSync(dataFile, backup);
      }
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to save data:', err.message);
      return false;
    }
  }

  ipcMain.handle('storage:get', async (_e, key) => {
    const data = safeReadData();
    return data[key] ?? null;
  });

  ipcMain.handle('storage:set', async (_e, key, value) => {
    const data = safeReadData();
    data[key] = value;
    return safeWriteData(data);
  });

  ipcMain.handle('storage:remove', async (_e, key) => {
    const data = safeReadData();
    delete data[key];
    return safeWriteData(data);
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
