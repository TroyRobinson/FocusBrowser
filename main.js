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
