// Check if input is an AI query (contains space after first word OR is a single non-URL word)
function isAIQuery(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return false;
  
  // Check for multi-word queries (original logic)
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex > 0) {
    // Ensure there's meaningful content after the space
    const afterSpace = trimmed.slice(spaceIndex + 1).trim();
    return afterSpace.length > 0;
  }
  
  // Check for single-word queries
  // Treat as AI query if it's a single word that doesn't look like a URL
  if (spaceIndex === -1) {
    // Exclude if it looks like a URL or domain
    if (trimmed.includes('.') && !trimmed.endsWith('.')) return false; // Has dots (likely domain)
    if (trimmed.includes('://')) return false; // Has protocol
    if (trimmed.includes('/') && trimmed.length > 3) return false; // Has path
    if (trimmed.includes('@')) return false; // Looks like email
    
    // Allow single words, especially with punctuation that suggests questions
    return true;
  }
  
  return false;
}

function stripNewTabSuffix(str) {
  try {
    const s = String(str || '');
    return s.replace(/ \+ open in a new (persistent )?tab$/i, '');
  } catch {
    return String(str || '');
  }
}

function normalizeToURL(input) {
  const trimmed = stripNewTabSuffix(input || '').trim();
  if (!trimmed) return null;
  
  // Check if it's an AI query first
  if (isAIQuery(trimmed)) {
    return `ai-chat://query/${encodeURIComponent(trimmed)}`;
  }

  // If missing scheme, default to https://
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  try {
    // Validate
    const url = new URL(candidate);
    return url.toString();
  } catch {
    return null;
  }
}

function updateAddressBarWithURL(url) {
  // Show empty space for about:blank instead of the actual URL
  if (!input) return;
  if (url === 'about:blank') {
    input.value = '';
  } else if (url && url.startsWith('data:text/html;charset=utf-8,')) {
    // Check if this is an AI chat data URL by looking for AI chat HTML content
    try {
      const decoded = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));
      if (decoded.includes('AI Chat -')) {
        // Extract query from the HTML title
        const titleMatch = decoded.match(/<title>AI Chat - (.*?)<\/title>/);
        if (titleMatch && titleMatch[1]) {
          const clean = decodeHTMLEntities(titleMatch[1]);
          input.value = `AI: ${clean}`;
          return;
        }
      }
    } catch {}
    // For AI chat pages without a specific query, keep the field empty
    input.value = '';
    try { input.placeholder = 'Your question...'; } catch {}
  } else {
    input.value = url || input.value;
  }
}

const form = document.getElementById('address-form');
const input = document.getElementById('address-input');
try { input?.classList?.add('click-select-armed'); } catch {}
const settingsBtn = document.getElementById('settings-button');
const backBtn = document.getElementById('back-button');
const navBackBtn = document.getElementById('nav-back-button');
const navForwardBtn = document.getElementById('nav-forward-button');
const navRefreshBtn = document.getElementById('nav-refresh-button');
const newActiveBtn = document.getElementById('new-active-button');
const loadingBar = document.getElementById('loading-bar');
const suggestionsEl = document.getElementById('address-suggestions');
const activeCountBubble = document.getElementById('active-count-bubble');
const removalCountBubble = document.getElementById('removal-count-bubble');
// Find-on-page UI
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findPrevBtn = document.getElementById('find-prev');
const findNextBtn = document.getElementById('find-next');
const findCountEl = document.getElementById('find-count');
const findCloseBtn = document.getElementById('find-close');
// One-shot flag: when Cmd/Ctrl+L focuses the address bar, force-show all active locations
let forceActiveSuggestionsOnNextFocus = false;
let isLoading = false;
let loadingInterval = null;
let loadingProgress = 0; // 0..100
let indeterminateTimer = null;
const settingsView = document.getElementById('settings-view');
// Primary (ephemeral) webview always uses id "webview"; active sessions get their own webviews
let primaryWebView = document.getElementById('webview');
let currentVisibleView = primaryWebView; // track which webview is currently shown

// --- Debug logging ---
const DEBUG = true;
function viewId(el) { try { return el?.id || '(no-id)'; } catch { return '(err)'; } }
function viewURL(el) { try { return el?.getURL?.() || ''; } catch { return ''; } }
function debugLog(...args) {
  try {
    if (!DEBUG) return;
    const ts = new Date().toISOString();
    // eslint-disable-next-line no-console
    const parts = args.map((a) => {
      try {
        if (a == null) return String(a);
        if (typeof a === 'string') return a;
        if (typeof a === 'object') return JSON.stringify(a);
        return String(a);
      } catch {
        return String(a);
      }
    });
    console.log(`[FocusDebug ${ts}]`, ...parts);
  } catch {}
}

// Lightweight duplicate suppression across multiple sources (renderer+main)
const __fbConsoleDupeCache = new Map(); // sig -> ts
function isConsoleDupe(sig, ttl = 1500) {
  try {
    const now = Date.now();
    const prev = __fbConsoleDupeCache.get(sig) || 0;
    if (now - prev < ttl) return true;
    __fbConsoleDupeCache.set(sig, now);
    // occasional pruning
    if (__fbConsoleDupeCache.size > 2000) {
      const cutoff = now - ttl * 2;
      for (const [k, t] of __fbConsoleDupeCache) { if (t < cutoff) __fbConsoleDupeCache.delete(k); }
    }
    return false;
  } catch { return false; }
}

// Decode minimal HTML entities to show clean text in the address bar
function decodeHTMLEntities(str) {
  try {
    if (!str) return '';
    // Handle numeric entities: decimal and hex
    let s = String(str)
      .replace(/&#(\d+);/g, (_, d) => {
        try { const code = parseInt(d, 10); return Number.isFinite(code) ? String.fromCharCode(code) : _; } catch { return _; }
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
        try { const code = parseInt(h, 16); return Number.isFinite(code) ? String.fromCharCode(code) : _; } catch { return _; }
      });
    // Named minimal entities we use
    s = s.replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"')
         .replace(/&#39;/g, "'");
    return s;
  } catch { return String(str || ''); }
}

function escapeRegex(str) {
  try {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  } catch {
    return String(str || '');
  }
}

function applyWebViewFrameStyles(el) {
  try {
    el.style.position = 'absolute';
    // Ensure it fills the content area fully regardless of id/class
    if (typeof el.style.inset !== 'undefined') {
      el.style.inset = '0';
    } else {
      el.style.top = '0';
      el.style.left = '0';
      el.style.right = '0';
      el.style.bottom = '0';
    }
    el.style.width = '100%';
    el.style.height = '100%';
  } catch {}
}
const banner = document.getElementById('banner');
const delayInput = document.getElementById('delay-input');
const delaySaveBtn = document.getElementById('delay-save-button');
const delayCountdownEl = document.getElementById('delay-countdown');
const extensionsBtn = document.getElementById('extensions-button');
const extensionsPopover = document.getElementById('extensions-popover');
const uboToggle = document.getElementById('ubo-toggle');
const darkToggle = document.getElementById('dark-toggle');

// Track last successfully allowed URL per webview to keep the user in place on block
function getLastAllowed(el) { return el?._lastAllowedURL || 'about:blank'; }
function setLastAllowed(el, url) { if (el) el._lastAllowedURL = url || 'about:blank'; }
setLastAllowed(primaryWebView, 'about:blank');

// Storage keys
const WL_KEY = 'whitelist';
const BL_KEY = 'blacklist_v1';
const DELAY_KEY = 'whitelist_delay_minutes';
const DELAY_PENDING_MIN_KEY = 'whitelist_delay_pending_minutes';
const DELAY_PENDING_AT_KEY = 'whitelist_delay_pending_activate_at';
const SORT_MODE_KEY = 'wl_sort_mode_v1'; // 'recent' | 'abc'
// Dark mode
const DARK_MODE_KEY = 'dark_mode_enabled_v1';
// uBlock per-domain persistence (domains where adblock is OFF)
const ADBLOCK_OFF_DOMAINS_KEY = 'adblock_off_domains_v1';

// Active sessions persistence
const ACTIVE_SESSIONS_KEY = 'active_sessions_v1';
const VISIBLE_VIEW_KEY = 'visible_view_v1';

// LLM settings keys
const LLM_API_KEY_KEY = 'llm_api_key';
const LLM_MODEL_KEY = 'llm_model';
const LLM_SYSTEM_PROMPT_KEY = 'llm_system_prompt';

// LLM pending settings keys (for delay mechanism)
const LLM_PENDING_API_KEY_KEY = 'llm_pending_api_key';
const LLM_PENDING_MODEL_KEY = 'llm_pending_model';
const LLM_PENDING_SYSTEM_PROMPT_KEY = 'llm_pending_system_prompt';
const LLM_PENDING_AT_KEY = 'llm_pending_activate_at';

// --- Dark mode state (cached) ---
let darkModeEnabled = false;

// AI conversation tracking
let currentConversation = null; // { messages: [], webview: element }
// Preserve conversations per webview so back/forward restores the thread
const conversationByView = new WeakMap();

function resetConversationIfNeeded(webview, newURL) {
  // When navigating away from AI chat, preserve the conversation state so Back continues the thread.
  if (currentConversation && currentConversation.webview === webview) {
    const isAIChat = newURL && newURL.startsWith('data:text/html') &&
                     (newURL.includes('AI%20Chat') || newURL.includes('AI Chat'));
    if (!isAIChat) {
      debugLog('leaving AI chat, preserving conversation', { id: viewId(webview), newURL });
      // Do NOT clear currentConversation; keep placeholder neutral
      if (input) {
        input.placeholder = '';
      }
    }
  }
}

// Helper: detect if a URL/webview is showing an AI Chat thread
function isAIChatURL(url) {
  try {
    const u = String(url || '');
    return u.startsWith('data:text/html') && (u.includes('AI%20Chat') || u.includes('AI Chat'));
  } catch {
    return false;
  }
}

// Helper: pull the initial AI query for a chat thread displayed in a webview
function getAIChatInitialQueryFromWebView(el) {
  try {
    const v = el;
    // Prefer live conversation state if this webview owns it
    if (currentConversation && currentConversation.webview === v) {
      const firstUser = (currentConversation.messages || []).find(m => m.role === 'user');
      const q = (firstUser?.content || '').trim();
      if (q) return q;
    }
    // Fallback: parse from data URL title
    const url = v?.getURL?.() || '';
    if (url.startsWith('data:text/html')) {
      try {
        const decoded = decodeURIComponent(url.replace('data:text/html;charset=utf-8,', '').replace('data:text/html,', ''));
        const m = decoded.match(/<title>AI Chat - (.*?)<\/title>/);
        if (m && m[1]) return decodeHTMLEntities(String(m[1]).trim());
      } catch {}
    }
  } catch {}
  return '';
}

// Handle refresh semantics: if on AI chat, start a new thread; otherwise reload/stop
// If opts.shiftKey/shiftToActive is true while on AI chat, park the current
// chat thread as an active location and start the new thread in a fresh primary view.
function refreshOrNewThread(opts = {}) {
  try {
    const v = getVisibleWebView();
    const url = v?.getURL?.() || '';
    const loading = typeof v?.isLoading === 'function' ? !!v.isLoading() : !!isLoading;
    const shiftToActive = !!(opts.shiftKey || opts.shiftToActive);

    if (isAIChatURL(url)) {
      // Clear current conversation and show a blank AI chat page
      currentConversation = null;
      try { conversationByView.delete(v); } catch {}
      try { if (input) input.placeholder = ''; } catch {}

      const conversation = { messages: [] };
      const html = generateAIChatHTML(conversation, false);
      const dataURL = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

      if (shiftToActive) {
        // Park current chat thread (if not already active) and start a new thread in a fresh primary webview
        try { parkCurrentAsActive(); } catch {}
        const dest = ensurePrimaryWebView();
        setLastAllowed(dest, dataURL);
        try { dest?.setAttribute?.('src', dataURL); } catch { try { dest.src = dataURL; } catch {} }
        switchToWebView(dest);
        try { conversationByView.delete(dest); } catch {}
      } else {
        // Default behavior: reset this webview in-place
        setLastAllowed(v, dataURL);
        try { v?.setAttribute?.('src', dataURL); } catch { try { v.src = dataURL; } catch {} }
        try { conversationByView.delete(v); } catch {}
      }

      // Focus and clear the address bar so user can type the initial term(s)
      try {
        if (input) {
          input.value = '';
          input.focus();
          input.select?.();
          input?.classList?.remove('click-select-armed');
          input.placeholder = 'Your question...';
          // Surface suggestions (e.g., active sessions) to speed up input
          try { renderSuggestions(true); } catch {}
        }
      } catch {}
      return; // Do not fall-through to reload/stop
    }

    // Non-AI pages: keep standard refresh/stop behavior
    if (loading) {
      v?.stop?.();
    } else {
      v?.reload?.();
    }
  } catch {}
}

// Cached sort mode for synchronous access
let cachedSortMode = 'recent';

// Load and cache sort mode on startup
(async function initSortMode() {
  try {
    const stored = await safeGetItem(SORT_MODE_KEY);
    cachedSortMode = (stored === 'abc') ? 'abc' : 'recent';
  } catch {}
})();

// Reliable storage wrapper with localStorage fallback
async function safeGetItem(key) {
  try {
    if (window.focusStorage) {
      const value = await window.focusStorage.get(key);
      if (value !== null) return value;
    }
    // Fallback to localStorage and migrate
    const fallback = localStorage.getItem(key);
    if (fallback && window.focusStorage) {
      await window.focusStorage.set(key, fallback);
    }
    return fallback;
  } catch {
    return localStorage.getItem(key);
  }
}

async function safeSetItem(key, value) {
  try {
    // Try reliable storage first
    if (window.focusStorage) {
      const success = await window.focusStorage.set(key, value);
      if (success) {
        // Also update localStorage for immediate synchronous access
        localStorage.setItem(key, value);
        return true;
      }
    }
    localStorage.setItem(key, value);
    return true;
  } catch {
    localStorage.setItem(key, value);
    return false;
  }
}

async function safeRemoveItem(key) {
  try {
    if (window.focusStorage) {
      await window.focusStorage.remove(key);
    }
    localStorage.removeItem(key);
    return true;
  } catch {
    localStorage.removeItem(key);
    return false;
  }
}

// Bootstrap storage sync: ensure critical keys from focusStorage are mirrored into localStorage
// This makes legacy localStorage readers (e.g., whitelist/delay loaders) see unified data
(async function bootstrapStorageSync() {
  try {
    const keys = [WL_KEY, BL_KEY, DELAY_KEY, DELAY_PENDING_MIN_KEY, DELAY_PENDING_AT_KEY, ADBLOCK_OFF_DOMAINS_KEY];
    for (const k of keys) {
      try {
        const v = await safeGetItem(k);
        if (v != null && localStorage.getItem(k) !== v) {
          localStorage.setItem(k, v);
        }
      } catch {}
    }
  } catch {}
})();

// LLM Settings functions
async function loadLLMSettings() {
  try {
    const apiKey = await safeGetItem(LLM_API_KEY_KEY) || '';
    const model = await safeGetItem(LLM_MODEL_KEY) || 'openai/gpt-3.5-turbo';
    const systemPrompt = await safeGetItem(LLM_SYSTEM_PROMPT_KEY) || 'You are a helpful AI assistant. Provide clear, concise answers.';
    
    return { apiKey, model, systemPrompt };
  } catch {
    return {
      apiKey: '',
      model: 'openai/gpt-3.5-turbo',
      systemPrompt: 'You are a helpful AI assistant. Provide clear, concise answers.'
    };
  }
}

async function saveLLMSettings(settings) {
  try {
    await safeSetItem(LLM_API_KEY_KEY, settings.apiKey || '');
    await safeSetItem(LLM_MODEL_KEY, settings.model || 'openai/gpt-3.5-turbo');
    await safeSetItem(LLM_SYSTEM_PROMPT_KEY, settings.systemPrompt || 'You are a helpful AI assistant. Provide clear, concise answers.');
    return true;
  } catch {
    return false;
  }
}

