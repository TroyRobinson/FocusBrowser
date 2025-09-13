Focus Browser
================

Minimal Electron-based Chromium browser with a single address bar and embedded webview. Type an address and press Enter or click Go.

Commands

- Install dependencies: HOME=$(pwd)/.home npm install
- Start the app: npm start
- Build macOS DMG (Apple Silicon): HOME=$(pwd)/.home ELECTRON_CACHE=$(pwd)/.cache/electron npm run make -- --arch=arm64
  - Output: out/make/Focus Browser-<version>-arm64.dmg
  - Also produces ZIP: out/make/zip
  - First run: Control-click the app in Applications, choose Open (unsigned)

Build environment notes

- Keep Node version consistent across install and make. If you change Node versions (nvm/asdf/homebrew), native deps compiled earlier may no longer load during the DMG step.
- After switching Node, do one of the following before running make:
  - Quick fix for DMG maker: HOME=$(pwd)/.home npm rebuild macos-alias
  - Full reset: rm -rf node_modules package-lock.json && HOME=$(pwd)/.home npm install
    - Verify: node -p "process.version + ' modules=' + process.versions.modules"
      (the rebuild will match the current Node’s modules value)

Notes

- No menus or keyboard shortcuts are registered; DevTools are disabled.
- The address is normalized by adding https:// if no scheme is provided.
- Only whitelisted domains can be visited. Click the settings button (gear icon) to add allowed domains. Matching includes subdomains and any paths by default (e.g., adding example.com allows app.example.com and example.com/docs).
 - Whitelist activation delay: In Settings, set "Delay (min)". Newly added domains activate after this many minutes; until then, they display a countdown beside each entry and are not allowed. Set to 0 for immediate activation.

Troubleshooting

- **Settings not persisting**: If whitelist, delay, or active locations stop persisting after switching between dev and packaged versions, clear the corrupted userData:
  - **macOS**: `rm -rf ~/Library/Application\ Support/focus-browser`
  - **Windows**: `rmdir /s /q "%APPDATA%\focus-browser"`
  - **Linux**: `rm -rf ~/.config/focus-browser`
 - **DMG build ABI error**: If you see a native module "NODE_MODULE_VERSION" mismatch (e.g., macos-alias), it means the native binary was compiled for a different Node version than the one running Electron Forge.
   - Fix (fast): `HOME=$(pwd)/.home npm rebuild macos-alias`
   - Fix (clean): `rm -rf node_modules package-lock.json && HOME=$(pwd)/.home npm install`
   - Tip: use `nvm` to pin a single Node version for this project to avoid repeats.
