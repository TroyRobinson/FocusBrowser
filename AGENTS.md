# AGENTS.md - Focus Browser

Do NOT try to start the app as it causes errors currently when being started by AI agents.
<!-- ## Build/Test/Run Commands
- **Start app**: `npm start` (runs electron)
- **Install dependencies**: `npm install` (use `HOME=$(pwd)/.home npm install` on macOS/Linux to avoid global pollution)
- **No tests configured**: package.json shows "Error: no test specified" -->

## Architecture Overview
- **Electron app** with single BrowserWindow and embedded webview for browsing
- **Main process**: main.js (production) or main.mjs (simpler version) - handles window creation, IPC, persistent storage, ad blocking
- **Renderer process**: renderer.js (2000+ lines) - handles UI, navigation, whitelist management, active sessions, AI chat
- **Preload script**: preload.js - safe IPC bridge for adblock, navigation shortcuts, persistent storage API
- **UI**: index.html + styles.css - minimal browser interface with settings panel

## Code Style & Conventions
- **JavaScript**: Mix of ES6+ features, async/await patterns, extensive try/catch error handling
- **Error handling**: Defensive coding with try/catch blocks around most operations, fallback values
- **Storage**: Custom persistent storage API via IPC (survives dev/packaged switches), localStorage fallback
- **Imports**: Node.js style requires (electron, node:path, node:fs) with compatibility fallbacks
- **Naming**: camelCase for functions/variables, kebab-case for HTML IDs/classes
- **Debug**: DEBUG flag and debugLog() function for development logging

## Key Features
- **Whitelist system**: Domain-based access control with activation delays
- **Active sessions**: Multi-tab like behavior with webview management  
- **Ad blocking**: Optional uBlock Origin integration via @cliqz/adblocker-electron
- **AI chat**: OpenRouter integration for AI queries (space-triggered in address bar)
- **Keyboard shortcuts**: Cmd/Ctrl navigation, Esc for stop, focus management