function loadWhitelist() {
  try {
    const raw = localStorage.getItem(WL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const items = parsed
      .map((v) => {
        if (typeof v === 'string') return { domain: v.trim().toLowerCase(), activateAt: 0 };
        if (v && typeof v === 'object' && typeof v.domain === 'string') {
          const domain = v.domain.trim().toLowerCase();
          const at = Number(v.activateAt || 0);
          return { domain, activateAt: Number.isFinite(at) ? at : 0 };
        }
        return null;
      })
      .filter(Boolean);
    const map = new Map();
    for (const it of items) {
      const ex = map.get(it.domain);
      if (!ex || it.activateAt < ex.activateAt) map.set(it.domain, it);
    }
    return Array.from(map.values());
  } catch {
    return [];
  }
}

async function saveWhitelist(list) {
  const map = new Map();
  for (const it of list) {
    if (!it || !it.domain) continue;
    const domain = String(it.domain).trim().toLowerCase();
    const at = Number(it.activateAt || 0);
    const norm = { domain, activateAt: Number.isFinite(at) ? at : 0 };
    const ex = map.get(domain);
    if (!ex || norm.activateAt < ex.activateAt) map.set(domain, norm);
  }
  const data = JSON.stringify(Array.from(map.values()));
  await safeSetItem(WL_KEY, data);
}

// --- Blacklist: terms/phrases that trigger auto-close ---
function loadBlacklist() {
  try {
    const raw = localStorage.getItem(BL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const items = parsed
      .map((v) => {
        if (typeof v === 'string') return { term: v.trim(), activateAt: 0 };
        if (v && typeof v === 'object' && typeof v.term === 'string') {
          const term = v.term.trim();
          const at = Number(v.activateAt || 0);
          return term ? { term, activateAt: Number.isFinite(at) ? at : 0 } : null;
        }
        return null;
      })
      .filter(Boolean);
    // Deduplicate by term (case-insensitive)
    const map = new Map();
    for (const it of items) {
      const key = it.term.toLowerCase();
      const ex = map.get(key);
      if (!ex || it.activateAt < ex.activateAt) map.set(key, it);
    }
    return Array.from(map.values());
  } catch {
    return [];
  }
}

async function saveBlacklist(list) {
  try {
    const map = new Map();
    for (const it of list) {
      if (!it || !it.term) continue;
      const term = String(it.term).trim();
      if (!term) continue;
      const at = Number(it.activateAt || 0);
      const norm = { term, activateAt: Number.isFinite(at) ? at : 0 };
      const key = term.toLowerCase();
      const ex = map.get(key);
      if (!ex || norm.activateAt < ex.activateAt) map.set(key, norm);
    }
    const data = JSON.stringify(Array.from(map.values()));
    await safeSetItem(BL_KEY, data);
  } catch {}
}

// --- uBlock per-domain OFF list ---
function loadAdblockDisabledDomains() {
  try {
    const raw = localStorage.getItem(ADBLOCK_OFF_DOMAINS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out = [];
    const seen = new Set();
    for (const v of parsed) {
      if (typeof v !== 'string') continue;
      const d = v.trim().toLowerCase();
      if (!d) continue;
      if (!seen.has(d)) { seen.add(d); out.push(d); }
    }
    return out;
  } catch {
    return [];
  }
}

async function saveAdblockDisabledDomains(list) {
  try {
    const seen = new Set();
    const out = [];
    for (const v of Array.isArray(list) ? list : []) {
      if (typeof v !== 'string') continue;
      const d = v.trim().toLowerCase();
      if (!d) continue;
      if (!seen.has(d)) { seen.add(d); out.push(d); }
    }
    await safeSetItem(ADBLOCK_OFF_DOMAINS_KEY, JSON.stringify(out));
  } catch {}
}

function sanitizeDelay(n) {
  const v = Math.max(0, Math.floor(Number(n ?? 0)));
  return Number.isFinite(v) ? v : 0;
}

function getPendingDelay() {
  try {
    const minRaw = localStorage.getItem(DELAY_PENDING_MIN_KEY);
    const atRaw = localStorage.getItem(DELAY_PENDING_AT_KEY);
    if (minRaw == null || atRaw == null) return null;
    const minutes = sanitizeDelay(minRaw);
    const activateAt = Number(atRaw);
    if (!Number.isFinite(activateAt) || activateAt <= Date.now()) return null;
    return { minutes, activateAt };
  } catch {
    return null;
  }
}

async function clearPendingDelay() {
  await safeRemoveItem(DELAY_PENDING_MIN_KEY);
  await safeRemoveItem(DELAY_PENDING_AT_KEY);
}

async function setEffectiveDelayMinutes(n) {
  const v = sanitizeDelay(n);
  await safeSetItem(DELAY_KEY, String(v));
}

function promotePendingIfDue() {
  try {
    const atRaw = localStorage.getItem(DELAY_PENDING_AT_KEY);
    const minRaw = localStorage.getItem(DELAY_PENDING_MIN_KEY);
    if (atRaw == null || minRaw == null) return false;
    const at = Number(atRaw);
    if (!Number.isFinite(at)) { clearPendingDelay(); return false; }
    if (Date.now() >= at) {
      const minutes = sanitizeDelay(minRaw);
      setEffectiveDelayMinutes(minutes);
      clearPendingDelay();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// LLM pending settings management functions - per field
function getPendingLLMSetting(field) {
  try {
    const atRaw = localStorage.getItem(`${LLM_PENDING_AT_KEY}_${field}`);
    if (atRaw == null) return null;
    const activateAt = Number(atRaw);
    if (!Number.isFinite(activateAt) || activateAt <= Date.now()) return null;
    
    const value = localStorage.getItem(`llm_pending_${field}`);
    return { value, activateAt };
  } catch {
    return null;
  }
}

function getPendingLLMSettings() {
  return {
    apiKey: getPendingLLMSetting('apiKey'),
    model: getPendingLLMSetting('model'),
    systemPrompt: getPendingLLMSetting('systemPrompt')
  };
}

async function clearPendingLLMSetting(field) {
  await safeRemoveItem(`llm_pending_${field}`);
  await safeRemoveItem(`${LLM_PENDING_AT_KEY}_${field}`);
}

async function clearPendingLLMSettings() {
  await clearPendingLLMSetting('apiKey');
  await clearPendingLLMSetting('model');
  await clearPendingLLMSetting('systemPrompt');
}

async function promotePendingLLMSettingIfDue(field) {
  try {
    const atRaw = localStorage.getItem(`${LLM_PENDING_AT_KEY}_${field}`);
    if (atRaw == null) return false;
    const at = Number(atRaw);
    if (!Number.isFinite(at)) { clearPendingLLMSetting(field); return false; }
    if (Date.now() >= at) {
      const value = localStorage.getItem(`llm_pending_${field}`);
      const currentSettings = await loadLLMSettings();
      const newSettings = { ...currentSettings, [field]: value };
      
      await saveLLMSettings(newSettings);
      await clearPendingLLMSetting(field);
      
      // Reset dirty flag for this field when promoted
      llmInputsDirty[field] = false;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function promotePendingLLMSettingsIfDue() {
  const apiKeyPromoted = await promotePendingLLMSettingIfDue('apiKey');
  const modelPromoted = await promotePendingLLMSettingIfDue('model');
  const systemPromptPromoted = await promotePendingLLMSettingIfDue('systemPrompt');
  return apiKeyPromoted || modelPromoted || systemPromptPromoted;
}

async function schedulePendingLLMSetting(field, newValue) {
  const delayMinutes = getDelayMinutes();
  if (delayMinutes === 0) {
    // Immediate effect, no countdown
    const currentSettings = await loadLLMSettings();
    const updatedSettings = { ...currentSettings, [field]: newValue };
    await saveLLMSettings(updatedSettings);
    await clearPendingLLMSetting(field);
    return { immediate: true };
  }
  const activateAt = Date.now() + delayMinutes * 60 * 1000;
  await safeSetItem(`llm_pending_${field}`, newValue);
  await safeSetItem(`${LLM_PENDING_AT_KEY}_${field}`, String(activateAt));
  return { immediate: false, activateAt };
}

async function schedulePendingLLMSettings(newSettings) {
  const currentSettings = await loadLLMSettings();
  const results = { immediate: true, hasChanges: false };
  
  // Only schedule changes for fields that actually changed
  for (const [field, newValue] of Object.entries(newSettings)) {
    if (currentSettings[field] !== newValue) {
      const result = await schedulePendingLLMSetting(field, newValue);
      results.hasChanges = true;
      if (!result.immediate) {
        results.immediate = false;
        results.activateAt = result.activateAt;
      }
    }
  }
  
  return results;
}

function getDelayMinutes() {
  // Returns the current effective delay; promotes pending if due.
  promotePendingIfDue();
  // Note: promotePendingLLMSettingsIfDue is async but called from timer - it will run async
  promotePendingLLMSettingsIfDue();
  const raw = localStorage.getItem(DELAY_KEY);
  return sanitizeDelay(raw);
}

async function schedulePendingDelay(newMinutes) {
  const effective = getDelayMinutes();
  const next = sanitizeDelay(newMinutes);

  // If raising the delay, apply immediately (no waiting)
  if (next > effective) {
    await setEffectiveDelayMinutes(next);
    await clearPendingDelay();
    return { immediate: true };
  }

  // If equal, treat as no-op
  if (next === effective) {
    await clearPendingDelay();
    return { immediate: true };
  }

  // If lowering the delay, schedule it to take effect after the current
  // effective delay countdown completes.
  const activateAt = Date.now() + effective * 60 * 1000;
  await safeSetItem(DELAY_PENDING_MIN_KEY, String(next));
  await safeSetItem(DELAY_PENDING_AT_KEY, String(activateAt));
  return { immediate: false, activateAt };
}

function extractHostname(input) {
  const urlStr = normalizeToURL(input);
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Heuristic to compute the registrable root domain for banner action
function getRegistrableDomain(hostname) {
  if (!hostname) return null;
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const ccSecondLevels = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);
  if (tld.length === 2 && ccSecondLevels.has(sld)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function isActive(item) {
  return !item.activateAt || Date.now() >= item.activateAt;
}

function isHostAllowed(hostname) {
  if (!hostname) return false;
  const list = loadWhitelist().filter(isActive);
  const host = hostname.toLowerCase();
  return list.some((it) => host === it.domain || host.endsWith(`.${it.domain}`));
}

function isUrlAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol === 'about:') return true;
    if (u.protocol === 'data:' && urlStr.startsWith('data:text/html')) return true; // Allow HTML data URLs
    if (u.hostname) return isHostAllowed(u.hostname);
    return false;
  } catch {
    return false;
  }
}

function getActiveBlacklistTerms() {
  try {
    const terms = loadBlacklist().filter(isActive).map((x) => String(x.term || '').trim()).filter(Boolean);
    // Normalize and dedupe case-insensitively
    const seen = new Set();
    const out = [];
    for (const t of terms) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const isPhrase = /\s/.test(t);
      out.push({ term: t, phrase: isPhrase });
    }
    return out;
  } catch {
    return [];
  }
}

async function checkBlacklistForWebView(el) {
  try {
    if (!el || typeof el.executeJavaScript !== 'function') return;
    const url = el.getURL?.() || '';
    if (!url || url === 'about:blank') return;
    // Skip AI chat pages and non-http(s)
    try {
      const u = new URL(url);
      if (!(u.protocol === 'http:' || u.protocol === 'https:')) return;
    } catch { return; }
    const terms = getActiveBlacklistTerms();
    if (!terms.length) return;

    const payload = terms.map(t => ({ term: String(t.term), phrase: !!t.phrase }));
    const js = `(() => {
      try {
        const TERMS = ${JSON.stringify(payload)};
        function normSpaces(s) { return String(s || '').replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase(); }
        function normAlnum(s) { return normSpaces(String(s||'').toLowerCase()).replace(/[^a-z0-9_]+/g, ' ').replace(/[ ]+/g, ' ').trim(); }
        const titleRaw = String(document.title || '');
        const title = normSpaces(titleRaw);
        const titleNP = normAlnum(titleRaw);
        const body = document.body;
        const raw = String(body ? (body.innerText || body.textContent || '') : (document.documentElement?.innerText || ''));
        const hay = normSpaces(raw);
        const hayNP = normAlnum(raw);
        const pTitleNP = ' ' + titleNP + ' ';
        const pHayNP = ' ' + hayNP + ' ';
        function isWord(ch) { return /[A-Za-z0-9_]/.test(ch || ''); }
        function containsWhole(h, nd) {
          if (!nd) return false;
          let i = h.indexOf(nd);
          while (i !== -1) {
            const prev = i > 0 ? h[i - 1] : '';
            const next = i + nd.length < h.length ? h[i + nd.length] : '';
            if (!isWord(prev) && !isWord(next)) return true;
            i = h.indexOf(nd, i + 1);
          }
          return false;
        }
        for (const t of TERMS) {
          const needle = String(t.term || '');
          const nLower = needle.toLowerCase();
          if (!nLower) continue;
          if (t.phrase) {
            const nNeedleNP = normAlnum(nLower);
            if (!nNeedleNP) continue;
            if (hayNP.includes(nNeedleNP) || titleNP.includes(nNeedleNP)) return t.term;
            // Fallback simple space-only match
            const nNeedle = normSpaces(nLower);
            if (hay.includes(nNeedle) || title.includes(nNeedle)) return t.term;
          } else {
            const nWord = normAlnum(nLower);
            if (nWord && (pHayNP.includes(' ' + nWord + ' ') || pTitleNP.includes(' ' + nWord + ' '))) return t.term;
            if (containsWhole(hay, nLower) || containsWhole(title, nLower)) return t.term;
          }
        }
        return null;
      } catch { return null; }
    })();`;

    const found = await el.executeJavaScript(js, true).catch(() => null);
    if (found) {
      try { debugLog('blacklist-hit', { id: viewId(el), term: String(found) }); } catch {}
      await handleBlacklistHit(el, String(found));
    } else {
      try { debugLog('blacklist-scan-clear', { id: viewId(el), terms: terms.length }); } catch {}
    }
  } catch {}
}

async function handleBlacklistHit(el, term) {
  try {
    const msg = `"${term}" blacklist word/phrase was found in the page and thus closed`;
    // Close: if active view, remove it. If primary, navigate to about:blank.
    const isVisible = (el === getVisibleWebView());
    const aid = findActiveIdByWebView(el);
    if (aid) {
      try {
        activeLocations.delete(String(aid));
        activeMru = activeMru.filter((x) => x !== String(aid) && activeLocations.has(x));
      } catch {}
      try { el.remove(); } catch {}
      updateActiveCountBubble();
      persistActiveSessions().catch(() => {});
      if (isVisible) {
        const dest = ensurePrimaryWebView();
        switchToWebView(dest);
      }
    } else {
      try { el.stop?.(); } catch {}
      try { el.setAttribute('src', 'about:blank'); } catch { try { el.src = 'about:blank'; } catch {} }
      setLastAllowed(el, 'about:blank');
      if (isVisible) updateAddressBarWithURL('about:blank');
    }
    showBanner(msg, 'error', 8000);
  } catch {}
}

let bannerTimeout = null;
let currentBannerAction = null; // Store the current action function for Enter key confirmation

function clearBannerAction() {
  // Clear only the keyboard confirmation, but keep the banner visible
  currentBannerAction = null;
}

function clearBanner() {
  if (!banner) return;
  banner.classList.add('hidden');
  banner.textContent = '';
  banner.classList.remove('error');
  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = null;
  currentBannerAction = null; // Clear the action when banner is cleared
}

function showBanner(message, kind = '', durationMs = 900) {
  if (!banner) return;
  banner.classList.remove('hidden', 'error');
  if (kind) banner.classList.add(kind);
  banner.textContent = '';
  
  const span = document.createElement('span');
  span.textContent = message;
  banner.appendChild(span);
  
  const closeBtn = document.createElement('span');
  closeBtn.className = 'banner-close';
  closeBtn.innerHTML = '×';
  closeBtn.onclick = clearBanner;
  banner.appendChild(closeBtn);
  
  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    banner.classList.add('hidden');
  }, durationMs);
}

function showActionBanner(message, actionLabel, onAction, kind = '', durationMs = 1400) {
  if (!banner) return;
  banner.classList.remove('hidden', 'error');
  if (kind) banner.classList.add(kind);
  banner.textContent = '';
  const span = document.createElement('span');
  span.textContent = message + ' ';
  const btn = document.createElement('button');
  btn.className = 'action-btn';
  btn.type = 'button';
  btn.textContent = actionLabel;
  
  // Store the action function for keyboard confirmation
  currentBannerAction = () => {
    // Add flash effect to the button
    btn.style.backgroundColor = '#2563eb'; // Brand blue flash
    setTimeout(() => {
      btn.style.backgroundColor = ''; // Reset to default
    }, 200);
    
    setTimeout(() => {
      try { onAction?.(); } finally { clearBanner(); }
    }, 200); // Execute action after flash
  };
  
  btn.addEventListener('click', currentBannerAction);
  
  const closeBtn = document.createElement('span');
  closeBtn.className = 'banner-close';
  closeBtn.innerHTML = '×';
  closeBtn.onclick = clearBanner;
  
  banner.appendChild(span);
  banner.appendChild(btn);
  banner.appendChild(closeBtn);
  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    banner.classList.add('hidden');
  }, durationMs);
}

function showBlockedWithAdd(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    const wl = loadWhitelist();
    const pending = wl.find((it) => (host === it.domain || host.endsWith(`.${it.domain}`)) && !isActive(it));
    if (pending) {
      const remaining = Math.max(0, (pending.activateAt || 0) - Date.now());
      const label = fmtRemaining(remaining) || 'Less than 1s';
      showBanner(`${label} left until active`, 'error', 8000);
    } else {
      showActionBanner(
        `Blocked: ${host} is not in whitelist.`,
        `Add ${host}`,
        () => { addDomainWithDelay(host); },
        'error',
        8000
      );
    }
  } catch {
    showBanner('Blocked: domain not in whitelist', 'error', 6000);
  }
}

function setSettingsVisible(visible) {
  if (!settingsView) return;
  const allViews = Array.from(document.querySelectorAll('webview'));
  if (visible) {
    settingsView.classList.remove('hidden');
    allViews.forEach((wv) => wv.classList.add('hidden'));
    try { settingsBtn?.classList.add('active'); } catch {}
    try { closeFindBar(); } catch {}
    // Show "Settings" in the address bar while settings are open
    try { if (input) input.value = 'Settings'; } catch {}
    // Disable nav arrows while in settings
    try { updateNavButtons(); } catch {}
    // Hide address bar bubbles while in settings
    try { activeCountBubble?.classList?.add?.('hidden'); } catch {}
    try { removalCountBubble?.classList?.add?.('hidden'); } catch {}
  } else {
    settingsView.classList.add('hidden');
    // restore only current visible view
    getVisibleWebView()?.classList.remove('hidden');
    try { settingsBtn?.classList.remove('active'); } catch {}
    // Restore address bar to current view URL
    try { const v = getVisibleWebView(); const url = v?.getURL?.() || ''; updateAddressBarWithURL(url); } catch {}
    try { updateNavButtons(); } catch {}
    // Restore bubbles to reflect current state
    try { updateActiveCountBubble(); } catch {}
    try { updateRemovalCountBubble(); } catch {}
  }
}

function leaveSettingsIfOpen() {
  // Close settings and restore content area if currently visible
  if (!settingsView || settingsView.classList.contains('hidden')) return;
  setSettingsVisible(false);
  stopCountdown();
  clearWhitelistSelection();
}

function closeSettingsOnLoad(el) {
  if (!el) return;
  const done = () => { try { leaveSettingsIfOpen(); } catch {} };
  el.addEventListener('did-stop-loading', done, { once: true });
  el.addEventListener('did-fail-load', done, { once: true });
}

// Settings UI wiring
const addDomainForm = document.getElementById('add-domain-form');
const domainInput = document.getElementById('domain-input');
const domainList = document.getElementById('domain-list');
const sortToggle = document.getElementById('sort-toggle');

// Settings tabs
const whitelistTab = document.getElementById('whitelist-tab');
const blacklistTab = document.getElementById('blacklist-tab');
const llmTab = document.getElementById('llm-tab');
const whitelistContent = document.getElementById('whitelist-content');
const blacklistContent = document.getElementById('blacklist-content');
const llmContent = document.getElementById('llm-content');

// LLM Settings
const llmApiKeyInput = document.getElementById('llm-api-key');
const llmModelInput = document.getElementById('llm-model');
const llmSystemPromptInput = document.getElementById('llm-system-prompt');
const llmSaveButton = document.getElementById('llm-save-button');

// LLM Settings Cancel Buttons
const llmApiKeyCancelButton = document.getElementById('llm-api-key-cancel');
const llmModelCancelButton = document.getElementById('llm-model-cancel');
const llmSystemPromptCancelButton = document.getElementById('llm-system-prompt-cancel');

// LLM settings controls state
let llmInputsDirty = {
  apiKey: false,
  model: false,
  systemPrompt: false
};

function fmtRemaining(ms) {
  if (ms <= 0) return '';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function hasPending(list) {
  return list.some((it) => !isActive(it));
}

let countdownInterval = null;
function startCountdown() {
  if (countdownInterval) return;
  countdownInterval = setInterval(() => {
    if (!settingsView || settingsView.classList.contains('hidden')) return;
    renderWhitelist();
    renderBlacklist?.();
    renderDelayControls?.();
    renderLLMSettings?.();
  }, 1000);
}
function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// Whitelist selection state
let wlSelectedDomains = new Set();
let wlAnchorIndex = null;
let wlViewDomains = [];

function clearWhitelistSelection() {
  wlSelectedDomains = new Set();
  wlAnchorIndex = null;
}

function isFocusableInput(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}

function autosizeDomainInput() {
  if (!domainInput) return;
  try {
    const cs = window.getComputedStyle(domainInput);
    const lh = parseFloat(cs.lineHeight) || 20;
    const padTop = parseFloat(cs.paddingTop || '0');
    const padBot = parseFloat(cs.paddingBottom || '0');
    const borderTop = parseFloat(cs.borderTopWidth || '0');
    const borderBot = parseFloat(cs.borderBottomWidth || '0');
    const maxPx = Math.round(lh * 10 + padTop + padBot + borderTop + borderBot);

    // Collapse before measuring to avoid phantom extra line space
    domainInput.style.height = '0px';
    const sh = domainInput.scrollHeight; // includes padding
    const needed = sh + borderTop + borderBot;
    const next = Math.min(needed, maxPx);

    domainInput.style.height = `${next}px`;
    domainInput.style.overflowY = needed > maxPx ? 'auto' : 'hidden';
  } catch {}
}

// Blacklist UI elements
const addBlacklistForm = document.getElementById('add-blacklist-form');
const blacklistInput = document.getElementById('blacklist-input');
const blacklistList = document.getElementById('blacklist-list');

function autosizeBlacklistInput() {
  if (!blacklistInput) return;
  try {
    const cs = window.getComputedStyle(blacklistInput);
    const lh = parseFloat(cs.lineHeight) || 20;
    const padTop = parseFloat(cs.paddingTop || '0');
    const padBot = parseFloat(cs.paddingBottom || '0');
    const borderTop = parseFloat(cs.borderTopWidth || '0');
    const borderBot = parseFloat(cs.borderBottomWidth || '0');
    const maxPx = Math.round(lh * 10 + padTop + padBot + borderTop + borderBot);
    blacklistInput.style.height = '0px';
    const sh = blacklistInput.scrollHeight;
    const needed = sh + borderTop + borderBot;
    const next = Math.min(needed, maxPx);
    blacklistInput.style.height = `${next}px`;
    blacklistInput.style.overflowY = needed > maxPx ? 'auto' : 'hidden';
  } catch {}
}

function parseBlacklistTerms(raw) {
  try {
    const s = String(raw || '');
    const out = [];
    const norm = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    // Match quoted phrases or bare tokens; supports "...", '...'
    const re = /"([^"]+)"|'([^']+)'|([^\s,\n]+)/g;
    let m;
    while ((m = re.exec(norm)) !== null) {
      const term = (m[1] || m[2] || m[3] || '').trim();
      if (term) out.push(term);
    }
    return out;
  } catch {
    return [];
  }
}

function renderBlacklist() {
  if (!blacklistList) return;
  const list = loadBlacklist();
  const raw = String(blacklistInput?.value || '');
  const parts = parseBlacklistTerms(raw).map((t) => t.toLowerCase());
  const q = (parts[parts.length - 1] || '').trim();

  // Preserve insertion order
  const recencyIndex = new Map(list.map((it, i) => [it.term.toLowerCase(), i]));

  let entries = [];
  if (!q) {
    entries = list
      .map((it) => ({ item: it, order: recencyIndex.get(it.term.toLowerCase()) || 0 }))
      .sort((a, b) => b.order - a.order);
  } else {
    entries = list
      .filter((it) => it.term.toLowerCase().includes(q))
      .map((it) => ({ item: it, order: recencyIndex.get(it.term.toLowerCase()) || 0 }))
      .sort((a, b) => b.order - a.order);
  }

  blacklistList.innerHTML = '';
  if (entries.length === 0) {
    const li = document.createElement('li');
    if (list.length === 0 && !q) {
      li.textContent = 'No terms added yet.';
    } else {
      li.textContent = 'No matching terms.';
    }
    blacklistList.appendChild(li);
  } else {
    entries.forEach(({ item }) => {
      const li = document.createElement('li');
      li.tabIndex = 0;

      const left = document.createElement('span');
      left.className = 'domain';
      left.textContent = item.term;

      const right = document.createElement('span');
      right.className = 'right';
      const remaining = (item.activateAt || 0) - Date.now();
      if (remaining > 0) {
        const cd = document.createElement('span');
        cd.className = 'countdown';
        cd.textContent = fmtRemaining(remaining);
        right.appendChild(cd);
      }

      const btn = document.createElement('button');
      btn.className = 'remove';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const next = loadBlacklist().filter((d) => d.term !== item.term);
        await saveBlacklist(next);
        renderBlacklist();
      });
      right.appendChild(btn);

      li.appendChild(left);
      li.appendChild(right);
      blacklistList.appendChild(li);
    });
  }
}

