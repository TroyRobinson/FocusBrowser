let electron;
try {
  electron = require('node:electron');
} catch {
  electron = require('electron');
}
const { app, BrowserWindow, Menu } = electron;
// Fallback safety if destructuring fails
if (!app || !BrowserWindow) {
  // eslint-disable-next-line no-console
  console.error('Electron module keys:', Object.keys(electron || {}));
}
const path = require('node:path');

let mainWindow = null;

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
