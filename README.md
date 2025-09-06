Focus Browser
================

Minimal Electron-based Chromium browser with a single address bar and embedded webview. Type an address and press Enter or click Go.

Commands

- Install dependencies: HOME=$(pwd)/.home npm install
- Start the app: npm start

Notes

- No menus or keyboard shortcuts are registered; DevTools are disabled.
- The address is normalized by adding https:// if no scheme is provided.
- Only whitelisted domains can be visited. Click the settings button (gear icon) to add allowed domains. Matching includes subdomains and any paths by default (e.g., adding example.com allows app.example.com and example.com/docs).
 - Whitelist activation delay: In Settings, set “Delay (min)”. Newly added domains activate after this many minutes; until then, they display a countdown beside each entry and are not allowed. Set to 0 for immediate activation.