function renderWhitelist() {
  if (!domainList) return;
  const list = loadWhitelist();
  const raw = String(domainInput?.value || '');
  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const q = (parts[parts.length - 1] || '').toLowerCase();

  // Recency: higher index in list means more recently added (we persist in insertion order)
  const recencyIndex = new Map(list.map((it, i) => [it.domain, i]));
  const sortMode = cachedSortMode;

  // Build entries with optional fuzzy scoring
  let entries = [];
  if (!q) {
    entries = list
      .map((it) => ({ item: it, matches: [], score: 0, order: recencyIndex.get(it.domain) || 0 }))
      .sort((a, b) => sortMode === 'abc'
        ? String(a.item.domain).localeCompare(String(b.item.domain))
        : (b.order - a.order));
  } else {
    entries = list
      .map((it) => {
        const m = fuzzyMatch(q, it.domain);
        if (m.score < 0) return null;
        return { item: it, matches: m.indices, score: m.score, order: recencyIndex.get(it.domain) || 0 };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const byScore = b.score - a.score;
        if (byScore !== 0) return byScore;
        return sortMode === 'abc'
          ? String(a.item.domain).localeCompare(String(b.item.domain))
          : (b.order - a.order);
      });
  }

  domainList.innerHTML = '';
  if (entries.length === 0) {
    const li = document.createElement('li');
    if (list.length === 0 && !q) {
      li.textContent = 'No domains added yet.';
    } else {
      li.textContent = 'No matching domains.';
    }
    domainList.appendChild(li);
  } else {
    // Track current view order for shift-range selection
    wlViewDomains = entries.map((e) => e.item.domain);
    entries.forEach(({ item, matches }, idx) => {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.dataset.domain = item.domain;
      li.dataset.index = String(idx);

      const left = document.createElement('span');
      left.className = 'domain';
      // Highlight fuzzy matches similar to address suggestions
      left.appendChild(renderHighlightedText(String(item.domain), matches));

      const right = document.createElement('span');
      right.className = 'right';
      const remaining = (item.activateAt || 0) - Date.now();
      if (remaining > 0) {
        const cd = document.createElement('span');
        cd.className = 'countdown';
        cd.textContent = fmtRemaining(remaining);
        right.appendChild(cd);
      }

      // Removal rules red badge (per domain)
      const removalBadge = document.createElement('span');
      removalBadge.className = 'removal-badge hidden';
      removalBadge.textContent = '0';
      removalBadge.title = 'Removed elements — click to restore';
      removalBadge.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const domain = getRegistrableDomain(item.domain) || item.domain;
          const now = Date.now();
          const existing = await getDomainRemovalRules(domain);
          const cnt = Array.isArray(existing) ? existing.length : 0;
          if (cnt <= 0) return;
          const pendingAt = await getRemovalPendingAt(domain);
          if (pendingAt && pendingAt > now) {
            await clearScheduledRemovalForDomain(domain);
            removalBadge.classList.remove('pending');
            showBanner('Removal canceled', '', 2200);
          } else {
            const delayMin = getDelayMinutes();
            if (delayMin <= 0) {
              await clearDomainRemovalRulesImmediate(domain);
            } else {
              const activateAt = now + delayMin * 60 * 1000;
              await scheduleRemovalForDomain(domain, activateAt);
              removalBadge.classList.add('pending');
              const label = fmtRemaining(Math.max(0, activateAt - now)) || `${delayMin}:00`;
              showBanner(`In ${label} the deletion rules will be removed`, '', 4000);
            }
          }
        } catch {}
        try { updateRemovalCountBubble(); } catch {}
        renderWhitelist();
      });
      right.appendChild(removalBadge);

      const btn = document.createElement('button');
      btn.className = 'remove';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const next = loadWhitelist().filter((d) => d.domain !== item.domain);
        await saveWhitelist(next);
        wlSelectedDomains.delete(item.domain);
        renderWhitelist();
      });
      right.appendChild(btn);

      if (wlSelectedDomains.has(item.domain)) li.classList.add('selected');

      li.addEventListener('click', (e) => {
        const shift = !!e.shiftKey;
        const cmd = !!e.metaKey || !!e.ctrlKey; // Command on Mac, Ctrl on Windows/Linux
        
        if (cmd) {
          // Command+click: navigate to this domain
          e.preventDefault();
          e.stopPropagation();
          try {
            const url = normalizeToURL(item.domain);
            if (url && input) {
              input.value = item.domain;
              navigate({ shiftKey: shift });
            }
          } catch {}
          return;
        }
        
        if (shift && wlAnchorIndex != null) {
          const [a, b] = [wlAnchorIndex, idx].sort((x, y) => x - y);
          wlSelectedDomains = new Set();
          for (let i = a; i <= b; i++) wlSelectedDomains.add(wlViewDomains[i]);
        } else {
          wlSelectedDomains = new Set([item.domain]);
          wlAnchorIndex = idx;
        }
        // Focus the clicked item so Backspace works even if textarea was focused
        try { li.focus(); } catch {}
        renderWhitelist();
      });

      li.appendChild(left);
      li.appendChild(right);
      domainList.appendChild(li);

      // Async update for removal badge count
      (async () => {
        try {
          const domain = getRegistrableDomain(item.domain) || item.domain;
          const rules = await getDomainRemovalRules(domain);
          const c = Array.isArray(rules) ? rules.length : 0;
          if (c > 0) {
            removalBadge.textContent = String(c);
            removalBadge.classList.remove('hidden');
            removalBadge.title = `Removed elements on ${domain} — click to restore`;
          } else {
            removalBadge.classList.add('hidden');
          }
          // Mark pending state
          const at = await getRemovalPendingAt(domain);
          if (at && at > Date.now()) {
            removalBadge.classList.add('pending');
            removalBadge.title = `Removing in ${fmtRemaining(Math.max(0, at - Date.now()))}`;
          } else {
            removalBadge.classList.remove('pending');
          }
        } catch {}
      })();
    });
  }

  // Countdown interval is managed by settings open/close.
}

if (addDomainForm) {
  addDomainForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = String(domainInput.value || '');
    const tokens = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
      showBanner('Enter a valid domain (e.g., example.com)', 'error');
      return;
    }
    const wl = loadWhitelist();
    const existing = new Set(wl.map((it) => it.domain));
    const toAdd = [];
    const seen = new Set();
    for (const t of tokens) {
      const host = extractHostname(t);
      if (!host) continue;
      if (existing.has(host) || seen.has(host)) continue;
      seen.add(host);
      toAdd.push(host);
    }
    if (toAdd.length === 0) {
      showBanner('No new domains to add');
      return;
    }
    const delayMin = getDelayMinutes();
    const now = Date.now();
    for (const host of toAdd) {
      const activateAt = delayMin > 0 ? now + delayMin * 60 * 1000 : 0;
      wl.push({ domain: host, activateAt });
    }
    await saveWhitelist(wl);
    renderWhitelist();
    if (delayMin > 0) {
      showBanner(`Added ${toAdd.length} domain(s). Activates in ${delayMin} min`);
    } else {
      showBanner(`Added ${toAdd.length} domain(s) to whitelist`);
    }
    domainInput.value = '';
    try { autosizeDomainInput(); } catch {}
  });
}

// Filter and auto-size as the user types
if (domainInput) {
  domainInput.addEventListener('input', () => {
    try { autosizeDomainInput(); } catch {}
    renderWhitelist();
  });
  // Normalize paste to preserve lines and convert separators into newlines
  domainInput.addEventListener('paste', (e) => {
    try {
      const dt = e.clipboardData || window.clipboardData;
      const text = dt?.getData('text');
      if (!text) return;
      e.preventDefault();
      const start = domainInput.selectionStart ?? domainInput.value.length;
      const end = domainInput.selectionEnd ?? start;
      const norm = String(text).replace(/\r\n?/g, '\n');
      const tokens = norm.split(/[\s,]+/).filter(Boolean);
      const insert = tokens.join('\n');
      const before = domainInput.value.slice(0, start);
      const after = domainInput.value.slice(end);
      domainInput.value = before + insert + after;
      const pos = before.length + insert.length;
      domainInput.setSelectionRange?.(pos, pos);
      autosizeDomainInput();
      renderWhitelist();
    } catch {}
  });
}

// Blacklist: submit handler
if (addBlacklistForm) {
  addBlacklistForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = String(blacklistInput?.value || '');
    const tokens = parseBlacklistTerms(raw).map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
      showBanner('Enter a term or "phrase" to blacklist', 'error');
      return;
    }
    const bl = loadBlacklist();
    const existing = new Set(bl.map((it) => it.term.toLowerCase()));
    const toAdd = [];
    const seen = new Set();
    for (const t of tokens) {
      const key = t.toLowerCase();
      if (!key) continue;
      if (existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      toAdd.push(t);
    }
    if (toAdd.length === 0) {
      showBanner('No new terms to add');
      return;
    }
    const delayMin = getDelayMinutes();
    const now = Date.now();
    for (const term of toAdd) {
      const activateAt = delayMin > 0 ? now + delayMin * 60 * 1000 : 0;
      bl.push({ term, activateAt });
    }
    await saveBlacklist(bl);
    renderBlacklist();
    if (delayMin > 0) {
      showBanner(`Added ${toAdd.length} term(s). Activates in ${delayMin} min`);
    } else {
      showBanner(`Added ${toAdd.length} term(s) to blacklist`);
    }
    if (blacklistInput) {
      blacklistInput.value = '';
      try { autosizeBlacklistInput(); } catch {}
    }
  });
}

// Blacklist input behaviors
if (blacklistInput) {
  blacklistInput.addEventListener('input', () => {
    try { autosizeBlacklistInput(); } catch {}
    renderBlacklist();
  });
  blacklistInput.addEventListener('paste', (e) => {
    try {
      const dt = e.clipboardData || window.clipboardData;
      const text = dt?.getData('text');
      if (!text) return;
      // Let parseBlacklistTerms handle quotes; normalize newlines and commas to spaces
      e.preventDefault();
      const start = blacklistInput.selectionStart ?? blacklistInput.value.length;
      const end = blacklistInput.selectionEnd ?? start;
      const norm = String(text).replace(/\r\n?/g, '\n');
      const tokens = parseBlacklistTerms(norm);
      const insert = tokens.join('\n');
      const before = blacklistInput.value.slice(0, start);
      const after = blacklistInput.value.slice(end);
      blacklistInput.value = before + insert + after;
      const pos = before.length + insert.length;
      blacklistInput.setSelectionRange?.(pos, pos);
      autosizeBlacklistInput();
      renderBlacklist();
    } catch {}
  });
}

settingsBtn?.addEventListener('click', () => {
  const isHidden = !settingsView || settingsView.classList.contains('hidden');
  if (isHidden) {
    setSettingsVisible(true);
    // Initialize sort toggle from storage
    try {
      if (sortToggle) {
        const isRecent = cachedSortMode === 'recent';
        sortToggle.setAttribute('aria-pressed', String(isRecent));
        const t = sortToggle.querySelector('.sort-text');
        if (t) t.textContent = isRecent ? 'recent' : 'abc';
      }
    } catch {}
    // Default to whitelist tab when opening settings
    switchToTab('whitelist');
    renderWhitelist();
    initDelayControls?.();
    startCountdown();
    try { autosizeDomainInput(); } catch {}
    try { autosizeBlacklistInput(); } catch {}
  } else {
    // Same effect as clicking the Settings back button
    setSettingsVisible(false);
    stopCountdown();
    clearWhitelistSelection();
  }
});

// Backspace/Delete removes selected whitelist items while settings are visible
(function setupDeleteShortcut() {
  async function handler(e) {
    if (!(e.key === 'Backspace' || e.key === 'Delete')) return;
    // Only when settings view is visible
    if (!settingsView || settingsView.classList.contains('hidden')) return;
    const active = document.activeElement;
    if (isFocusableInput(active)) return;
    if (wlSelectedDomains.size === 0) return;
    e.preventDefault();
    const toDelete = new Set(wlSelectedDomains);
    const next = loadWhitelist().filter((d) => !toDelete.has(d.domain));
    await saveWhitelist(next);
    clearWhitelistSelection();
    renderWhitelist();
  }
  document.addEventListener('keydown', handler, true);
})();

// Element selection mode: Cmd/Ctrl+N toggles a hover highlighter inside the page
let elementSelectMode = false;
const ELEMENT_SELECT_COLOR = '#4f7cff'; // brand accent from styles.css
let elementSelectPollTimer = null;

// Domain removal rules storage helpers (persist + local fallback)
async function getDomainRemovalRules(domain) {
  try {
    const key = `removeRules:${domain}`;
    // Prefer safeGetItem which also consults localStorage
    let raw = await safeGetItem?.(key);
    if (raw && typeof raw === 'string') {
      try { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; } catch {}
    }
    // Migration: older entries may be stored directly via window.storage as an array
    const direct = await window.storage?.get?.(key);
    if (Array.isArray(direct)) {
      try { await safeSetItem?.(key, JSON.stringify(direct)); } catch {}
      return direct;
    }
    if (typeof direct === 'string') {
      try { const arr = JSON.parse(direct); if (Array.isArray(arr)) return arr; } catch {}
    }
  } catch {}
  return [];
}

async function setDomainRemovalRules(domain, rules) {
  try {
    const key = `removeRules:${domain}`;
    const payload = JSON.stringify(Array.isArray(rules) ? rules : []);
    await safeSetItem?.(key, payload);
  } catch {}
}

// Pending deletion of rules per domain
const REMOVE_PENDING_KEY = 'removeRules_pending_map';
async function getRemovalPendingMap() {
  try {
    const raw = await safeGetItem?.(REMOVE_PENDING_KEY);
    if (raw) {
      try { const obj = JSON.parse(raw); if (obj && typeof obj === 'object') return obj; } catch {}
    }
  } catch {}
  return {};
}
async function setRemovalPendingMap(map) {
  try { await safeSetItem?.(REMOVE_PENDING_KEY, JSON.stringify(map || {})); } catch {}
}
async function getRemovalPendingAt(domain) {
  try { const m = await getRemovalPendingMap(); const t = Number(m[domain] || 0); return Number.isFinite(t) ? t : 0; } catch { return 0; }
}
async function scheduleRemovalForDomain(domain, activateAt) {
  try { const m = await getRemovalPendingMap(); m[domain] = activateAt; await setRemovalPendingMap(m); } catch {}
}
async function clearScheduledRemovalForDomain(domain) {
  try { const m = await getRemovalPendingMap(); delete m[domain]; await setRemovalPendingMap(m); } catch {}
}

let removalPendingInterval = null;
function startRemovalPendingTimer() {
  if (removalPendingInterval) return;
  removalPendingInterval = setInterval(async () => {
    try {
      const m = await getRemovalPendingMap();
      const now = Date.now();
      let changed = false;
      for (const [domain, at] of Object.entries(m)) {
        const ts = Number(at || 0);
        if (ts && now >= ts) {
          await clearDomainRemovalRulesImmediate(domain, { silent: false });
          delete m[domain];
          changed = true;
        }
      }
      if (changed) {
        await setRemovalPendingMap(m);
      }
      // Always refresh tooltips/countdowns
      try { updateRemovalCountBubble(); } catch {}
      if (settingsView && !settingsView.classList.contains('hidden')) renderWhitelist();
    } catch {}
  }, 1000);
}

async function clearDomainRemovalRulesImmediate(domain, { silent = false } = {}) {
  try {
    await setDomainRemovalRules(domain, []);
    for (const w of getAllWebViews()) {
      try {
        const u = w?.getURL?.() || '';
        if (!u) continue;
        const h = new URL(u).hostname.toLowerCase();
        const d = getRegistrableDomain(h) || h;
        if (d !== domain) continue;
        await w.executeJavaScript(`(() => { try { const k='__FB_REMOVE_RULES__'; const s=window[k]; if (s && s.observer && s.observer.disconnect) s.observer.disconnect(); window[k]=null; } catch {} return true; })();`, true).catch(() => {});
        w.reload?.();
      } catch {}
    }
    if (!silent) showBanner(`Restored removed elements for ${domain}`, '', 2600);
  } catch {}
}

// Update the red removal rules bubble based on current domain
async function updateRemovalCountBubble() {
  try {
    if (!removalCountBubble) return;
    // While settings are visible, hide bubble entirely
    if (settingsView && !settingsView.classList.contains('hidden')) { removalCountBubble.classList.add('hidden'); return; }
    const v = getVisibleWebView();
    const url = v?.getURL?.() || '';
    if (!url || url === 'about:blank') { removalCountBubble.classList.add('hidden'); return; }
    const host = new URL(url).hostname.toLowerCase();
    const domain = getRegistrableDomain(host) || host;
    const rules = await getDomainRemovalRules(domain);
    const count = Array.isArray(rules) ? rules.length : 0;
    if (count > 0) {
      removalCountBubble.textContent = String(count);
      const at = await getRemovalPendingAt(domain);
      if (at && at > Date.now()) {
        removalCountBubble.classList.add('pending');
        removalCountBubble.title = `Removing in ${fmtRemaining(Math.max(0, at - Date.now()))}`;
      } else {
        removalCountBubble.classList.remove('pending');
        removalCountBubble.title = `Removed elements on ${domain} — click to restore`;
      }
      removalCountBubble.classList.remove('hidden');
    } else {
      removalCountBubble.classList.add('hidden');
    }
  } catch { try { removalCountBubble?.classList?.add?.('hidden'); } catch {} }
}

// Click handler: clear rules for current domain and reload matching views to restore elements
removalCountBubble?.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const v = getVisibleWebView();
    const url = v?.getURL?.() || '';
    if (!url || url === 'about:blank') return;
    const host = new URL(url).hostname.toLowerCase();
    const domain = getRegistrableDomain(host) || host;
    const now = Date.now();
    const pendingAt = await getRemovalPendingAt(domain);
    const rules = await getDomainRemovalRules(domain);
    const count = Array.isArray(rules) ? rules.length : 0;
    if (count <= 0) return;
    // Toggle: if already pending, cancel
    if (pendingAt && pendingAt > now) {
      await clearScheduledRemovalForDomain(domain);
      removalCountBubble.classList.remove('pending');
      showBanner('Removal canceled', '', 2200);
      updateRemovalCountBubble();
      return;
    }
    const delayMin = getDelayMinutes();
    if (delayMin <= 0) {
      await clearDomainRemovalRulesImmediate(domain);
    } else {
      const activateAt = Date.now() + delayMin * 60 * 1000;
      await scheduleRemovalForDomain(domain, activateAt);
      removalCountBubble.classList.add('pending');
      const label = fmtRemaining(Math.max(0, activateAt - Date.now())) || `${delayMin}:00`;
      showBanner(`In ${label} the deletion rules will be removed`, '', 4000);
    }
  } catch {}
  updateRemovalCountBubble();
});

function getAllWebViews() {
  try { return Array.from(document.querySelectorAll('webview')); } catch { return []; }
}

// getVisibleWebView is defined later in the file; rely on that definition

// Check if the site already has dark mode styles
async function checkSiteHasDarkMode(view) {
  try {
    if (!view || typeof view.executeJavaScript !== 'function') return false;
    
    const js = `(() => {
      try {
        // Check common dark mode indicators
        const html = document.documentElement || document.body;
        const body = document.body;
        
        // Get computed styles for body and html
        const htmlStyle = getComputedStyle(html);
        const bodyStyle = body ? getComputedStyle(body) : htmlStyle;
        
        // Check background colors (dark if closer to black than white)
        function isDarkColor(color) {
          if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return false;
          
          // Parse RGB/RGBA values
          const match = color.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
          if (!match) return false;
          
          const r = parseInt(match[1]);
          const g = parseInt(match[2]);  
          const b = parseInt(match[3]);
          
          // Calculate luminance (closer to 0 = darker)
          const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          return luminance < 0.5; // Dark if luminance less than 50%
        }
        
        // Check HTML and body background colors
        const htmlBg = htmlStyle.backgroundColor;
        const bodyBg = bodyStyle.backgroundColor;
        
        if (isDarkColor(htmlBg) || isDarkColor(bodyBg)) {
          return true;
        }
        
        // Check for dark mode class names
        const classList = html.className + ' ' + (body ? body.className : '');
        const darkModeKeywords = ['dark', 'dark-mode', 'dark-theme', 'night', 'night-mode'];
        const hasDarkClass = darkModeKeywords.some(keyword => 
          classList.toLowerCase().includes(keyword)
        );
        
        if (hasDarkClass) return true;
        
        // Check for CSS custom properties that indicate dark mode
        const htmlCustomProps = htmlStyle.getPropertyValue('--background-color') || 
                               htmlStyle.getPropertyValue('--bg-color') ||
                               htmlStyle.getPropertyValue('--background') ||
                               htmlStyle.getPropertyValue('--color-background');
        
        if (htmlCustomProps && isDarkColor(htmlCustomProps)) return true;
        
        // Check color scheme preference
        const colorScheme = htmlStyle.colorScheme || bodyStyle.colorScheme;
        if (colorScheme && colorScheme.includes('dark')) return true;
        
        // Check for meta theme-color (often dark on dark sites)
        const metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (metaThemeColor) {
          const themeColor = metaThemeColor.getAttribute('content');
          if (themeColor && isDarkColor(themeColor)) return true;
        }
        
        return false;
      } catch (e) {
        return false;
      }
    })();`;
    
    const result = await view.executeJavaScript(js, true).catch(() => false);
    return !!result;
  } catch {
    return false;
  }
}

// Apply/remove dark mode CSS inside a webview
async function setWebViewDarkMode(view, enable) {
  try {
    if (!view) return;
    
    // If enabling dark mode, first check if the site already has dark mode
    if (enable) {
      const hasDarkMode = await checkSiteHasDarkMode(view);
      if (hasDarkMode) {
        try { debugLog('dark-mode skipped - site already dark', { id: viewId(view) }); } catch {}
        return;
      }
    }
    
    const cssText = 'html { filter: invert(1) hue-rotate(180deg) !important; background: #eee !important; }\n'
                 + 'img, picture, video, canvas, iframe, svg, [style*="background-image"] { filter: invert(1) hue-rotate(180deg) !important; }\n'
                 + 'body { background: #eee !important; }\n'
                 + '/* Ensure outer viewport areas that might be transparent get a light background that inverts to dark */\n'
                 + 'html::before { content: ""; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: #eee !important; z-index: -999999; pointer-events: none; }';

    // Prefer insertCSS (CSP-friendly), fall back to DOM injection
    if (enable) {
      let inserted = false;
      if (typeof view.insertCSS === 'function') {
        try {
          const key = await view.insertCSS(cssText);
          view._darkCSSKey = (typeof key === 'string') ? key : null;
          inserted = true;
          try { debugLog('dark-mode insertCSS applied', { id: viewId(view) }); } catch {}
        } catch {}
      }
      if (!inserted && typeof view.executeJavaScript === 'function') {
        const js = `(() => { try {
      const WANT = ${enable ? 'true' : 'false'};
      const KEY = '__FB_DARK_MODE__';
      const ID = '__fb_dark_mode_css__';
      const g = window;
      // Cleanup previous
      try { const prev = g[KEY]; if (prev && prev.observer && prev.observer.disconnect) prev.observer.disconnect(); } catch {}
      if (!WANT) {
        try { const el = document.getElementById(ID); if (el && el.parentNode) el.parentNode.removeChild(el); } catch {}
        g[KEY] = { enabled:false };
        return 'disabled';
      }
      const css = ${JSON.stringify(cssText)};
      let styleEl = document.getElementById(ID);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = ID;
        styleEl.type = 'text/css';
        styleEl.appendChild(document.createTextNode(css));
        (document.head || document.documentElement || document.body).appendChild(styleEl);
      } else {
        styleEl.textContent = css;
      }
      let obs = null;
      try {
        obs = new MutationObserver(() => {
          try {
            if (!document.getElementById(ID)) {
              const s = document.createElement('style');
              s.id = ID;
              s.type = 'text/css';
              s.textContent = css;
              (document.head || document.documentElement || document.body).appendChild(s);
            }
          } catch {}
        });
        obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
      } catch {}
      g[KEY] = { enabled: true, styleEl, observer: obs };
      return 'enabled';
    } catch (e) { return 'error:' + (e && e.message || '') } })();`;
        const res = await view.executeJavaScript(js, true).catch(() => null);
        try { debugLog('dark-mode execJS applied', { id: viewId(view), res }); } catch {}
      }
    } else {
      // Disable: remove insertCSS if present, and clean any DOM style
      if (typeof view.removeInsertedCSS === 'function' && typeof view._darkCSSKey === 'string' && view._darkCSSKey) {
        try { await view.removeInsertedCSS(view._darkCSSKey); } catch {}
        view._darkCSSKey = null;
        try { debugLog('dark-mode insertCSS removed', { id: viewId(view) }); } catch {}
      }
      if (typeof view.executeJavaScript === 'function') {
        const js = `(() => { try {
          const ID='__fb_dark_mode_css__';
          const el = document.getElementById(ID);
          if (el && el.parentNode) el.parentNode.removeChild(el);
          const KEY='__FB_DARK_MODE__';
          try { const prev = window[KEY]; if (prev && prev.observer && prev.observer.disconnect) prev.observer.disconnect(); } catch {}
          return 'removed';
        } catch { return 'noop'; } })();`;
        const res = await view.executeJavaScript(js, true).catch(() => null);
        try { debugLog('dark-mode execJS removed', { id: viewId(view), res }); } catch {}
      }
    }
  } catch {}
}

