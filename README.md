Focus Browser
================

Minimal Electron-based Chromium browser with a single address bar and embedded webview. Type an address and press Enter or click Go.

Commands

- Install dependencies: HOME=$(pwd)/.home npm install
- Start the app: npm start

Notes

- No menus or keyboard shortcuts are registered; DevTools are disabled.
- The address is normalized by adding https:// if no scheme is provided.

