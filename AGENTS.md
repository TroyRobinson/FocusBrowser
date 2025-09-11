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

## Gotchas
- **Persistent storage API**: Use `window.focusStorage` via the `safeGetItem/safeSetItem` helpers in `renderer.js`. Do not use `window.storage`. Store arrays/objects as JSON strings; the helpers mirror to `localStorage` for immediate reads.
- **Selection-mode highlight**: Avoid overlay elements positioned by `getBoundingClientRect()`; UI chrome (toolbar) can offset coordinates. Instead, inject a CSS class on hover targets and style with `outline`.
- **Do not persist transient classes**: The hover highlighter uses the temporary class `__fb_hh_target__`. When generating selectors for deletion persistence, exclude this class and sanitize any existing rules by stripping it before applying.
- **Deletion persistence scope**: Save rules per registrable domain under the key `removeRules:<domain>` using `getRegistrableDomain(hostname)` (handles `example.co.uk` etc.). Apply rules on both `dom-ready` and `did-stop-loading`, and keep a `MutationObserver` active to remove matching nodes that re-appear.
- **Selector robustness**: Prefer `#id`, then `tag[role]`, `tag[aria-label]`, `tag[data-testid]`, then `tag.stableClass`. If needed, add `:nth-of-type(n)`. Fall back to a text match rule `{ kind: 'text', tag, text }` so static headings like “Example Domain” still match.
- **WebView execution**: Communicate with page context via `webview.executeJavaScript(...)`. If the page buffers results (e.g., collected signatures), poll from the renderer and then persist using the storage helpers.