async function applyDarkModeToAllWebViews(enable) {
  try {
    const views = getAllWebViews();
    try { debugLog('dark-mode apply all', { enable, count: views.length }); } catch {}
    for (const v of views) {
      try { await setWebViewDarkMode(v, enable); } catch {}
    }
  } catch {}
}

async function setWebViewHoverHighlighter(view, enable) {
  try {
    if (!view || typeof view.executeJavaScript !== 'function') return;
    const code = `(() => { try {
      const enable = ${enable ? 'true' : 'false'};
      const KEY = '__FB_HOVER_HIGHLIGHT__';
      const g = window;
      function cleanup() {
        try {
          const st = g[KEY];
          if (!st) return;
          try {
            const clsName = st.cls || '__fb_hh_target__';
            const all = document.querySelectorAll('.' + clsName);
            for (const n of all) n.classList.remove(clsName);
          } catch {}
          if (st.styleEl && st.styleEl.parentNode) st.styleEl.parentNode.removeChild(st.styleEl);
          if (st.onMove) document.removeEventListener('mousemove', st.onMove, true);
          if (st.onLeave) document.removeEventListener('mouseleave', st.onLeave, true);
          if (st.onBlur) g.removeEventListener('blur', st.onBlur, true);
          if (st.onScroll) g.removeEventListener('scroll', st.onScroll, true);
          if (st.onResize) g.removeEventListener('resize', st.onResize, true);
          if (st.onClick) document.removeEventListener('click', st.onClick, true);
          g[KEY] = null;
        } catch {}
      }
      if (!enable) { cleanup(); return 'disabled'; }
      cleanup();
      const styleEl = document.createElement('style');
      const cls = '__fb_hh_target__';
      styleEl.textContent = '.' + cls + '{outline:2px solid ${ELEMENT_SELECT_COLOR} !important; outline-offset:-2px !important; cursor: crosshair !important;}';
      (document.head || document.documentElement || document.body).appendChild(styleEl);
      let last = null, lastX = 0, lastY = 0;
      const ce = (s) => {
        try { return (window.CSS && window.CSS.escape) ? window.CSS.escape(String(s)) : String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1'); } catch { return String(s); }
      };
      const looksHashed = (s) => /[a-f0-9]{6,}/i.test(s) || /\d{4,}/.test(s);
      const stableClasses = (el) => Array
        .from(el.classList || [])
        .filter(c => c && c.length <= 32 && !looksHashed(c) && c !== '__fb_hh_target__')
        .slice(0,3);
      const tokenFor = (el) => {
        try {
          if (!el || !el.tagName) return null;
          // Prefer ID if present
          if (el.id && el.id.length < 128 && !looksHashed(el.id)) return '#' + ce(el.id);
          const tag = String(el.tagName || '').toLowerCase();
          // Useful attributes
          const role = el.getAttribute && el.getAttribute('role');
          const aria = el.getAttribute && el.getAttribute('aria-label');
          const dtid = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-component'));
          if (role) return tag + '[role="' + ce(role) + '"]';
          if (aria && aria.length <= 64) return tag + '[aria-label="' + ce(aria) + '"]';
          if (dtid) return tag + '[data-testid="' + ce(dtid) + '"]';
          const classes = stableClasses(el);
          if (classes.length) return tag + classes.map(c => '.' + ce(c)).join('');
          return tag;
        } catch { return null; }
      };
      const buildSelector = (el) => {
        try {
          if (!el) return null;
          const parts = [];
          let cur = el;
          let depth = 0;
          while (cur && depth < 4) {
            const tok = tokenFor(cur);
            if (!tok) break;
            // If token starts with #, use it as an anchor and stop climbing further
            parts.unshift(tok);
            if (tok[0] === '#') break;
            cur = cur.parentElement;
            depth++;
          }
          if (!parts.length) return null;
          // If the last token is just a bare tag (too generic), try to specialize with :nth-of-type
          const lastTok = parts[parts.length - 1];
          if (!lastTok || (lastTok && /^[a-z0-9-]+$/.test(lastTok))) {
            try {
              const p = el.parentElement;
              if (p) {
                const tag = el.tagName.toLowerCase();
                const sibs = Array.from(p.children).filter((ch) => (ch.tagName || '').toLowerCase() === tag);
                const idx = sibs.indexOf(el);
                if (idx >= 0) parts[parts.length - 1] = (lastTok || tag) + ':nth-of-type(' + (idx + 1) + ')';
              }
            } catch {}
          }
          return parts.join(' > ');
        } catch { return null; }
      };
      const textSignature = (el) => {
        try {
          const tag = String(el?.tagName || '').toLowerCase();
          let txt = String(el?.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt.length > 140) txt = txt.slice(0, 140);
          if (!txt) return null;
          return { kind: 'text', tag, text: txt.toLowerCase() };
        } catch { return null; }
      };
      // Buffer for newly created deletion signatures consumed by host app
      const sigs = [];
      const pick = () => {
        try {
          const el = document.elementFromPoint(lastX, lastY);
          if (!el) { if (last) { last.classList.remove(cls); last = null; } return; }
          if (el === last) return;
          if (last) last.classList.remove(cls);
          last = el;
          last.classList.add(cls);
        } catch {}
      };
      const onMove = (e) => { lastX = e.clientX; lastY = e.clientY; pick(); };
      const onLeave = () => { if (last) last.classList.remove(cls); last = null; };
      const onBlur = () => { if (last) last.classList.remove(cls); last = null; };
      const onScroll = () => { pick(); };
      const onResize = () => { pick(); };
      const onClick = (e) => {
        try {
          // Prevent page from handling this click
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation?.();
          const el = document.elementFromPoint(e.clientX, e.clientY) || e.target;
          if (!el) return;
          // Do not remove <html> or <body>
          if (el === document.documentElement || el === document.body) return;
          // Compute a stable signature: prefer CSS, else fall back to text
          const sel = buildSelector(el);
          if (sel) {
            sigs.push({ kind: 'css', selector: sel });
          } else {
            const ts = textSignature(el);
            if (ts) sigs.push(ts);
          }
          // If our highlight was on another element, clear its class
          if (last && last !== el) { try { last.classList.remove(cls); } catch {} }
          try { el.remove(); } catch {}
          // After removal, clear highlight and recalc target under pointer
          last = null; pick();
        } catch {}
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseleave', onLeave, true);
      g.addEventListener('blur', onBlur, true);
      g.addEventListener('scroll', onScroll, true);
      g.addEventListener('resize', onResize, true);
      document.addEventListener('click', onClick, true);
      g[KEY] = { styleEl, cls, onMove, onLeave, onBlur, onScroll, onResize, onClick, sigs };
      return 'enabled';
    } catch (e) { return 'error:' + (e && e.message || '') } })();`;
    await view.executeJavaScript(code, true).catch(() => {});
  } catch {}
}

async function fetchAndPersistDeletionSigs(view) {
  try {
    if (!view || typeof view.executeJavaScript !== 'function') return;
    const res = await view.executeJavaScript(`(() => { try {
      const st = window.__FB_HOVER_HIGHLIGHT__;
      const host = location.hostname || '';
      const out = Array.isArray(st?.sigs) ? st.sigs.slice() : [];
      if (Array.isArray(st?.sigs)) st.sigs.length = 0;
      return { host, sigs: out };
    } catch { return { host: '', sigs: [] }; } })();`, true).catch(() => null);
    if (!res || !Array.isArray(res.sigs) || !res.sigs.length) return;
    const rawHost = String(res.host || '').toLowerCase();
    const domain = getRegistrableDomain(rawHost) || rawHost;
    if (!domain) return;
    const cur = await getDomainRemovalRules(domain);
    const normalize = (r) => {
      if (!r) return null;
      if (typeof r === 'string') return { kind: 'css', selector: r };
      if (typeof r === 'object' && r.kind) return r;
      return null;
    };
    const now = Array.isArray(cur) ? cur.map(normalize).filter(Boolean) : [];
    const seen = new Set(now.map((r) => JSON.stringify(r)));
    let added = 0;
    for (const s of res.sigs) {
      const n = normalize(s);
      if (!n) continue;
      const keyStr = JSON.stringify(n);
      if (!seen.has(keyStr)) { seen.add(keyStr); now.push(n); added++; }
    }
    if (added > 0) {
      debugLog('persist-removal', { domain, added, total: now.length });
      const arr = now;
      await setDomainRemovalRules(domain, arr);
      // Apply immediately to all matching views
      for (const v of getAllWebViews()) {
        try {
          const url = viewURL(v);
          if (!url) continue;
          const h = new URL(url).hostname.toLowerCase();
          const d = getRegistrableDomain(h) || h;
          if (d === domain) await setWebViewDomainRemovalRules(v, arr);
        } catch {}
      }
      showBanner('Element removed. Will hide similar on this domain.', '', 2800);
      try { updateRemovalCountBubble(); } catch {}
    }
  } catch {}
}

async function setWebViewDomainRemovalRules(view, selectors) {
  try {
    if (!view || typeof view.executeJavaScript !== 'function') return;
    const payload = JSON.stringify(Array.isArray(selectors) ? selectors : []);
    const js = `(() => { try {
      const KEY='__FB_REMOVE_RULES__';
      const g=window;
      try { const prev=g[KEY]; if (prev && prev.observer && prev.observer.disconnect) prev.observer.disconnect(); } catch {}
      const rules = ${payload};
      const cssSelectors = [];
      const textRules = [];
      for (let r of (rules||[])) {
        if (!r) continue;
        if (typeof r === 'string') {
          // Sanitize out our transient highlight class
          try { r = r.replace(/\.__fb_hh_target__/g, ''); } catch {}
          cssSelectors.push(r);
        }
        else if (typeof r === 'object') {
          if (r.kind === 'css' && r.selector) {
            let s = String(r.selector);
            try { s = s.replace(/\.__fb_hh_target__/g, ''); } catch {}
            cssSelectors.push(s);
          }
          else if (r.kind === 'text' && r.text) textRules.push({ tag: (r.tag||'*'), text: String(r.text).toLowerCase() });
        }
      }
      let removed = 0;
      const removeNow = () => {
        try {
          // CSS selectors first
          for (const origSel of cssSelectors) {
            try {
              let sel = origSel;
              let nodes = document.querySelectorAll(sel);
              if (!nodes || nodes.length === 0) {
                // Degrade: drop :nth-of-type and class tokens
                try { sel = sel.replace(/:nth-of-type\(\d+\)/g, ''); } catch {}
                try { sel = sel.replace(/\.[_a-zA-Z0-9-]+/g, ''); } catch {}
                nodes = document.querySelectorAll(sel);
              }
              if ((!nodes || nodes.length === 0) && sel.includes('>')) {
                // Degrade further to last segment only (most specific part)
                try {
                  const last = sel.split('>').pop().trim();
                  if (last) nodes = document.querySelectorAll(last);
                } catch {}
              }
              for (const n of nodes) {
                if (n && n !== document.documentElement && n !== document.body && n.remove) { n.remove(); removed++; }
              }
            } catch {}
          }
          // Text-based rules
          for (const r of textRules) {
            try {
              const nodes = document.querySelectorAll(r.tag || '*');
              for (const n of nodes) {
                try {
                  const t = String(n.textContent || '').replace(/\s+/g,' ').trim().toLowerCase();
                  if (t && t.indexOf(r.text) !== -1) { if (n !== document.documentElement && n !== document.body && n.remove) { n.remove(); removed++; } }
                } catch {}
              }
            } catch {}
          }
        } catch {}
      };
      removeNow();
      let obs = null;
      try {
        obs = new MutationObserver(() => { removeNow(); });
        obs.observe(document.documentElement || document.body, { childList:true, subtree:true });
      } catch {}
      g[KEY] = { rules, observer: obs };
      return {
        rulesCount: (cssSelectors.length + textRules.length),
        removed,
        cssSelectorsLen: cssSelectors.length,
        textRulesLen: textRules.length,
        firstCss: cssSelectors.length ? cssSelectors[0] : null,
        firstText: textRules.length ? textRules[0] : null
      };
    } catch { return false; } })();`;
    const res = await view.executeJavaScript(js, true).catch(() => null);
    try {
      const url = viewURL(view) || '';
      const h = url ? new URL(url).hostname.toLowerCase() : '';
      const domain = h ? (getRegistrableDomain(h) || h) : '';
      debugLog('apply-removal-exec', { domain, stats: res || null });
    } catch {}
  } catch {}
}

async function applySelectionMode(en) {
  elementSelectMode = !!en;
  try {
    if (elementSelectMode) {
      const v = getVisibleWebView();
      await setWebViewHoverHighlighter(v, true);
      // Start polling for newly created deletion signatures from the page
      if (elementSelectPollTimer) { clearInterval(elementSelectPollTimer); elementSelectPollTimer = null; }
      elementSelectPollTimer = setInterval(() => { try { const vv = getVisibleWebView(); fetchAndPersistDeletionSigs(vv); } catch {} }, 600);
      // Show a one-time hint near the address bar
      try {
        const seen = await safeGetItem?.('seenElementSelectHint');
        if (!seen) {
          showBanner('Selection mode on — press Esc to exit', '', 4000);
          await safeSetItem?.('seenElementSelectHint', 'true');
        }
      } catch {}
    } else {
      const views = getAllWebViews();
      // Before disabling, flush any pending signatures immediately
      try { const v = getVisibleWebView(); await fetchAndPersistDeletionSigs(v); } catch {}
      await Promise.all(views.map((v) => setWebViewHoverHighlighter(v, false)));
      if (elementSelectPollTimer) { clearInterval(elementSelectPollTimer); elementSelectPollTimer = null; }
    }
  } catch {}
}

async function toggleElementSelectMode() {
  await applySelectionMode(!elementSelectMode);
}

// Cmd/Ctrl+Enter submits the Add Domain form while settings are visible
(function setupSubmitShortcut() {
  function handler(e) {
    if (!(e.key === 'Enter' && (e.metaKey || e.ctrlKey))) return;
    if (!settingsView || settingsView.classList.contains('hidden')) return;
    const active = document.activeElement;
    // Only trigger when focus is within settings (e.g., list or textarea)
    if (!settingsView.contains(active)) return;
    // If focused element is another input/textarea and isn't our domainInput, ignore
    if (active && isFocusableInput(active) && active !== domainInput && active !== blacklistInput) return;

    // Decide which form to submit based on visible tab/content
    const isWL = whitelistContent?.classList?.contains('active');
    const isBL = blacklistContent?.classList?.contains('active');
    const wlText = String(domainInput?.value || '').trim();
    const blText = String(blacklistInput?.value || '').trim();
    const targetForm = isBL ? addBlacklistForm : addDomainForm;
    const hasText = isBL ? blText.length > 0 : wlText.length > 0;
    if (!hasText) return;
    e.preventDefault();
    if (typeof targetForm?.requestSubmit === 'function') {
      targetForm.requestSubmit();
    } else {
      const evt = new Event('submit', { cancelable: true, bubbles: true });
      targetForm?.dispatchEvent(evt);
    }
  }
  document.addEventListener('keydown', handler, true);
})();

// ESC key closes banners
(function setupBannerEscClose() {
  function handler(e) {
    if (e.key === 'Escape' && banner && !banner.classList.contains('hidden')) {
      clearBanner();
    }
  }
  document.addEventListener('keydown', handler, true);
})();

// Settings Tab Management
function switchToTab(tabName) {
  // Update tab buttons
  const tabs = [whitelistTab, blacklistTab, llmTab];
  const contents = [whitelistContent, blacklistContent, llmContent];
  
  tabs.forEach(tab => tab?.classList.remove('active'));
  contents.forEach(content => content?.classList.remove('active'));
  
  if (tabName === 'llm') {
    llmTab?.classList.add('active');
    llmContent?.classList.add('active');
  } else if (tabName === 'blacklist') {
    blacklistTab?.classList.add('active');
    blacklistContent?.classList.add('active');
    renderBlacklist();
    try { autosizeBlacklistInput(); } catch {}
  } else {
    whitelistTab?.classList.add('active');
    whitelistContent?.classList.add('active');
  }
}

// Load LLM settings into form
async function loadLLMSettingsToForm() {
  try {
    const settings = await loadLLMSettings();
    if (llmApiKeyInput) llmApiKeyInput.value = settings.apiKey || '';
    if (llmModelInput) llmModelInput.value = settings.model || 'openai/gpt-3.5-turbo';
    if (llmSystemPromptInput) llmSystemPromptInput.value = settings.systemPrompt || 'You are a helpful AI assistant. Provide clear, concise answers.';
  } catch {}
}

// Tab event listeners
whitelistTab?.addEventListener('click', () => {
  switchToTab('whitelist');
});

blacklistTab?.addEventListener('click', () => {
  switchToTab('blacklist');
});

llmTab?.addEventListener('click', () => {
  switchToTab('llm');
  // Load settings when switching to LLM tab
  loadLLMSettingsToForm();
  llmInputsDirty = { apiKey: false, model: false, systemPrompt: false };
  renderLLMSettings();
});

// LLM Settings save
llmSaveButton?.addEventListener('click', async () => {
  try {
    const settings = {
      apiKey: llmApiKeyInput?.value || '',
      model: llmModelInput?.value || 'openai/gpt-3.5-turbo',
      systemPrompt: llmSystemPromptInput?.value || 'You are a helpful AI assistant. Provide clear, concise answers.'
    };
    
    const result = await schedulePendingLLMSettings(settings);
    if (!result.hasChanges) {
      showBanner('No changes to save', '', 3000);
    } else if (result.immediate) {
      showBanner('LLM settings saved successfully!', '', 3000);
    } else {
      const delayMinutes = getDelayMinutes();
      showBanner(`LLM settings changes will take effect in ${delayMinutes} minute${delayMinutes !== 1 ? 's' : ''}`, '', 5000);
    }
    
    // Reset dirty flags after save
    llmInputsDirty = { apiKey: false, model: false, systemPrompt: false };
    renderLLMSettings();
  } catch (error) {
    showBanner(`Error saving LLM settings: ${error.message}`, 'error', 5000);
  }
});

// LLM Cancel Button Event Listeners
llmApiKeyCancelButton?.addEventListener('click', async () => {
  await clearPendingLLMSetting('apiKey');
  llmInputsDirty.apiKey = false;
  renderLLMSettings();
  showBanner('Pending API key change cancelled', '', 3000);
});

llmModelCancelButton?.addEventListener('click', async () => {
  await clearPendingLLMSetting('model');
  llmInputsDirty.model = false;
  renderLLMSettings();
  showBanner('Pending model change cancelled', '', 3000);
});

llmSystemPromptCancelButton?.addEventListener('click', async () => {
  await clearPendingLLMSetting('systemPrompt');
  llmInputsDirty.systemPrompt = false;
  renderLLMSettings();
  showBanner('Pending system prompt change cancelled', '', 3000);
});

// LLM Input Event Listeners for dirty state tracking
llmApiKeyInput?.addEventListener('input', () => {
  llmInputsDirty.apiKey = true;
});

llmModelInput?.addEventListener('input', () => {
  llmInputsDirty.model = true;
});

llmSystemPromptInput?.addEventListener('input', () => {
  llmInputsDirty.systemPrompt = true;
});

backBtn?.addEventListener('click', () => {
  setSettingsVisible(false);
  stopCountdown();
  clearWhitelistSelection();
});

// Sort toggle change (button toggles between 'recent' and 'abc')
if (sortToggle) {
  sortToggle.addEventListener('click', (e) => {
    try {
      e.preventDefault();
      const isRecent = sortToggle.getAttribute('aria-pressed') === 'true';
      const nextMode = isRecent ? 'abc' : 'recent';
      cachedSortMode = nextMode; // Update cache immediately
      safeSetItem(SORT_MODE_KEY, nextMode).catch(() => {});
      sortToggle.setAttribute('aria-pressed', String(nextMode === 'recent'));
      const t = sortToggle.querySelector('.sort-text');
      if (t) t.textContent = nextMode;
      renderWhitelist();
    } catch {}
  });
}

// Delay settings controls
let delayInputDirty = false;
function updateSaveButtonState() {
  if (!delaySaveBtn || !delayInput) return;
  const effective = getDelayMinutes();
  const pending = getPendingDelay();
  const valStr = String(delayInput.value ?? '').trim();
  if (valStr === '') { delaySaveBtn.disabled = true; return; }
  const next = sanitizeDelay(valStr);
  const equalsEffective = next === effective;
  const equalsPending = pending ? next === sanitizeDelay(pending.minutes) : false;
  delaySaveBtn.disabled = equalsEffective || equalsPending;
}

function initDelayControls() {
  delayInputDirty = false;
  if (delayInput) delayInput.value = String(getDelayMinutes());
  updateSaveButtonState();
  renderDelayControls();
}

let delayCancelHover = false;
function renderDelayControls() {
  const promoted = promotePendingIfDue();
  const effective = getDelayMinutes();
  const pending = getPendingDelay();
  // Update save button label to reflect pending target minutes
  if (delaySaveBtn) {
    delaySaveBtn.classList.remove('danger');
    if (pending) {
      if (delayCancelHover) {
        delaySaveBtn.textContent = `Cancel (${sanitizeDelay(pending.minutes)})`;
        delaySaveBtn.classList.add('danger');
      } else {
        delaySaveBtn.textContent = `Saving (${sanitizeDelay(pending.minutes)})`;
      }
    } else {
      delaySaveBtn.textContent = 'Save';
    }
  }
  if (delayCountdownEl) {
    if (pending) {
      const remaining = Math.max(0, pending.activateAt - Date.now());
      const label = fmtRemaining(remaining) || '0:00';
      delayCountdownEl.textContent = label;
      delayCountdownEl.classList.remove('hidden');
    } else {
      delayCountdownEl.textContent = '';
      delayCountdownEl.classList.add('hidden');
    }
  }
  if (promoted) {
    delayInputDirty = false;
  }
  if (!delayInputDirty && delayInput) {
    delayInput.value = String(effective);
  }
  updateSaveButtonState();
  // While hovering cancel, make the button clickable regardless of save state
  if (delaySaveBtn && pending && delayCancelHover) {
    delaySaveBtn.disabled = false;
  }
}

async function renderLLMSettings() {
  await promotePendingLLMSettingsIfDue();
  const pendingSettings = getPendingLLMSettings();
  
  // Get current effective settings
  const currentSettings = await loadLLMSettings();
  
  // Update each field with countdown and disabled state
  const fields = [
    { input: llmApiKeyInput, countdown: document.getElementById('llm-api-key-countdown'), cancel: document.getElementById('llm-api-key-cancel'), key: 'apiKey' },
    { input: llmModelInput, countdown: document.getElementById('llm-model-countdown'), cancel: document.getElementById('llm-model-cancel'), key: 'model' },
    { input: llmSystemPromptInput, countdown: document.getElementById('llm-system-prompt-countdown'), cancel: document.getElementById('llm-system-prompt-cancel'), key: 'systemPrompt' }
  ];
  
  fields.forEach(field => {
    if (!field.input || !field.countdown || !field.cancel) return;
    
    const fieldPending = pendingSettings[field.key];
    
    if (fieldPending) {
      // Show countdown and cancel button for this field
      const remaining = Math.max(0, fieldPending.activateAt - Date.now());
      const label = fmtRemaining(remaining) || '0:00';
      field.countdown.textContent = label;
      field.countdown.classList.remove('hidden');
      field.cancel.classList.remove('hidden');
      
      // Disable the input and show pending value
      field.input.disabled = true;
      field.input.value = fieldPending.value || '';
    } else {
      // Hide countdown and cancel button for this field
      field.countdown.textContent = '';
      field.countdown.classList.add('hidden');
      field.cancel.classList.add('hidden');
      
      // Enable the input and show current effective value (only if not dirty)
      field.input.disabled = false;
      if (!llmInputsDirty[field.key] && field.input.value !== currentSettings[field.key]) {
        field.input.value = currentSettings[field.key] || '';
      }
    }
  });
}

delayInput?.addEventListener('input', () => {
  delayInputDirty = true;
  updateSaveButtonState();
});

delaySaveBtn?.addEventListener('click', async () => {
  if (!delayInput) return;
  const pending = getPendingDelay();
  if (pending && delayCancelHover) {
    // Cancel pending change
    await clearPendingDelay();
    showBanner('Pending delay change canceled');
    delayCancelHover = false;
    delayInputDirty = false;
    if (delayInput) delayInput.value = String(getDelayMinutes());
    renderDelayControls();
    updateSaveButtonState();
    return;
  }
  const valStr = String(delayInput.value ?? '').trim();
  const next = sanitizeDelay(valStr);
  const result = await schedulePendingDelay(next);
  if (result.immediate) {
    showBanner('Delay updated');
  } else {
    const effective = getDelayMinutes();
    const mins = effective;
    showBanner(`Delay change saved. Activates in ${mins} min`);
  }
});

delaySaveBtn?.addEventListener('mouseenter', () => {
  const pending = getPendingDelay();
  if (pending) { delayCancelHover = true; renderDelayControls(); }
});

delaySaveBtn?.addEventListener('mouseleave', () => {
  if (delayCancelHover) { delayCancelHover = false; renderDelayControls(); }
});

async function addDomainWithDelay(host) {
  const wl = loadWhitelist();
  if (wl.some((it) => it.domain === host)) {
    showBanner(`${host} already whitelisted`);
    return;
  }
  const delayMin = getDelayMinutes();
  const activateAt = delayMin > 0 ? Date.now() + delayMin * 60 * 1000 : 0;
  wl.push({ domain: host, activateAt });
  await saveWhitelist(wl);
  renderWhitelist();
  if (delayMin > 0) {
    showBanner(`Added ${host}. Activates in ${delayMin} min`);
  } else {
    showBanner(`Added ${host} to whitelist`);
  }
}

// --- Active Locations ---
const activeLocations = new Map(); // id -> { id, title, url, webview }
let activeSeq = 1;
// MRU list of active ids (most recent first)
let activeMru = [];

// Persistence helpers for active sessions
async function persistActiveSessions() {
  try {
    const arr = [];
    for (const [id, rec] of activeLocations) {
      const url = (rec?.webview?.getURL?.() || rec?.url || '').trim();
      const title = String(rec?.title || '');
      if (!url || url === 'about:blank') continue; // do not persist blank placeholders
      arr.push({ id: String(id), url, title });
    }
    await safeSetItem(ACTIVE_SESSIONS_KEY, JSON.stringify(arr));
  } catch {}
}

async function loadActiveSessions() {
  try {
    const raw = await safeGetItem(ACTIVE_SESSIONS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((it) => {
        if (!it || typeof it !== 'object') return null;
        const id = String(it.id ?? '').trim();
        const url = String(it.url ?? '').trim();
        const title = String(it.title ?? '');
        if (!id || !url) return null;
        return { id, url, title };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function persistVisibleViewFor(el) {
  try {
    let data = { kind: 'primary' };
    // Primary is only when this is the ephemeral primary with id 'webview'
    if (!(el === primaryWebView && el?.id === 'webview')) {
      const id = findActiveIdByWebView(el);
      if (id) data = { kind: 'active', id: String(id) };
    }
    await safeSetItem(VISIBLE_VIEW_KEY, JSON.stringify(data));
  } catch {}
}

async function loadVisibleView() {
  try {
    const raw = await safeGetItem(VISIBLE_VIEW_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const kind = obj.kind === 'active' ? 'active' : obj.kind === 'primary' ? 'primary' : null;
    if (!kind) return null;
    if (kind === 'active') {
      const id = String(obj.id ?? '').trim();
      if (!id) return null;
      return { kind, id };
    }
    return { kind: 'primary' };
  } catch {
    return null;
  }
}

function findActiveIdByWebView(el) {
  try {
    for (const [id, rec] of activeLocations) {
      if (rec?.webview === el) return String(id);
    }
  } catch {}
  return null;
}

async function restoreActiveSessionsFromStorage() {
  try {
    const list = await loadActiveSessions();
    if (!Array.isArray(list) || list.length === 0) {
      // Still initialize visible view key to current primary
      await persistVisibleViewFor(getVisibleWebView());
      return;
    }
    let maxIdNum = 0;
    const container = getContentContainer();
    list.forEach(({ id, url, title }) => {
      const el = document.createElement('webview');
      el.id = `webview-active-${id}`;
      el.setAttribute('disableblinkfeatures', 'AutomationControlled');
      el.setAttribute('allowpopups', '');
      applyWebViewFrameStyles(el);
      setLastAllowed(el, 'about:blank');
      container?.appendChild(el);
      // Wire before setting src so events are tracked
      wireWebView(el);
      try { el.setAttribute('src', url); } catch { el.src = url; }
      el.classList.add('hidden');
      activeLocations.set(String(id), { id: String(id), title: String(title || ''), url: String(url || ''), webview: el });
      const n = Number(id);
      if (Number.isFinite(n)) maxIdNum = Math.max(maxIdNum, n);
    });
    activeSeq = Math.max(activeSeq, maxIdNum + 1);
    
    // Update bubble count after restoring sessions
    updateActiveCountBubble();

    // Restore last visible
    const vv = await loadVisibleView();
    if (vv && vv.kind === 'active' && activeLocations.has(String(vv.id))) {
      switchToActive(String(vv.id));
    } else if (vv && vv.kind === 'primary') {
      const primary = ensurePrimaryWebView();
      switchToWebView(primary);
    }
  } catch {}
}

function getContentContainer() {
  return document.querySelector('.content');
}

function getVisibleWebView() {
  return currentVisibleView || primaryWebView;
}

function wireWebView(el) {
  if (!el || el._wired) return;
  el._wired = true;
  debugLog('wireWebView()', { id: viewId(el), url: viewURL(el) });
  applyWebViewFrameStyles(el);
  setLastAllowed(el, 'about:blank');

  // Surface console logs from the webview into the host DevTools console
  // This makes console.log/warn/error from pages (and their iframes) visible
  try {
    el.addEventListener('console-message', (e) => {
      try {
        const level = Number(e?.level);
        const msg = String(e?.message ?? '');
        const line = Number.isFinite(e?.line) ? e.line : null;
        const source = e?.sourceId ? String(e.sourceId) : '';
        const wcid = (() => { try { return typeof el.getWebContentsId === 'function' ? el.getWebContentsId() : null; } catch { return null; } })();
        if (wcid != null) { if (isConsoleDupe(`${wcid}|${source}:${line}|${msg}`)) return; }
        const url = (() => {
          try { return el.getURL?.() || ''; } catch { return ''; }
        })();
        let host = '';
        try { if (url) host = new URL(url).hostname; } catch {}
        const id = viewId(el);
        const prefix = `[webview:${id}${host ? ` ${host}` : ''}]`;
        const src = source || line ? `${source || ''}${line ? `:${line}` : ''}` : '';
        const suffix = src ? ` (${src})` : '';
        const method = (level === 2 || level === 3) ? 'error' : (level === 1 ? 'warn' : 'log');
        // eslint-disable-next-line no-console
        (console[method] || console.log)(`${prefix} ${msg}${suffix}`);
      } catch (err) {
        try { console.log('[webview console-message]', String(err && err.message || err)); } catch {}
      }
    });
  } catch {}

  // Hide suggestions when interacting with this webview
  el.addEventListener('focus', () => { hideSuggestions(); });
  // pointerdown handler removed (handled globally)

  // Update address bar when navigation occurs
  el.addEventListener('did-navigate', (e) => {
    debugLog('did-navigate', { id: viewId(el), url: e.url });
    
    // Reset conversation if navigating away from AI chat
    resetConversationIfNeeded(el, e.url);
    // If navigating to an AI chat URL, restore its conversation (so Back continues the thread)
    try {
      if (isAIChatURL(e.url)) {
        const saved = conversationByView.get(el);
        if (saved) {
          currentConversation = saved;
          if (input) input.placeholder = 'Continue the conversation...';
        } else {
          if (input) input.placeholder = 'Your question...';
        }
      }
    } catch {}

    if (el === getVisibleWebView()) {
      updateAddressBarWithURL(e.url);
      // When returning to AI chat, focus and select the address input
      try {
        if (isAIChatURL(e.url)) {
          input?.focus?.();
          input?.select?.();
        }
      } catch {}
    }
    if (e.url && isUrlAllowed(e.url)) {
      setLastAllowed(el, e.url);
    }
    // If this el belongs to an active session, update its record and persist
    try {
      const aid = findActiveIdByWebView(el);
      if (aid && activeLocations.has(aid)) {
        const rec = activeLocations.get(aid);
        const newUrl = e.url || el.getURL?.() || '';
        if (newUrl && newUrl !== 'about:blank') {
          rec.url = newUrl;
          try {
            if (isAIChatURL(newUrl)) {
              rec.title = getAIChatInitialQueryFromWebView(el) || rec.title || '';
            } else {
              rec.title = el.getTitle?.() || rec.title || '';
            }
          } catch {}
          persistActiveSessions().catch(() => {});
        }
      }
    } catch {}
    updateNavButtons();
    updateRefreshButtonUI();
        updateRemovalCountBubble();
    finishLoadingBar();
  });
  el.addEventListener('did-navigate-in-page', (e) => {
    debugLog('did-navigate-in-page', { id: viewId(el), url: e.url });
    if (el === getVisibleWebView()) {
      updateAddressBarWithURL(e.url);
      // In-page back to AI chat: focus and select input
      try {
        if (isAIChatURL(e.url)) {
          input?.focus?.();
          input?.select?.();
        }
      } catch {}
    }
    if (e.url && isUrlAllowed(e.url)) {
      setLastAllowed(el, e.url);
    }
    // Restore conversation placeholder when navigating within AI chat
    try {
      if (isAIChatURL(e.url)) {
        const saved = conversationByView.get(el);
        if (saved) {
          currentConversation = saved;
          if (input) input.placeholder = 'Continue the conversation...';
        } else {
          if (input) input.placeholder = 'Your question...';
        }
      }
    } catch {}
    // Update persisted active session if applicable
    try {
      const aid = findActiveIdByWebView(el);
      if (aid && activeLocations.has(aid)) {
        const rec = activeLocations.get(aid);
        const newUrl = e.url || el.getURL?.() || '';
        if (newUrl && newUrl !== 'about:blank') {
          rec.url = newUrl;
          try {
            if (isAIChatURL(newUrl)) {
              rec.title = getAIChatInitialQueryFromWebView(el) || rec.title || '';
            } else {
              rec.title = el.getTitle?.() || rec.title || '';
            }
          } catch {}
          persistActiveSessions().catch(() => {});
        }
      }
    } catch {}
    updateNavButtons();
    updateRefreshButtonUI();
        updateRemovalCountBubble();
    finishLoadingBar();
  });

  // Enforce whitelist on navigations triggered inside webview
  el.addEventListener('will-navigate', (e) => {
    const allowed = isUrlAllowed(e.url);
    debugLog('will-navigate', { id: viewId(el), url: e.url, allowed });
    if (!allowed) {
      e.preventDefault();
      showBlockedWithAdd(e.url);
    }
  });

  el.addEventListener('will-redirect', (e) => {
    const allowed = isUrlAllowed(e.url);
    debugLog('will-redirect', { id: viewId(el), url: e.url, allowed });
    if (!allowed) {
      e.preventDefault();
      showBlockedWithAdd(e.url);
    }
  });

  el.addEventListener('new-window', (e) => {
    e.preventDefault();
    if (isUrlAllowed(e.url)) {
      el.src = e.url;
    } else {
      showBlockedWithAdd(e.url);
    }
  });

  el.addEventListener('dom-ready', () => {
    try {
      const current = el.getURL?.() || '';
      debugLog('dom-ready', { id: viewId(el), url: current });
      if (current && current !== 'about:blank' && !isUrlAllowed(current)) {
        showBlockedWithAdd(current);
      }
      // Update title/url for active sessions on ready
      try {
        const aid = findActiveIdByWebView(el);
        if (aid && activeLocations.has(aid)) {
          const rec = activeLocations.get(aid);
          if (current && current !== 'about:blank') {
            rec.url = current;
            try {
              if (isAIChatURL(current)) {
                rec.title = getAIChatInitialQueryFromWebView(el) || rec.title || '';
              } else {
                rec.title = el.getTitle?.() || rec.title || '';
              }
            } catch {}
            persistActiveSessions().catch(() => {});
          }
        }
      } catch {}
    } catch {}
    updateNavButtons();
    updateRefreshButtonUI();
        updateRemovalCountBubble();
    finishLoadingBar();
    // Apply dark mode if enabled
    try { debugLog('dark-mode dom-ready', { id: viewId(el), enabled: !!darkModeEnabled }); } catch {}
    try { if (darkModeEnabled) { setWebViewDarkMode(el, true); } else { setWebViewDarkMode(el, false); } } catch {}
    // Re-apply hover highlighter if selection mode is active and this view is visible
    try { if (elementSelectMode && el === getVisibleWebView()) { setWebViewHoverHighlighter(el, true); } } catch {}
    // Apply any persisted removal rules for this domain
    (async () => {
      try {
        const url = el.getURL?.() || '';
        if (!url) return;
        const h = new URL(url).hostname.toLowerCase();
        const domain = getRegistrableDomain(h) || h;
        const rules = await getDomainRemovalRules(domain);
        debugLog('apply-removal-rules', { domain, count: Array.isArray(rules) ? rules.length : 0, sample: Array.isArray(rules) && rules.length ? JSON.stringify(rules[0]).slice(0,200) : null });
        if (Array.isArray(rules) && rules.length) await setWebViewDomainRemovalRules(el, rules);
      } catch {}
    })();

    // Check blacklist terms as soon as DOM is ready
    (async () => {
      try { await checkBlacklistForWebView(el); } catch {}
    })();
  });

  // Track page title changes so suggestions stay fresh
  el.addEventListener('page-title-updated', () => {
    try {
      const aid = findActiveIdByWebView(el);
      if (aid && activeLocations.has(aid)) {
        const rec = activeLocations.get(aid);
        try {
          const nowUrl = el.getURL?.() || '';
          if (isAIChatURL(nowUrl)) {
            rec.title = getAIChatInitialQueryFromWebView(el) || rec.title || '';
          } else {
            rec.title = el.getTitle?.() || rec.title || '';
          }
        } catch {}
        persistActiveSessions().catch(() => {});
      }
    } catch {}
  });

  el.addEventListener('did-start-navigation', (e) => {
  try {
  const { url, isMainFrame } = e;
  debugLog('did-start-navigation', { id: viewId(el), url, isMainFrame });
  if (!isMainFrame) return;

  // Apply domain-specific adblock preference early for visible view
  try { if (el === getVisibleWebView() && url && url !== 'about:blank') { ensureAdblockStateForURL(url); } } catch {}

  if (url && !isUrlAllowed(url)) {
  el.stop();
  const last = getLastAllowed(el);
  debugLog('blocked in did-start-navigation; reverting to lastAllowed', { id: viewId(el), last });
    if (last && el.getURL?.() !== last) {
        el.src = last;
      }
      showBlockedWithAdd(url);
    }
  } catch {}
  updateNavButtons();
});

  el.addEventListener('did-start-loading', () => {
    debugLog('did-start-loading', { id: viewId(el), visible: el === getVisibleWebView(), current: viewURL(el) });
    if (el === getVisibleWebView()) {
      isLoading = true;
      updateRefreshButtonUI();
      startLoadingBar();
    }
  });
  el.addEventListener('did-stop-loading', () => {
    debugLog('did-stop-loading', { id: viewId(el), current: viewURL(el) });
    if (el === getVisibleWebView()) {
      isLoading = false;
      updateRefreshButtonUI();
      finishLoadingBar();
    }
    updateRemovalCountBubble();
    // Ensure dark mode is applied/removed after full load as well
    try { debugLog('dark-mode did-stop-loading', { id: viewId(el), enabled: !!darkModeEnabled }); } catch {}
    try { if (darkModeEnabled) { setWebViewDarkMode(el, true); } else { setWebViewDarkMode(el, false); } } catch {}
    // Ensure domain removal rules run after full load as well
    (async () => {
      try {
        const url = el.getURL?.() || '';
        if (!url) return;
        const h = new URL(url).hostname.toLowerCase();
        const domain = getRegistrableDomain(h) || h;
        const rules = await getDomainRemovalRules(domain);
        if (Array.isArray(rules) && rules.length) await setWebViewDomainRemovalRules(el, rules);
      } catch {}
    })();

    // Check blacklist after full load, too
    (async () => {
      try { await checkBlacklistForWebView(el); } catch {}
    })();
  });
  el.addEventListener('did-fail-load', (e) => {
    debugLog('did-fail-load', { id: viewId(el), code: e?.errorCode, url: e?.validatedURL });
    if (el === getVisibleWebView()) {
      isLoading = false;
      updateRefreshButtonUI();
      finishLoadingBar();
    }
  });

  // Re-apply find after page load completes
  try {
    el.addEventListener('did-stop-loading', () => {
      try {
        if (findOpen && getVisibleWebView() === el && findQuery) {
          // Restart the search on this page
          doFind({ initial: true });
        }
      } catch {}
    });
  } catch {}

  // Update match counts when this webview reports results
  try {
    el.addEventListener('found-in-page', (ev) => {
      try {
        const res = (ev && ev.result) ? ev.result : ev; // tolerate different event shapes
        const matches = Number(res?.matches || 0);
        const active = Number(res?.activeMatchOrdinal || 0);
        if (!findOpen) return;
        // Only update if this is the visible webview
        if (getVisibleWebView() !== el) return;
        findMatches = matches;
        findActive = active;
        updateFindUI();
      } catch {}
    });
  } catch {}
}

function ensurePrimaryWebView() {
  // Ensure we have a primary ephemeral webview with id 'webview'
  let el = document.getElementById('webview');
  if (!el) {
    el = document.createElement('webview');
    el.id = 'webview';
    // Do not preset src here; caller will set the destination to avoid flashing about:blank
    el.setAttribute('disableblinkfeatures', 'AutomationControlled');
    el.setAttribute('allowpopups', '');
    applyWebViewFrameStyles(el);
    const container = getContentContainer();
    container?.appendChild(el);
    wireWebView(el);
    primaryWebView = el;
    debugLog('ensurePrimaryWebView: created new primary', { id: viewId(el), url: viewURL(el) });
  } else {
    debugLog('ensurePrimaryWebView: using existing primary', { id: viewId(el), url: viewURL(el) });
  }
  return el;
}

let __lastAdblockDesired = null; // null | boolean
async function ensureAdblockStateForURL(url) {
  try {
    let desired = true;
    try {
      const u = new URL(String(url || ''));
      const h = u.hostname || '';
      if (h) {
        const d = getRegistrableDomain(h) || h;
        const list = loadAdblockDisabledDomains();
        desired = !list.includes(String(d || '').toLowerCase());
      }
    } catch {}
    // Avoid redundant toggles
    if (__lastAdblockDesired === desired) return;
    __lastAdblockDesired = desired;
    await window.adblock?.setEnabled?.(desired);
  } catch {}
}

function switchToWebView(el) {
  if (!el) return;
  debugLog('switchToWebView', { from: viewId(currentVisibleView), to: viewId(el), fromURL: viewURL(currentVisibleView), toURL: viewURL(el) });

  // If leaving an active location that never navigated (about:blank), remove it to avoid persisting blanks
  try {
    const cur = currentVisibleView;
    const curAid = findActiveIdByWebView(cur);
    if (curAid) {
      const curUrl = (cur?.getURL?.() || '').trim();
      if (!curUrl || curUrl === 'about:blank') {
        debugLog('auto-remove blank active on switch', { id: curAid, viewId: viewId(cur) });
        activeLocations.delete(String(curAid));
        activeMru = activeMru.filter((x) => x !== String(curAid) && activeLocations.has(x));
        try { cur.remove(); } catch {}
        if (cur === primaryWebView) { primaryWebView = null; }
        updateActiveCountBubble();
        persistActiveSessions().catch(() => {});
      }
    }
  } catch {}

  // Hide current
  if (currentVisibleView) currentVisibleView.classList.add('hidden');
  // Show target
  el.classList.remove('hidden');
  currentVisibleView = el;
  // Update MRU if this is an active webview
  try {
    const aid = findActiveIdByWebView(el);
    if (aid) {
      activeMru = [aid, ...activeMru.filter((x) => x !== aid && activeLocations.has(x))];
    }
  } catch {}
  updateNavButtons();
  updateRefreshButtonUI();
    updateRemovalCountBubble();
  updateActiveCountBubble();
  try {
    const url = el.getURL?.() || '';
    updateAddressBarWithURL(url);
    // Apply domain-specific adblock preference for the newly visible view
    if (url && url !== 'about:blank') { ensureAdblockStateForURL(url); }
    // If the target view is an AI chat page, restore its conversation
    if (isAIChatURL(url)) {
      try {
        const saved = conversationByView.get(el);
        if (saved) {
          currentConversation = saved;
          if (input) input.placeholder = 'Continue the conversation...';
        } else {
          if (input) input.placeholder = 'Your question...';
        }
        // Focus and select the address input for quick follow-up typing
        input?.focus?.();
        input?.select?.();
      } catch {}
    }
  } catch {}
  // Persist which view is visible
  persistVisibleViewFor(el).catch(() => {});
  // If selection mode is active, ensure highlighter is applied on the new visible view
  try { if (elementSelectMode) { setWebViewHoverHighlighter(el, true); } } catch {}
  // If find is open, re-run search on the new visible view
  try { if (findOpen && findQuery) { doFind({ initial: true }); } else { updateFindUI(); } } catch {}
}

function parkCurrentAsActive(flashUI = false) {
  const el = getVisibleWebView();
  // If already an active view, do nothing
  for (const [, rec] of activeLocations) {
    if (rec.webview === el) return rec.id;
  }
  // Create entry only if page is meaningful
  const currentURL = (el.getURL?.() || '').trim();
  if (!currentURL || currentURL === 'about:blank') { debugLog('parkCurrentAsActive: skip (blank)', { id: viewId(el), url: currentURL }); return null; }
  const id = String(activeSeq++);
  // If parking the primary element, rename its id to avoid conflicts
  if (el === primaryWebView && el.id === 'webview') {
    el.id = `webview-active-${id}`;
    applyWebViewFrameStyles(el);
    // Defer creating a new primary until navigate() actually needs it
  }
  // Seed title: if this is an AI chat thread, use its initial query as the title
  let seedTitle = '';
  if (isAIChatURL(currentURL)) {
    seedTitle = getAIChatInitialQueryFromWebView(el) || '';
  }
  activeLocations.set(id, { id, title: seedTitle, url: currentURL, webview: el });
  debugLog('parkCurrentAsActive: created', { id, viewId: viewId(el), url: currentURL, title: seedTitle });
  
  // Update bubble count
  updateActiveCountBubble(flashUI);
  // Try to update title asynchronously
  setTimeout(() => {
    try {
      const rec = activeLocations.get(id);
      if (rec) {
        const nowURL = (el.getURL?.() || '').trim();
        if (isAIChatURL(nowURL)) {
          // Keep or refresh the AI title from initial query; don't overwrite with generic title
          const aiTitle = getAIChatInitialQueryFromWebView(el) || rec.title || '';
          rec.title = aiTitle;
        } else {
          // Non-AI: use the page title
          rec.title = el.getTitle?.() || rec.title || '';
        }
      }
      persistActiveSessions().catch(() => {});
    } catch {}
  }, 0);
  // Persist after creation
  persistActiveSessions().catch(() => {});
  return id;
}

function switchToActive(id) {
  const rec = activeLocations.get(String(id));
  if (!rec) { debugLog('switchToActive: not found', { id }); return; }
  debugLog('switchToActive', { id, viewId: viewId(rec.webview), url: viewURL(rec.webview) });
  switchToWebView(rec.webview);
}

// Create a new about:blank view and switch to it.
// When makeActive is true, create a persistent active webview; else use ephemeral primary.
function createNewActiveBlankAndSwitch(makeActive = false) {
  try {
    if (makeActive) {
      const id = String(activeSeq++);
      const el = document.createElement('webview');
      el.id = `webview-active-${id}`;
      el.setAttribute('disableblinkfeatures', 'AutomationControlled');
      el.setAttribute('allowpopups', '');
      applyWebViewFrameStyles(el);
      const container = getContentContainer();
      container?.appendChild(el);
      wireWebView(el);
      setLastAllowed(el, 'about:blank');
      try { el.setAttribute('src', 'about:blank'); } catch { el.src = 'about:blank'; }
      activeLocations.set(id, { id, title: '', url: 'about:blank', webview: el });
      updateActiveCountBubble();
      persistActiveSessions().catch(() => {});
      switchToWebView(el);
      leaveSettingsIfOpen();
      try { if (input) { input.value = ''; input.focus(); input.select?.(); __heldShift = false; __heldMetaCtrl = false; updateSuggestionOpenSuffix(); } } catch {}
      return id;
    }
    // Ephemeral (non-persistent)
    const primary = ensurePrimaryWebView();
    setLastAllowed(primary, 'about:blank');
    try { primary.setAttribute('src', 'about:blank'); } catch { primary.src = 'about:blank'; }
    switchToWebView(primary);
    leaveSettingsIfOpen();
    try { if (input) { input.value = ''; input.focus(); input.select?.(); __heldShift = false; __heldMetaCtrl = false; updateSuggestionOpenSuffix(); } } catch {}
    return 'primary';
  } catch (err) {
    debugLog('createNewActiveBlankAndSwitch: error', String(err && err.message || err));
    return null;
  }
}

function createActiveViewWithURL(url) {
  try {
    const id = String(activeSeq++);
    const el = document.createElement('webview');
    el.id = `webview-active-${id}`;
    el.setAttribute('disableblinkfeatures', 'AutomationControlled');
    el.setAttribute('allowpopups', '');
    applyWebViewFrameStyles(el);
    const container = getContentContainer();
    container?.appendChild(el);
    wireWebView(el);
    setLastAllowed(el, url);
    try { el.setAttribute('src', url); } catch { el.src = url; }
    activeLocations.set(id, { id, title: '', url, webview: el });
    updateActiveCountBubble();
    persistActiveSessions().catch(() => {});
    switchToWebView(el);
    leaveSettingsIfOpen();
    return id;
  } catch (err) {
    debugLog('createActiveViewWithURL: error', String(err && err.message || err));
    return null;
  }
}

function closeActiveById(id) {
  try {
    const rec = activeLocations.get(String(id));
    if (!rec) { debugLog('closeActiveById: not found', { id }); return; }
    const el = rec.webview;
    const isCurrent = el === getVisibleWebView();
    debugLog('closeActiveById()', { id, isCurrent, viewId: viewId(el), url: viewURL(el) });
    // Remove from data structures first
    activeLocations.delete(String(id));
    activeMru = activeMru.filter((x) => x !== String(id) && activeLocations.has(x));
    // Update bubble count after deletion
    updateActiveCountBubble();
    // Remove DOM element
    try { el.remove(); } catch {}
    if (el === primaryWebView) {
      // If we removed the element previously serving as primary, clear ref so a new one is created on demand
      primaryWebView = null;
    }
    persistActiveSessions().catch(() => {});
    if (isCurrent) {
      // Determine next view
      let nextId = activeMru.length > 0 ? activeMru[0] : null;
      if (nextId && activeLocations.has(nextId)) {
        switchToActive(nextId);
      } else {
        // Fallback: pick any remaining active session
        let anyId = null;
        for (const [rid] of activeLocations) { anyId = rid; break; }
        if (anyId) {
          switchToActive(anyId);
        } else {
          // No active locations remain: show about:blank in primary
          const primary = ensurePrimaryWebView();
          try { primary.setAttribute('src', 'about:blank'); } catch { primary.src = 'about:blank'; }
          switchToWebView(primary);
        }
      }
          }
  } catch (err) {
    debugLog('closeActiveById: error', String(err && err.message || err));
  }
}

function closeCurrentActive() {
  try {
    const el = getVisibleWebView();
    const aid = findActiveIdByWebView(el);
    debugLog('closeCurrentActive()', { aid, viewId: viewId(el), url: viewURL(el) });
    if (!aid) { debugLog('closeCurrentActive: no active view to close'); return; }
    closeActiveById(aid);
  } catch (err) {
    debugLog('closeCurrentActive: error', String(err && err.message || err));
  }
}

// Demote the currently visible active webview back to the primary (ephemeral) webview.
// Preserves the page/content by reusing the same <webview> element, reassigning it as primary.
function demoteCurrentActiveToPrimary() {
  try {
    const el = getVisibleWebView();
    const aid = findActiveIdByWebView(el);
    if (!aid) { return false; }

    // Remove record from active locations and MRU
    activeLocations.delete(String(aid));
    activeMru = activeMru.filter((x) => x !== String(aid) && activeLocations.has(x));

    // If a separate primary exists, remove it from the DOM to avoid duplicates
    if (primaryWebView && primaryWebView !== el) {
      try { primaryWebView.remove(); } catch {}
      primaryWebView = null;
    }

    // Reassign this element to be the primary
    try { el.id = 'webview'; } catch {}
    primaryWebView = el;

    // Update UI and persistence
    updateActiveCountBubble();
    persistActiveSessions().catch(() => {});
    persistVisibleViewFor(el).catch(() => {});
    // Ensure visibility state is consistent
    switchToWebView(el);
    return true;
  } catch (err) {
    debugLog('demoteCurrentActiveToPrimary: error', String(err && err.message || err));
    return false;
  }
}

function getActiveSuggestions(q) {
  const items = [];
  const query = String(q || '').trim();
  const currentActiveId = findActiveIdByWebView(currentVisibleView);

  // Build MRU-ordered list of active IDs (most recent first), excluding current visible
  const orderedIds = [];
  try {
    for (const id of activeMru) {
      if (id === currentActiveId) continue;
      if (activeLocations.has(id)) orderedIds.push(id);
    }
    // Include any remaining active ids not present in MRU (e.g., restored sessions)
    for (const [id] of activeLocations) {
      if (id === currentActiveId) continue;
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }
  } catch {}

  for (const id of orderedIds) {
    const rec = activeLocations.get(id);
    if (!rec) continue;

    const currentURL = rec.webview?.getURL?.() || rec.url || '';
    const ai = isAIChatURL(currentURL);
    let title = '';
    if (ai) {
      // Prefer our curated title (initial query) over the page title
      title = rec.title || getAIChatInitialQueryFromWebView(rec.webview) || '';
    } else {
      // Non-AI: fetch live title; fallback to stored title or hostname
      try { title = rec.webview?.getTitle?.() || rec.title || ''; } catch { title = rec.title || ''; }
      if (!title) { try { title = new URL(currentURL).hostname || ''; } catch {} }
    }
    // Label/detail rules:
    // - AI chat: label = title (initial query), detail hidden
    // - Normal: label = URL, detail = title
    const label = ai ? (title || '(Chat)') : currentURL;
    const detail = ai ? '' : title;
    const matchBase = ai ? (title || '') : `${label} ${detail}`.trim();
    const m = fuzzyMatch(query, matchBase);
    if (query && m.score < 0) continue;
    items.push({ kind: 'active', id: rec.id, label, detail, matches: m.indices });
  }
  // Already MRU-ordered
  return items;
}

// AI Chat functionality
async function performAIChat(query, conversationHistory = []) {
  try {
    const settings = await loadLLMSettings();
    if (!settings.apiKey) {
      showBanner('OpenRouter API key not configured. Please set it in Settings.', 'error', 5000);
      return null;
    }

    // Build messages array with conversation history
    const messages = [
      {
        role: 'system',
        content: settings.systemPrompt || 'You are a helpful AI assistant. Provide clear, concise answers.'
      },
      ...conversationHistory,
      {
        role: 'user',
        content: query
      }
    ];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Focus Browser'
      },
      body: JSON.stringify({
        model: settings.model || 'openai/gpt-3.5-turbo',
        messages,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0]?.message?.content || 'No response received.',
      model: settings.model || 'openai/gpt-3.5-turbo'
    };
  } catch (error) {
    console.error('AI Chat Error:', error);
    return {
      content: `Error: ${error.message}`,
      model: 'Error',
      isError: true
    };
  }
}

function generateAIChatHTML(conversation, isLoading = false) {
  // Basic HTML escaper to prevent injection
  function escapeHTML(str) {
    try {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    } catch {
      return '';
    }
  }

  function nl2br(str) {
    return String(str).replace(/(?:\r\n|\n\r|\n)/g, '<br>');
  }

  // Minimal, safe Markdown renderer for bold/italic/links/code
  function renderMarkdown(md) {
    try {
      let html = escapeHTML(md);
      // Inline code
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      // Links [text](https://...)
      // Use same-tab navigation so whitelist enforcement runs via will-navigate
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
      // Bold **text**
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // Italic *text* or _text_
      html = html.replace(/(^|[^*])\*([^\s*][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
      html = html.replace(/_([^\s_][^_]*)_/g, '<em>$1</em>');
      // Line breaks
      html = nl2br(html);
      return html;
    } catch {
      return escapeHTML(md);
    }
  }

  const messages = conversation.messages || [];
  const lastMessage = messages[messages.length - 1];
  const query = messages.find(m => m.role === 'user')?.content || '';
  
  // Generate conversation HTML (newest first)
  let conversationHTML = '';
  
  // Add loading indicator first if needed (it's the "newest" message)
  if (isLoading) {
    conversationHTML += `
      <div class="message assistant-message loading">
        <div class="message-label">Assistant</div>
        <div class="message-text">Thinking...</div>
      </div>
    `;
  }
  
  // Reverse the order to show newest messages first
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      conversationHTML += `
        <div class="message user-message">
          <div class="message-label">You</div>
          <div class="message-text">${nl2br(escapeHTML(msg.content))}</div>
        </div>
      `;
    } else if (msg.role === 'assistant') {
      const isError = msg.isError;
      const modelInfo = msg.model ? `<span class=\"model-info\">${escapeHTML(msg.model)}</span>` : '';
      conversationHTML += `
        <div class="message assistant-message ${isError ? 'error' : ''}">
          <div class="message-label">Assistant${modelInfo}</div>
          <div class="message-text">${renderMarkdown(msg.content)}</div>
        </div>
      `;
    }
  }
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>AI Chat - ${escapeHTML(query)}</title>
        <style>
            /* Sleek dark scrollbars */
            * {
                scrollbar-width: thin;
                scrollbar-color: #3a3f4a #1a1f28;
            }
            
            *::-webkit-scrollbar {
                width: 8px;
                height: 8px;
            }
            
            *::-webkit-scrollbar-track {
                background: #1a1f28;
            }
            
            *::-webkit-scrollbar-thumb {
                background: #3a3f4a;
                border-radius: 4px;
            }
            
            *::-webkit-scrollbar-thumb:hover {
                background: #4a5061;
            }
            
            *::-webkit-scrollbar-corner {
                background: #1a1f28;
            }
            
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                margin: 0;
                padding: 20px;
                background: #1a1a1a;
                color: #ffffff;
                line-height: 1.6;
            }
            .container {
                max-width: 800px;
                margin: 0 auto;
            }
            .message {
                margin-bottom: 20px;
            }
            .user-message {
                background: #2a2a2a;
                padding: 16px 20px;
                border-radius: 12px;
                border-left: 4px solid #007acc;
            }
            .assistant-message {
                background: #2a2a2a;
                padding: 16px 20px;
                border-radius: 12px;
                border-left: 4px solid rgb(0, 163, 204);
            }
            .assistant-message.error {
                border-left-color: #ff4444;
            }
            .message-label {
                font-size: 12px;
                color: #888;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 8px;
                font-weight: 600;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .model-info {
                font-size: 10px;
                color: #666;
                font-weight: 400;
                text-transform: none;
                letter-spacing: normal;
            }
            .message-text {
                font-size: 16px;
                font-weight: 400;
            }
            .message-text a {
                color: #4ea3ff;
                text-decoration: underline;
            }
            .message-text code {
                background: #1f2430;
                padding: 0.15em 0.35em;
                border-radius: 4px;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                font-size: 0.95em;
            }
            .user-message .message-text {
                font-weight: 500;
            }
            .loading {
                opacity: 0.6;
                animation: pulse 1.5s ease-in-out infinite;
            }
            .loading .message-text {
                font-style: italic;
            }
            @keyframes pulse {
                0%, 100% { opacity: 0.6; }
                50% { opacity: 1; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            ${conversationHTML}
        </div>
    </body>
    </html>
  `;
}

async function handleAIChat(query, opts = {}) {
  debugLog('handleAIChat', { query, shift: !!opts.shiftKey });
  
  const shiftKey = !!opts.shiftKey;
  const current = getVisibleWebView();
  
  // Check if this is a follow-up to existing conversation
  const isFollowUp = currentConversation && currentConversation.webview === current && 
                     current.getURL().startsWith('data:text/html') && 
                     (current.getURL().includes('AI%20Chat') || current.getURL().includes('AI Chat'));
  
  let conversation;
  if (isFollowUp) {
    // Add new user message to existing conversation
    conversation = currentConversation;
    conversation.messages.push({ role: 'user', content: query });
  } else {
    // Start new conversation
    conversation = {
      messages: [{ role: 'user', content: query }],
      webview: null // Will be set after webview is determined
    };
    currentConversation = conversation;
  }
  
  // Create initial HTML with loading state
  const loadingHTML = generateAIChatHTML(conversation, true);
  const dataURL = `data:text/html;charset=utf-8,${encodeURIComponent(loadingHTML)}`;
  
  let dest = current;
  
  // Handle webview management (only for new conversations)
  if (!isFollowUp) {
    if (shiftKey) {
      parkCurrentAsActive();
      dest = ensurePrimaryWebView();
      setLastAllowed(dest, dataURL);
      debugLog('set AI chat src (shift)', { id: viewId(dest), query });
      try { dest.setAttribute('src', dataURL); } catch { dest.src = dataURL; }
      closeSettingsOnLoad(dest);
      switchToWebView(dest);
    } else {
      let mustSwitch = false;
      for (const [, rec] of activeLocations) {
        if (rec.webview === current) { mustSwitch = true; break; }
      }
      if (mustSwitch) {
        dest = ensurePrimaryWebView();
        setLastAllowed(dest, dataURL);
        debugLog('set AI chat src (leave-active)', { id: viewId(dest), query });
        try { dest.setAttribute('src', dataURL); } catch { dest.src = dataURL; }
        switchToWebView(dest);
        leaveSettingsIfOpen();
      } else {
        setLastAllowed(dest, dataURL);
        debugLog('set AI chat src (reuse)', { id: viewId(dest), query });
        try { dest.setAttribute('src', dataURL); } catch { dest.src = dataURL; }
        closeSettingsOnLoad(dest);
      }
    }
    conversation.webview = dest;
    try { conversationByView.set(dest, conversation); } catch {}
  } else {
    // For follow-ups, just update the current webview with loading state
    debugLog('set AI chat src (follow-up)', { id: viewId(dest), query });
    try { dest.setAttribute('src', dataURL); } catch { dest.src = dataURL; }
  }
  
  // Perform AI request and update page
  try {
    // Get conversation history (excluding system messages for API)
    const conversationHistory = conversation.messages.slice(0, -1); // Exclude the new user message
    const response = await performAIChat(query, conversationHistory);
    
    if (response) {
      // Add assistant response to conversation
      conversation.messages.push({ 
        role: 'assistant', 
        content: response.content,
        model: response.model,
        isError: response.isError 
      });
      
      // Generate updated conversation HTML
      const resultHTML = generateAIChatHTML(conversation);
      const resultDataURL = `data:text/html;charset=utf-8,${encodeURIComponent(resultHTML)}`;
      
      // Update the webview with the result
      const targetView = getVisibleWebView();
      if (targetView) {
        debugLog('updating AI chat with response', { id: viewId(targetView), hasResponse: !!response });
        try { targetView.setAttribute('src', resultDataURL); } catch { targetView.src = resultDataURL; }
        
        // Clear address bar and focus for follow-up message
        setTimeout(() => {
          if (input) {
            input.value = '';
            input.focus();
            input.placeholder = 'Continue the conversation...';
          }
        }, 500);
      }
    }
  } catch (error) {
    console.error('AI Chat error:', error);
    // Add error to conversation
    conversation.messages.push({ 
      role: 'assistant', 
      content: `Error: ${error.message}`,
      isError: true 
    });
    
    const errorHTML = generateAIChatHTML(conversation);
    const errorDataURL = `data:text/html;charset=utf-8,${encodeURIComponent(errorHTML)}`;
    
    const targetView = getVisibleWebView();
    if (targetView) {
      try { targetView.setAttribute('src', errorDataURL); } catch { targetView.src = errorDataURL; }
    }
  }
}

function navigate(opts = {}) {
  clearBannerAction(); // Clear banner action when navigating
  const raw = input.value;
  const target = normalizeToURL(raw);
  const openInNew = !!opts.openInNew;
  const newIsActive = !!opts.newIsActive;
  debugLog('navigate()', { targetRaw: raw, target, openInNew, newIsActive });
  if (!target) { debugLog('navigate: invalid target'); return; }
  
  // Handle AI Chat URLs BEFORE whitelist check
  if (target.startsWith('ai-chat://query/')) {
    const query = decodeURIComponent(target.replace('ai-chat://query/', ''));
    handleAIChat(query, opts);
    try { if (openInNew || newIsActive) clearHeldModifiersAndSuffix(); } catch {}
    return;
  }
  
  if (!isUrlAllowed(target)) {
    debugLog('navigate: blocked by whitelist', { target });
    showBlockedWithAdd(target);
    return;
  }
  const current = getVisibleWebView();
  debugLog('navigate: branch', { openInNew, newIsActive, currentId: viewId(current), currentURL: viewURL(current) });
  if (openInNew && newIsActive) {
    // Create a brand new active webview and navigate there
    const id = createActiveViewWithURL(target);
    debugLog('navigate new active', { id });
    try { clearHeldModifiersAndSuffix(); } catch {}
    return;
  }
  if (openInNew && !newIsActive) {
    // Open in ephemeral primary and switch
    const primary = ensurePrimaryWebView();
    setLastAllowed(primary, target);
    debugLog('set src (new-ephemeral)', { id: viewId(primary), target });
    try { primary.setAttribute('src', target); } catch { primary.src = target; }
    closeSettingsOnLoad(primary);
    if (DEBUG) {
      setTimeout(() => { debugLog('watchdog (new-ephemeral): after set src', { id: viewId(primary), url: viewURL(primary), isLoading: !!primary?.isLoading?.() }); }, 1200);
    }
    switchToWebView(primary);
    try { clearHeldModifiersAndSuffix(); } catch {}
    return;
  }
  // Default: reuse current webview (in-place)
  const dest = current;
  setLastAllowed(dest, target);
  debugLog('set src (in-place)', { id: viewId(dest), target });
  try { dest.setAttribute('src', target); } catch { dest.src = target; }
  // Defer closing settings until load completes
  closeSettingsOnLoad(dest);
  if (DEBUG) {
    setTimeout(() => {
      debugLog('watchdog (in-place): after set src', { id: viewId(dest), url: viewURL(dest), isLoading: !!dest?.isLoading?.() });
    }, 1200);
  }
}

// Suggestions / fuzzy search
let suggItems = [];
let suggSelected = -1; // -1 none, 0 is typed text

function updateSuggestionsPosition() {
  if (!suggestionsEl || !input) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const ib = input.getBoundingClientRect();
  const cb = content.getBoundingClientRect();
  const left = ib.left - cb.left;
  const top = Math.max(6, ib.bottom - cb.top + 6);
  suggestionsEl.style.left = `${left}px`;
  suggestionsEl.style.top = `${top}px`;
  suggestionsEl.style.width = `${ib.width}px`;
}

function hideSuggestions() {
  if (!suggestionsEl) return;
  suggestionsEl.classList.add('hidden');
  suggestionsEl.innerHTML = '';
  suggItems = [];
  suggSelected = -1;
}

function updateSuggestionSelection() {
  if (!suggestionsEl) return;
  const children = Array.from(suggestionsEl.children);
  children.forEach((el, i) => {
    if (i === suggSelected) el.classList.add('selected');
    else el.classList.remove('selected');
    el.setAttribute('aria-selected', i === suggSelected ? 'true' : 'false');
  });
  // Ensure the selected item is visible within the scrollable dropdown
  try {
    if (suggSelected >= 0 && suggSelected < children.length) {
      const el = children[suggSelected];
      // Prefer native scrollIntoView with nearest block to avoid jumping
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
      } else {
        // Fallback: manual scroll math
        const parent = suggestionsEl;
        const top = el.offsetTop;
        const bottom = top + el.offsetHeight;
        const viewTop = parent.scrollTop;
        const viewBottom = viewTop + parent.clientHeight;
        if (top < viewTop) parent.scrollTop = top;
        else if (bottom > viewBottom) parent.scrollTop = bottom - parent.clientHeight;
      }
    }
  } catch {}
  try { updateSuggestionOpenSuffix(); } catch {}
}

function renderHighlightedText(text, indices) {
  const frag = document.createDocumentFragment();
  const set = new Set(indices || []);
  let run = '';
  let inStrong = false;
  for (let i = 0; i < text.length; i++) {
    const isMatch = set.has(i);
    if (isMatch) {
      if (run && !inStrong) { frag.appendChild(document.createTextNode(run)); run = ''; }
      if (!inStrong) { inStrong = true; }
      run += text[i];
    } else {
      if (run && inStrong) {
        const strong = document.createElement('strong');
        strong.className = 'match';
        strong.textContent = run;
        frag.appendChild(strong);
        run = '';
        inStrong = false;
      }
      run += text[i];
    }
  }
  if (run) {
    if (inStrong) {
      const strong = document.createElement('strong');
      strong.className = 'match';
      strong.textContent = run;
      frag.appendChild(strong);
    } else {
      frag.appendChild(document.createTextNode(run));
    }
  }
  return frag;
}

function fuzzyMatch(query, candidate) {
  const q = String(query || '').toLowerCase();
  const c = String(candidate || '').toLowerCase();
  if (!q || !c) return { score: -1, indices: [] };
  if (c.startsWith(q)) {
    const indices = Array.from({ length: q.length }, (_, i) => i);
    return { score: 200 + q.length * 5, indices };
  }
  const subIdx = c.indexOf(q);
  if (subIdx >= 0) {
    const indices = Array.from({ length: q.length }, (_, i) => subIdx + i);
    return { score: 120 + q.length * 3 - subIdx, indices };
  }
  let last = -1; let score = 0; let seq = 0; const indices = [];
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    const pos = c.indexOf(ch, last + 1);
    if (pos === -1) return { score: -1, indices: [] };
    if (pos === last + 1) { seq++; score += 5; } else { seq = 0; score += 1; }
    indices.push(pos);
    last = pos;
  }
  score += Math.max(0, 20 - (c.indexOf(q[0]) || 0));
  return { score, indices };
}

function acceptSuggestion(idx, opts = {}) {
  clearBannerAction(); // Clear banner action when accepting suggestion
  if (!suggItems[idx]) return;
  const it = suggItems[idx];
  const openInNew = !!opts.openInNew;
  const newIsActive = !!opts.newIsActive;
  if (it.kind === 'active') {
    debugLog('acceptSuggestion -> active', { id: it.id, openInNew, newIsActive });
    hideSuggestions();
    // Ensure settings are closed so the selected webview is shown
    leaveSettingsIfOpen();
    // If opening in new, keep current parked before switching
    if (openInNew) {
      try { parkCurrentAsActive(); } catch {}
    }
    switchToActive(it.id);
    // After action, clear modifiers so suffix doesn't persist
    try { clearHeldModifiersAndSuffix(); } catch {}
    return;
  }
  debugLog('acceptSuggestion -> nav', { value: it.value, openInNew, newIsActive });
  input.value = it.value;
  hideSuggestions();
  navigate({ openInNew, newIsActive });
  // After navigation, clear modifiers immediately
  try { clearHeldModifiersAndSuffix(); } catch {}
}

function renderSuggestions(forceShowActive = false) {
  if (!suggestionsEl || !input) return;
  const raw = String(input.value || '');
  const q = raw.trim();
  const inputFocused = document.activeElement === input;
  const list = loadWhitelist();
  const candidates = Array.from(new Set(list.map((it) => it?.domain).filter(Boolean)));
  
  // Detect if the visible view is an AI Chat thread page
  let inAIChat = false;
  try {
    const v = getVisibleWebView?.();
    const url = v?.getURL?.() || '';
    inAIChat = isAIChatURL(url);
  } catch {}

  let items = [];
  if (!q || forceShowActive) {
    if (!inputFocused && !forceShowActive) { hideSuggestions(); return; }
    // Show active sessions when empty input is focused or when forced
    items = getActiveSuggestions(forceShowActive ? '' : '').map((it) => ({ ...it }));
  } else {
    const scored = candidates
      .map((c) => ({ c, m: fuzzyMatch(q, c) }))
      .filter((it) => it.m.score >= 0)
      .sort((a, b) => b.m.score - a.m.score)
      .slice(0, 8);
    const active = getActiveSuggestions(q).slice(0, 6);

    // In AI chat thread mode: always surface the custom typed terms first,
    // followed by fuzzy domain matches, then any active suggestions.
    if (inAIChat) {
      items = [
        { kind: 'typed', value: q, label: q, typed: true },
        ...scored.map((it) => ({ kind: 'domain', value: it.c, label: it.c, matches: it.m.indices })),
        ...active
      ];
    } else {
      // Default behavior: show active, then typed option (only when URL-like typing), then fuzzy matches
      // Show the custom submit (typed) option when the user is typing a URL-like input:
      // - pressed space after a term (trailing space), e.g. "word "
      // - contains a period (typing a domain), e.g. "google.com", "example."
      const showTyped = raw.endsWith(' ') || raw.includes('.');
      items = [
        ...active,
        ...(showTyped ? [{ kind: 'typed', value: q, label: q, typed: true }] : []),
        ...scored.map((it) => ({ kind: 'domain', value: it.c, label: it.c, matches: it.m.indices }))
      ];
    }
  }
  suggItems = items;
  
  // When a typed option is present, prioritize it for selection
  let initialSelection = 0;
  if (items.length > 0) {
    if (inAIChat) {
      // In AI chat mode, default to the custom typed option (index 0 by construction)
      initialSelection = 0;
    } else {
      const typedIndex = items.findIndex(item => item.typed);
      initialSelection = typedIndex >= 0 ? typedIndex : 0;
    }
  } else {
    initialSelection = -1;
  }
  suggSelected = initialSelection;
  suggestionsEl.innerHTML = '';
  items.forEach((it, idx) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    if (idx === suggSelected) li.classList.add('selected');
    if (it.kind === 'active') {
      const left = document.createElement('div');
      left.className = 'line-left';

      // Prepare display label for active suggestions. When the address bar is focused,
      // show URL without protocol and use Title in the hint instead of "Active (Title)".
      const originalLabel = String(it.label || '');
      let removedPrefix = 0;
      let displayLabel = originalLabel;
      if (inputFocused) {
        if (originalLabel.startsWith('https://')) { displayLabel = originalLabel.slice(8); removedPrefix = 8; }
        else if (originalLabel.startsWith('http://')) { displayLabel = originalLabel.slice(7); removedPrefix = 7; }
      }
      // Adjust highlight indices to the possibly shortened display label
      const labelMatches = Array.isArray(it.matches)
        ? it.matches
            .filter((idx) => idx >= 0 && idx < originalLabel.length)
            .map((idx) => idx - removedPrefix)
            .filter((idx) => idx >= 0)
        : [];

      const strongFrag = renderHighlightedText(displayLabel, labelMatches);
      const hint = document.createElement('span');
      hint.className = 'hint active-hint';
      if (inputFocused) {
        // Desired: "URL -- Title" (using an em dash)
        hint.textContent = it.detail ? `  — ${it.detail}` : '';
      } else {
        hint.textContent = `  — Active  ${it.detail ? `(${it.detail})` : ''}`;
      }
      const suffix = document.createElement('span');
      suffix.className = 'hint open-suffix';
      // placeholder, updated by updateSuggestionOpenSuffix
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'mini-close';
      closeBtn.title = 'Close';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { closeActiveById(it.id); } finally { renderSuggestions(true); }
      });
      left.appendChild(strongFrag);
      left.appendChild(hint);
      left.appendChild(suffix);
      li.appendChild(left);
      li.appendChild(closeBtn);
    } else if (it.typed) {
      const left = document.createElement('div');
      left.className = 'line-left';
      left.textContent = it.label;
      const suffix = document.createElement('span');
      suffix.className = 'hint open-suffix';
      left.appendChild(suffix);
      li.appendChild(left);
    } else {
    const left = document.createElement('div');
    left.className = 'line-left';
    left.appendChild(renderHighlightedText(String(it.label), it.matches));
    const suffix = document.createElement('span');
    suffix.className = 'hint open-suffix';
    left.appendChild(suffix);
    li.appendChild(left);

        // Inline remove "x" for whitelist domain suggestions
        const del = document.createElement('span');
        del.className = 'mini-x';
        del.title = 'Remove from whitelist';
        del.textContent = '×';
        del.addEventListener('mousedown', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const host = String(it.value || it.label || '').toLowerCase();
            const next = loadWhitelist().filter((d) => String(d.domain || '').toLowerCase() !== host);
            await saveWhitelist(next);
            try { if (settingsView && !settingsView.classList.contains('hidden')) renderWhitelist(); } catch {}
            renderSuggestions();
          } catch {}
        });
        li.appendChild(del);
      }
    li.addEventListener('mouseenter', () => { suggSelected = idx; updateSuggestionSelection(); });
    li.addEventListener('mousedown', (e) => { e.preventDefault(); acceptSuggestion(idx, { openInNew: !!e.shiftKey, newIsActive: !!(e.shiftKey && (e.metaKey || e.ctrlKey)) }); });
    suggestionsEl.appendChild(li);
  });
  if (items.length === 0) { hideSuggestions(); return; }
  updateSuggestionsPosition();
  suggestionsEl.classList.remove('hidden');
  try { updateSuggestionOpenSuffix(); } catch {}
}

function startLoadingBar() {
  if (!loadingBar) return;
  try {
    loadingBar.classList.remove('hidden');
    loadingProgress = 0;
    loadingBar.style.width = '0%';
    if (loadingInterval) clearInterval(loadingInterval);
    // Increment progress toward 85% while loading
    loadingInterval = setInterval(() => {
      // Ease towards 85%
      const target = 85;
      const delta = Math.max(0.5, (target - loadingProgress) * 0.06);
      loadingProgress = Math.min(target, loadingProgress + delta);
      loadingBar.style.width = `${loadingProgress}%`;
    }, 120);
    if (indeterminateTimer) clearTimeout(indeterminateTimer);
    indeterminateTimer = setTimeout(() => {
      try {
        if (loadingInterval) { clearInterval(loadingInterval); loadingInterval = null; }
        loadingProgress = Math.max(loadingProgress, 90);
        loadingBar.style.width = `${loadingProgress}%`;
        loadingBar.classList.add('indeterminate');
      } catch {}
    }, 2000);
  } catch {}
}

function finishLoadingBar() {
  if (!loadingBar) return;
  try {
    if (loadingInterval) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }
    if (indeterminateTimer) { clearTimeout(indeterminateTimer); indeterminateTimer = null; }
    loadingBar.classList.remove('indeterminate');
    loadingBar.classList.add('near-done');
    loadingProgress = 100;
    loadingBar.style.width = '100%';
    // Hide after transition
    setTimeout(() => {
      loadingBar.classList.add('hidden');
      loadingBar.classList.remove('near-done');
      loadingBar.style.width = '0%';
      loadingProgress = 0;
    }, 220);
  } catch {}
}

function updateNavButtons() {
  try {
    // While Settings is visible, disable all nav buttons except address bar and settings
    if (settingsView && !settingsView.classList.contains('hidden')) {
      if (navBackBtn) navBackBtn.disabled = true;
      if (navForwardBtn) navForwardBtn.disabled = true;
      if (navRefreshBtn) navRefreshBtn.disabled = true;
            if (extensionsBtn) extensionsBtn.disabled = true;
      return;
    }
    const view = getVisibleWebView();
    const canBack = !!view?.canGoBack?.();
    const canFwd = !!view?.canGoForward?.();
    if (navBackBtn) navBackBtn.disabled = !canBack;
    if (navForwardBtn) navForwardBtn.disabled = !canFwd;
    if (navRefreshBtn) navRefreshBtn.disabled = false;
        if (extensionsBtn) extensionsBtn.disabled = false;
  } catch {
    if (navBackBtn) navBackBtn.disabled = true;
    if (navForwardBtn) navForwardBtn.disabled = true;
  }
}

function updateRefreshButtonUI() {
  if (!navRefreshBtn) return;
  try {
    const view = getVisibleWebView();
    const loading = typeof view?.isLoading === 'function' ? !!view.isLoading() : !!isLoading;
    const url = view?.getURL?.() || '';
    const inAIChat = isAIChatURL(url);
    if (loading) {
      navRefreshBtn.textContent = '⨯';
      navRefreshBtn.classList.add('danger');
      navRefreshBtn.setAttribute('aria-label', 'Stop');
      navRefreshBtn.setAttribute('title', 'Stop (Esc)');
    } else {
      navRefreshBtn.textContent = '⟳';
      navRefreshBtn.classList.remove('danger');
      navRefreshBtn.setAttribute('aria-label', 'Refresh');
      navRefreshBtn.setAttribute('title', 'Refresh (⌘/Ctrl+R)');
    }
  } catch {}
}

function updateActiveCountBubble(flash = false) {
  try {
    if (!activeCountBubble) return;
    // While settings are visible, hide bubble entirely
    if (settingsView && !settingsView.classList.contains('hidden')) { activeCountBubble.classList.add('hidden'); return; }
    const count = activeLocations.size;

    // Style: outline when current location is not an active/persisted session
    try {
      const current = getVisibleWebView();
      const isCurrentActive = !!findActiveIdByWebView(current);
      if (isCurrentActive) {
        activeCountBubble.classList.remove('outline');
      } else {
        activeCountBubble.classList.add('outline');
      }
    } catch {}
    
    if (count > 0) {
      activeCountBubble.textContent = String(count);
      activeCountBubble.classList.remove('hidden');
      
      if (flash) {
        // Flash with a brighter blue
        activeCountBubble.style.backgroundColor = '#2563eb'; // Brighter blue flash
        setTimeout(() => {
          activeCountBubble.style.backgroundColor = ''; // Reset to CSS default
        }, 300);
      }
    } else {
      // Show an outline "0" bubble by default to indicate no active locations yet
      activeCountBubble.textContent = '0';
      activeCountBubble.classList.remove('hidden');
    }
  } catch {}
}


// --- Events wiring ---
wireWebView(primaryWebView);
// Restore any previously persisted active sessions and last visible view
restoreActiveSessionsFromStorage().catch(() => {});

navBackBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  try { const v = getVisibleWebView(); debugLog('navBack click', { id: viewId(v), url: viewURL(v) }); if (v?.canGoBack?.()) v.goBack(); } catch {}
});

navForwardBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  try { const v = getVisibleWebView(); debugLog('navForward click', { id: viewId(v), url: viewURL(v) }); if (v?.canGoForward?.()) v.goForward(); } catch {}
});

navRefreshBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  try {
    const v = getVisibleWebView();
    const loading = typeof v?.isLoading === 'function' ? !!v.isLoading() : !!isLoading;
    debugLog('navRefresh click', { id: viewId(v), url: viewURL(v), loading });
  } catch {}
  // Delegate to unified handler (AI new-thread vs reload/stop)
  refreshOrNewThread({ shiftKey: !!e.shiftKey });
});

newActiveBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  try { clearBannerAction(); } catch {}
  try { hideExtensionsPopover(); } catch {}
  try { hideSuggestions(); } catch {}
  createNewActiveBlankAndSwitch(!!e.shiftKey);
  // After creating a new blank, reset modifiers for next suggestions
  try { clearHeldModifiersAndSuffix(); } catch {}
});


// Input interactions
let __heldShift = false;
let __heldMetaCtrl = false;

// Helper to reset modifier flags and refresh suffix display
function clearHeldModifiersAndSuffix() {
  try {
    __heldShift = false;
    __heldMetaCtrl = false;
    updateSuggestionOpenSuffix();
  } catch {}
}

function openSuffixText() {
  if (!__heldShift) return '';
  return __heldMetaCtrl ? ' + open in a new persistent tab' : ' + open in a new tab';
}

function updateSuggestionOpenSuffix() {
  try {
    if (!suggestionsEl) return;
    // Only show suffixes when the current view has a non-blank destination
    let showSuffix = false;
    try {
      const v = getVisibleWebView?.();
      const url = (v?.getURL?.() || '').trim();
      // Prefer last allowed if current URL is empty (e.g., just created)
      const last = typeof getLastAllowed === 'function' ? (getLastAllowed(v) || '') : '';
      const effective = url || last;
      showSuffix = !!(effective && effective !== 'about:blank');
    } catch {}

    const children = Array.from(suggestionsEl.children);
    const text = showSuffix ? openSuffixText() : '';
    children.forEach((li, idx) => {
      const spans = li.querySelectorAll('.open-suffix');
      spans.forEach((s) => { s.textContent = ''; });
      if (idx === suggSelected && text) {
        const s = li.querySelector('.open-suffix');
        if (s) s.textContent = ` ${text}`;
      }
    });
  } catch {}
}

input.addEventListener('input', () => { 
  clearBannerAction(); // Clear banner action when user types
  renderSuggestions(); 
});
// When the address bar gains focus (via click or keyboard),
// surface active locations if empty; otherwise show typing-based suggestions.
// If focus was triggered via Cmd/Ctrl+L, always show active locations once.
input.addEventListener('focus', () => {
  // Reset modifiers at the start of a new suggestion session
  try { clearHeldModifiersAndSuffix(); } catch {}
  // If focus was caused by a mouse interaction, skip here; the click handler will render once to avoid flicker
  if (typeof __fbFocusByMouseDown !== 'undefined' && __fbFocusByMouseDown) { __fbFocusByMouseDown = false; return; }

  // If the next-focus is flagged (e.g., from Cmd/Ctrl+L), force-show active locations regardless of input value
  if (forceActiveSuggestionsOnNextFocus) {
    try { renderSuggestions(true); } catch {}
    try { forceActiveSuggestionsOnNextFocus = false; } catch {}
    return;
  }

  const hasQuery = !!String(input?.value || '').trim();
  if (hasQuery) {
    renderSuggestions();
  } else {
    renderSuggestions(true);
  }
});
input.addEventListener('click', () => {
  try { hideExtensionsPopover(); } catch {}
  // Fresh click session: prevent stale modifier suffix
  try { clearHeldModifiersAndSuffix(); } catch {}
  // If user clicks the address bar again, reshow active location suggestions
  try { renderSuggestions(true); } catch {}
});

// First-click selects all: on the first mouse click after focus, select-all; subsequent clicks place caret.
let __fbAddressBarSelectedOnce = false;
// Track if focus is from mouse to prevent focus+click double render flicker
let __fbFocusByMouseDown = false;

input.addEventListener('blur', () => {
  try { 
    __fbAddressBarSelectedOnce = false; 
    input?.classList?.add('click-select-armed');
  } catch {}
});

input.addEventListener('mousedown', (e) => {
  try {
    __fbFocusByMouseDown = true;
    if (!__fbAddressBarSelectedOnce) {
      e.preventDefault();
      input.focus();
      input.select?.();
      __fbAddressBarSelectedOnce = true;
      input?.classList?.remove('click-select-armed');
    }
  } catch {}
});

// Active count bubble click: toggle pin/unpin current view and show suggestions.
// Hold a modifier (Meta/Ctrl/Shift/Alt) to only show the suggestions (no toggle).
activeCountBubble?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  try {
    // Treat this as a fresh interaction
    clearHeldModifiersAndSuffix();
    const onlySuggestions = !!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
    if (!onlySuggestions) {
      const current = getVisibleWebView();
      const aid = findActiveIdByWebView(current);
      if (aid) {
        // Unpin: demote to primary without losing content
        const ok = demoteCurrentActiveToPrimary();
        if (ok) {
          updateActiveCountBubble(true);
          try { showBanner('Unpinned current tab'); } catch {}
        }
      } else {
        // Pin: park current as active
        const id = parkCurrentAsActive(true);
        if (id) {
          updateActiveCountBubble(true);
          try { showBanner('Pinned current tab'); } catch {}
        }
      }
    }
    // Always show suggestions after click (reflecting updated list)
    if (input) { input.focus(); renderSuggestions(true); }
  } catch {}
});

input.addEventListener('keydown', (e) => {
  try {
    if (document.activeElement === input) {
      // Reflect real-time state on any keydown; protects against missed keyup
      __heldShift = !!e.shiftKey;
      __heldMetaCtrl = !!(e.metaKey || e.ctrlKey);
      updateSuggestionOpenSuffix();
    }
  } catch {}
  if (e.key === 'Enter') {
    // Cmd+Enter: while on an AI chat thread with "Continue the conversation...", start a fresh chat with the typed message
    try {
      const v = getVisibleWebView();
      const url = v?.getURL?.() || '';
      const onAIChat = isAIChatURL(url);
      const isContinueMode = !!(input && typeof input.placeholder === 'string' && input.placeholder.startsWith('Continue the conversation'));
      if ((e.metaKey || e.ctrlKey) && onAIChat && isContinueMode) {
        e.preventDefault();
        const q = String(stripNewTabSuffix(input?.value) || '').trim();
        if (q) {
          // Drop existing conversation mapping so this becomes a brand-new thread
          try { if (v) conversationByView.delete(v); } catch {}
          currentConversation = null;
          handleAIChat(q, { openInNew: false });
        }
        return;
      }
    } catch {}

    const openInNew = !!e.shiftKey;
    const newIsActive = !!(e.shiftKey && (e.metaKey || e.ctrlKey));
    debugLog('keydown Enter', { openInNew, newIsActive, suggSelected });
    e.preventDefault();
    
    // Check if there's a banner action available for confirmation
    if (currentBannerAction && banner && !banner.classList.contains('hidden')) {
      currentBannerAction();
      return;
    }
    
    if (suggSelected >= 0) {
      acceptSuggestion(suggSelected, { openInNew, newIsActive });
      try { clearHeldModifiersAndSuffix(); } catch {}
    } else {
      navigate({ openInNew, newIsActive });
      try { clearHeldModifiersAndSuffix(); } catch {}
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    clearBannerAction(); // Clear banner action on arrow navigation
    if (!suggestionsEl || suggestionsEl.classList.contains('hidden')) { renderSuggestions(); return; }
    const last = suggItems.length - 1;
    suggSelected = Math.min(last, suggSelected + 1);
    updateSuggestionSelection();
  } else if (e.key === 'ArrowUp') {
    clearBannerAction(); // Clear banner action on arrow navigation
    const min = 0;
    suggSelected = Math.max(min, suggSelected - 1);
    updateSuggestionSelection();
  } else if (e.key === 'Tab') {
    if (suggSelected >= 0) {
      e.preventDefault();
      acceptSuggestion(suggSelected, { shiftKey: e.shiftKey });
    }
  } else if (e.key === 'Backspace' && e.shiftKey) {
    // shift+Backspace: delete selected active location from suggestions
    if (!suggestionsEl || suggestionsEl.classList.contains('hidden')) return;
    if (suggSelected >= 0) {
      const it = suggItems[suggSelected];
      if (it && it.kind === 'active') {
        e.preventDefault();
        try { closeActiveById(it.id); } catch {}
        // Re-render suggestions to reflect removal
        renderSuggestions(true);
      }
    }
  } else if (e.key === 'Escape') {
    clearBannerAction(); // Clear banner action on escape
    hideSuggestions();
  }
});

// Modifier tracking cleanup on keyup/blur
try {
  input.addEventListener('keyup', (e) => {
    try {
      if (e.key === 'Shift') { __heldShift = false; updateSuggestionOpenSuffix(); }
      if (e.key === 'Meta' || e.key === 'Control') { __heldMetaCtrl = false; updateSuggestionOpenSuffix(); }
    } catch {}
  });
  input.addEventListener('blur', () => { try { __heldShift = false; __heldMetaCtrl = false; updateSuggestionOpenSuffix(); } catch {} });
} catch {}

// Window-level keyup as a safety net when input misses events (e.g., webview focus)
try {
  window.addEventListener('keyup', (e) => {
    try {
      if (e.key === 'Shift') { __heldShift = false; updateSuggestionOpenSuffix(); }
      if (e.key === 'Meta' || e.key === 'Control') { __heldMetaCtrl = false; updateSuggestionOpenSuffix(); }
    } catch {}
  });
} catch {}

window.addEventListener('resize', () => {
  if (suggestionsEl && !suggestionsEl.classList.contains('hidden')) {
    updateSuggestionsPosition();
  }
  if (extensionsPopover && !extensionsPopover.classList.contains('hidden')) {
    positionExtensionsPopover();
  }
});

document.addEventListener('click', (e) => {
  if (!suggestionsEl) return;
  const target = e.target;
  if (!(target instanceof Node)) return;
  
  // Clear banner action if clicking outside input and banner
  if (!input.contains(target) && (!banner || !banner.contains(target))) {
    clearBannerAction();
  }
  
  if (suggestionsEl.contains(target) || input.contains(target)) return;
  hideSuggestions();
});

// Hide dropdowns when window loses focus (e.g., clicking webview)
window.addEventListener('blur', () => {
  clearBannerAction(); // Clear banner action when focus leaves window
  hideSuggestions();
  hideExtensionsPopover();
});

form.addEventListener('submit', (e) => {
  // Prevent default; navigation is handled by keydown (Enter) or Go button click
  e.preventDefault();
});


// --- Extensions (uBlock) UI ---
function hideExtensionsPopover() {
  if (extensionsPopover) extensionsPopover.classList.add('hidden');
  extensionsBtn?.classList.remove('active');
}

function positionExtensionsPopover() {
  if (!extensionsPopover || !extensionsBtn) return;
  const content = document.querySelector('.content');
  if (!content) return;
  // Ensure it's visible to measure
  const wasHidden = extensionsPopover.classList.contains('hidden');
  if (wasHidden) extensionsPopover.classList.remove('hidden');
  // Measure
  const bb = extensionsBtn.getBoundingClientRect();
  const cb = content.getBoundingClientRect();
  const pb = extensionsPopover.getBoundingClientRect();
  const desiredLeft = (bb.left + bb.right) / 2 - pb.width / 2; // center under button
  const margin = 8;
  const minLeft = cb.left + margin;
  const maxLeft = cb.right - margin - pb.width;
  const clampedLeft = Math.max(minLeft, Math.min(maxLeft, desiredLeft));
  const top = Math.max(margin, bb.bottom - cb.top + 6);
  extensionsPopover.style.left = `${clampedLeft - cb.left}px`;
  extensionsPopover.style.top = `${top}px`;
  // Optional: if too tall for viewport, nudge up to fit
  const contentHeight = cb.height;
  const pb2 = extensionsPopover.getBoundingClientRect();
  const overflowY = pb2.height + top > contentHeight - margin;
  if (overflowY) {
    const newTop = Math.max(margin, contentHeight - margin - pb2.height);
    extensionsPopover.style.top = `${newTop}px`;
  }
  if (wasHidden) extensionsPopover.classList.add('hidden');
}

function toggleExtensionsPopover() {
  if (!extensionsPopover) return;
  const isHidden = extensionsPopover.classList.contains('hidden');
  if (isHidden) {
    extensionsPopover.classList.remove('hidden');
    positionExtensionsPopover();
    extensionsBtn?.classList.add('active');
  } else {
    extensionsPopover.classList.add('hidden');
    extensionsBtn?.classList.remove('active');
  }
}

async function refreshUboToggle() {
  try {
    // Reflect domain-specific desired state if current page has a domain; else fall back to global
    let desired = null;
    try {
      const v = getVisibleWebView();
      const url = v?.getURL?.() || '';
      if (url && url !== 'about:blank') {
        const h = new URL(url).hostname || '';
        if (h) {
          const d = getRegistrableDomain(h) || h;
          const list = loadAdblockDisabledDomains();
          desired = !list.includes(String(d || '').toLowerCase());
        }
      }
    } catch {}
    if (desired == null) {
      const state = await window.adblock?.getState?.();
      desired = !!state?.enabled;
    }
    if (uboToggle) uboToggle.checked = !!desired;
  } catch {
    if (uboToggle) uboToggle.checked = false;
  }
}

async function refreshDarkToggle() {
  try {
    const stored = await safeGetItem(DARK_MODE_KEY);
    const enabled = String(stored) === 'true';
    darkModeEnabled = enabled;
    if (darkToggle) darkToggle.checked = enabled;
    try { debugLog('dark-toggle refresh', { enabled }); } catch {}
  } catch {
    if (darkToggle) darkToggle.checked = false;
  }
}

extensionsBtn?.addEventListener('click', async (e) => {
  e.preventDefault();
  toggleExtensionsPopover();
  await refreshUboToggle();
  await refreshDarkToggle();
});

uboToggle?.addEventListener('change', async () => {
  try {
    const next = !!uboToggle.checked;

    // Persist per-domain preference: default is ON for all; when switched OFF for a site, remember that domain
    let domain = '';
    try {
      const v = getVisibleWebView();
      const url = v?.getURL?.() || '';
      if (url && url !== 'about:blank') {
        const h = new URL(url).hostname || '';
        const d = getRegistrableDomain(h) || h;
        domain = String(d || '').toLowerCase();
      }
    } catch {}

    if (domain) {
      const list = loadAdblockDisabledDomains();
      if (!next) {
        if (!list.includes(domain)) {
          list.push(domain);
          await saveAdblockDisabledDomains(list);
        }
      } else {
        const filtered = list.filter((d) => d !== domain);
        if (filtered.length !== list.length) {
          await saveAdblockDisabledDomains(filtered);
        }
      }
    }

    await window.adblock?.setEnabled?.(next);
  } catch {}
});

darkToggle?.addEventListener('change', async () => {
  try {
    const next = !!darkToggle.checked;
    darkModeEnabled = next;
    try { debugLog('dark-toggle change', { checked: next }); } catch {}
    await safeSetItem(DARK_MODE_KEY, next ? 'true' : 'false');
    await applyDarkModeToAllWebViews(next);
  } catch {}
});

// Close popover on outside click
document.addEventListener('click', (e) => {
  if (!extensionsPopover || !extensionsBtn) return;
  const target = e.target;
  if (!(target instanceof Node)) return;
  // Don't close if clicking on the popover itself or the extensions button
  if (extensionsPopover.contains(target) || extensionsBtn.contains(target)) return;
  hideExtensionsPopover();
});

// Ensure initial state is synced
refreshUboToggle();
// Initialize dark mode from storage and apply if needed
(async () => { try { await refreshDarkToggle(); if (darkModeEnabled) await applyDarkModeToAllWebViews(true); } catch {} })();
updateNavButtons();
updateRefreshButtonUI();
updateActiveCountBubble();

// Focus on address bar when browser opens
// Use delayed focus to ensure active sessions are loaded and suggestions can appear
function ensureAddressBarFocused() {
  try {
    if (input) {
      input.focus();
      // Trigger suggestions to appear by calling renderSuggestions
      renderSuggestions();
    }
  } catch {}
}

// Initial focus
ensureAddressBarFocused();

// Retry focus a couple times with delays to ensure suggestions appear
setTimeout(ensureAddressBarFocused, 100);
setTimeout(ensureAddressBarFocused, 300);

// Start timer to process pending deletion-rule removals
try { startRemovalPendingTimer(); } catch {}

// Network error logging: show blocked/failed requests similarly to Chrome DevTools
try {
  const mapWCIdToViewId = (wid) => {
    try {
      const views = getAllWebViews();
      for (const v of views) {
        try { if (typeof v.getWebContentsId === 'function' && v.getWebContentsId() === wid) return viewId(v); } catch {}
      }
    } catch {}
    return '(unknown)';
  };
  const hostname = (u) => {
    try { return new URL(String(u || '')).hostname || ''; } catch { return ''; }
  };
  window.devlog?.onNet?.((ev) => {
    try {
      const id = mapWCIdToViewId(ev?.webContentsId);
      const host = hostname(ev?.url);
      const prefix = `[net webview:${id}${host ? ` ${host}` : ''}]`;
      if (ev?.kind === 'error') {
        const method = ev?.method || 'GET';
        const url = ev?.url || '';
        const err = ev?.error || 'net::ERR_UNKNOWN';
        const rtype = ev?.resourceType ? ` ${ev.resourceType}` : '';
        // eslint-disable-next-line no-console
        console.warn(`${prefix}${rtype} ${method} ${url} ${err}`);
      } else if (ev?.kind === 'http-error') {
        const method = ev?.method || 'GET';
        const url = ev?.url || '';
        const code = ev?.statusCode;
        const rtype = ev?.resourceType ? ` ${ev.resourceType}` : '';
        // eslint-disable-next-line no-console
        console.warn(`${prefix}${rtype} ${method} ${url} HTTP ${code}`);
      }
    } catch {}
  });
  // Forward console messages captured in main for completeness
  window.devlog?.onConsole?.((ev) => {
    try {
      const wid = ev?.webContentsId ?? null;
      const level = Number(ev?.level);
      const msg = String(ev?.message || '');
      const line = Number.isFinite(ev?.line) ? ev.line : null;
      const source = ev?.sourceId ? String(ev.sourceId) : '';
      if (wid != null) { if (isConsoleDupe(`${wid}|${source}:${line}|${msg}`)) return; }
      const id = mapWCIdToViewId(wid);
      const host = (() => {
        try {
          const views = getAllWebViews();
          for (const v of views) { if (typeof v.getWebContentsId === 'function' && v.getWebContentsId() === wid) { const u = v.getURL?.() || ''; try { return new URL(u).hostname; } catch { return ''; } } }
        } catch {}
        return '';
      })();
      const prefix = `[webview:${id}${host ? ` ${host}` : ''}]`;
      const src = source || line ? `${source || ''}${line ? `:${line}` : ''}` : '';
      const suffix = src ? ` (${src})` : '';
      const method = (level === 2 || level === 3) ? 'error' : (level === 1 ? 'warn' : 'log');
      // eslint-disable-next-line no-console
      (console[method] || console.log)(`${prefix} ${msg}${suffix}`);
    } catch {}
  });
} catch {}

// --- Find-on-page functionality ---
let findOpen = false;
let findQuery = '';
let findMatches = 0;
let findActive = 0;
let findDebounceTimer = null;
const FIND_DEBOUNCE_MS = 450;

function updateFindUI() {
  try {
    if (!findBar || !findCountEl) return;
    if (!findOpen) {
      findBar.classList.add('hidden');
      findCountEl.textContent = '0/0';
      return;
    }
    findBar.classList.remove('hidden');
    const total = Number(findMatches) || 0;
    const ord = Number(findActive) || (total ? 1 : 0);
    findCountEl.textContent = `${ord}/${total}`;
  } catch {}
}

async function openFindBar() {
  try {
    findOpen = true;
    try { hideSuggestions?.(); } catch {}
    const v = getVisibleWebView();
    // Seed with current selection, if any
    let seed = '';
    try { seed = String(findInput?.value || findQuery || '').trim(); } catch { seed = ''; }
    if (!seed && v && typeof v.executeJavaScript === 'function') {
      try {
        const sel = await v.executeJavaScript('(window.getSelection ? window.getSelection().toString() : "")', true);
        seed = String(sel || '').trim().slice(0, 200);
      } catch {}
    }
    if (findInput) {
      try { findInput.value = seed; } catch {}
      setTimeout(() => { try { findInput.focus(); findInput.select?.(); } catch {} }, 0);
    }
    findQuery = seed;
    if (seed) doFind({ initial: true });
    updateFindUI();
  } catch {}
}

function closeFindBar() {
  try {
    findOpen = false;
    const v = getVisibleWebView();
    try { v?.stopFindInPage?.('clearSelection'); } catch {}
    findQuery = '';
    findMatches = 0;
    findActive = 0;
    updateFindUI();
  } catch {}
}

function doFind(opts = {}) {
  try {
    const v = getVisibleWebView();
    if (!v) return;
    const q = String(findInput?.value ?? findQuery ?? '').trim();
    findQuery = q;
    if (!q) {
      try { v.stopFindInPage?.('clearSelection'); } catch {}
      findMatches = 0;
      findActive = 0;
      updateFindUI();
      return;
    }
    const initial = !!opts.initial;
    const backward = !!opts.backward;
    const options = initial ? { forward: true, findNext: false } : { forward: !backward, findNext: true };
    try { v.findInPage?.(q, options); } catch {}
  } catch {}
}

// Wire find bar UI events
try { findNextBtn?.addEventListener('click', () => { if (findDebounceTimer) { clearTimeout(findDebounceTimer); findDebounceTimer = null; } doFind({}); }); } catch {}
try { findPrevBtn?.addEventListener('click', () => { if (findDebounceTimer) { clearTimeout(findDebounceTimer); findDebounceTimer = null; } doFind({ backward: true }); }); } catch {}
try { findCloseBtn?.addEventListener('click', () => { if (findDebounceTimer) { clearTimeout(findDebounceTimer); findDebounceTimer = null; } closeFindBar(); }); } catch {}
try {
  findInput?.addEventListener('input', () => {
    try {
      if (findDebounceTimer) { clearTimeout(findDebounceTimer); findDebounceTimer = null; }
      const val = String(findInput?.value || '').trim();
      if (!val) {
        // If cleared, immediately clear highlights
        doFind({ initial: true });
        return;
      }
      findDebounceTimer = setTimeout(() => { try { doFind({ initial: true }); } catch {} }, FIND_DEBOUNCE_MS);
    } catch {}
  });
} catch {}
try {
  findInput?.addEventListener('keydown', (e) => {
    try {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (findDebounceTimer) { clearTimeout(findDebounceTimer); findDebounceTimer = null; }
        if (e.shiftKey) doFind({ backward: true }); else doFind({});
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (findDebounceTimer) { clearTimeout(findDebounceTimer); findDebounceTimer = null; }
        closeFindBar();
      }
    } catch {}
  }, true);
} catch {}

// Keyboard shortcuts from main process
try {
  window.nav?.onNavigate?.((action) => {
    // When settings are visible, ignore browsing navigation shortcuts
    const settingsOpen = !!(settingsView && !settingsView.classList.contains('hidden'));
    if (settingsOpen) {
      if (action === 'back' || action === 'forward' || action === 'refresh' || action === 'refresh-shift' || action === 'stop' || action === 'toggle-element-select' || action === 'find-open' || action === 'find-next' || action === 'find-prev') {
        return; // Disable these while in settings
      }
    }
    // If a text input/textarea/contenteditable is focused, ignore back/forward
    try {
      const active = document.activeElement;
      const inText = isFocusableInput?.(active);
      if (inText && (action === 'back' || action === 'forward')) {
        return;
      }
    } catch {}
    switch (action) {
      case 'back':
        try { const v = getVisibleWebView(); if (v?.canGoBack?.()) v.goBack(); } catch {}
        break;
      case 'forward':
        try { const v = getVisibleWebView(); if (v?.canGoForward?.()) v.goForward(); } catch {}
        break;
      case 'refresh-shift':
        try { refreshOrNewThread({ shiftToActive: true }); } catch {}
        break;
      case 'refresh':
        try { refreshOrNewThread(); } catch {}
        break;
      case 'stop':
        try {
          const v = getVisibleWebView();
          const loading = typeof v?.isLoading === 'function' ? !!v.isLoading() : !!isLoading;
          if (loading) v?.stop?.();
        } catch {}
        break;
      case 'toggle-element-select':
        try { toggleElementSelectMode(); } catch {}
        break;
      case 'exit-element-select':
        try { applySelectionMode(false); } catch {}
        break;
      case 'focus-address':
        try {
          // Ensure that after focusing, we show ALL active locations (unfiltered)
          forceActiveSuggestionsOnNextFocus = true;
          // Reset modifiers so suffix does not reflect stale state
          try { clearHeldModifiersAndSuffix(); } catch {}
          input?.focus?.();
          input?.select?.();
          __fbAddressBarSelectedOnce = true;
          input?.classList?.remove('click-select-armed');
          renderSuggestions(true); // Force show active locations
        } catch {}
        break;
      case 'find-open':
        try { openFindBar(); } catch {}
        break;
      case 'find-next':
        try { if (!findOpen) openFindBar(); doFind({}); } catch {}
        break;
      case 'find-prev':
        try { if (!findOpen) openFindBar(); doFind({ backward: true }); } catch {}
        break;
      case 'new-blank-active':
        try { createNewActiveBlankAndSwitch(true); } catch {}
        break;
      case 'new-blank':
        try { createNewActiveBlankAndSwitch(false); } catch {}
        break;
      default:
        break;
    }
  });
} catch {}

// Handle webview window.open/target=_blank routed from main (setWindowOpenHandler)
try {
  window.nav?.onOpenURL?.((msg) => {
    try {
      const url = msg?.url || '';
      const wid = msg?.webContentsId;
      const disposition = msg?.disposition || '';
      if (!url) return;
      const views = getAllWebViews();
      let target = null;
      for (const v of views) {
        try { if (typeof v.getWebContentsId === 'function' && v.getWebContentsId() === wid) { target = v; break; } } catch {}
      }
      // Fallback to visible webview if mapping fails
      if (!target) target = getVisibleWebView();
      if (!isUrlAllowed(url)) {
        showBlockedWithAdd(url);
        return;
      }
      // If Shift+Click triggered a new-window disposition, park current and open in primary view
      if (disposition === 'new-window') {
        try { parkCurrentAsActive(true); } catch {}
        const primary = ensurePrimaryWebView();
        setLastAllowed(primary, url);
        try { primary.setAttribute('src', url); } catch { primary.src = url; }
        closeSettingsOnLoad(primary);
        switchToWebView(primary);
        return;
      }
      // Default: load in the originating webview
      try { target.setAttribute('src', url); } catch { target.src = url; }
    } catch {}
  });
} catch {}

// ESC key closes settings when settings screen is open
(function setupSettingsEscClose() {
  function handler(e) {
    try {
      if (e.key !== 'Escape') return;
      if (!settingsView || settingsView.classList.contains('hidden')) return;
      // Close settings (same as clicking the back button)
      e.preventDefault();
      e.stopPropagation();
      leaveSettingsIfOpen();
    } catch {}
  }
  document.addEventListener('keydown', handler, true);
})();
