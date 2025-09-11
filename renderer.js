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

function normalizeToURL(input) {
  const trimmed = (input || '').trim();
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
          input.value = `AI: ${titleMatch[1]}`;
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
const settingsBtn = document.getElementById('settings-button');
const backBtn = document.getElementById('back-button');
const navBackBtn = document.getElementById('nav-back-button');
const navForwardBtn = document.getElementById('nav-forward-button');
const navRefreshBtn = document.getElementById('nav-refresh-button');
const loadingBar = document.getElementById('loading-bar');
const suggestionsEl = document.getElementById('address-suggestions');
const closeActiveBtn = document.getElementById('close-active-button');
const activeCountBubble = document.getElementById('active-count-bubble');
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

// Track last successfully allowed URL per webview to keep the user in place on block
function getLastAllowed(el) { return el?._lastAllowedURL || 'about:blank'; }
function setLastAllowed(el, url) { if (el) el._lastAllowedURL = url || 'about:blank'; }
setLastAllowed(primaryWebView, 'about:blank');

// Storage keys
const WL_KEY = 'whitelist';
const DELAY_KEY = 'whitelist_delay_minutes';
const DELAY_PENDING_MIN_KEY = 'whitelist_delay_pending_minutes';
const DELAY_PENDING_AT_KEY = 'whitelist_delay_pending_activate_at';
const SORT_MODE_KEY = 'wl_sort_mode_v1'; // 'recent' | 'abc'

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

// AI conversation tracking
let currentConversation = null; // { messages: [], webview: element }

function resetConversationIfNeeded(webview, newURL) {
  // Reset conversation when navigating away from AI chat
  if (currentConversation && currentConversation.webview === webview) {
    const isAIChat = newURL && newURL.startsWith('data:text/html') && 
                     (newURL.includes('AI%20Chat') || newURL.includes('AI Chat'));
    if (!isAIChat) {
      debugLog('resetting conversation', { id: viewId(webview), newURL });
      currentConversation = null;
      // Reset address bar placeholder
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
        if (m && m[1]) return String(m[1]).trim();
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
      } else {
        // Default behavior: reset this webview in-place
        setLastAllowed(v, dataURL);
        try { v?.setAttribute?.('src', dataURL); } catch { try { v.src = dataURL; } catch {} }
      }

      // Focus and clear the address bar so user can type the initial term(s)
      try {
        if (input) {
          input.value = '';
          input.focus();
          input.select?.();
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
  if (effective === 0) {
    // Immediate effect, no countdown
    await setEffectiveDelayMinutes(next);
    await clearPendingDelay();
    return { immediate: true };
  }
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
    // Show "Settings" in the address bar while settings are open
    try { if (input) input.value = 'Settings'; } catch {}
    // Disable nav arrows while in settings
    try { updateNavButtons(); } catch {}
  } else {
    settingsView.classList.add('hidden');
    // restore only current visible view
    getVisibleWebView()?.classList.remove('hidden');
    try { settingsBtn?.classList.remove('active'); } catch {}
    // Restore address bar to current view URL
    try { const v = getVisibleWebView(); const url = v?.getURL?.() || ''; updateAddressBarWithURL(url); } catch {}
    try { updateNavButtons(); } catch {}
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
const llmTab = document.getElementById('llm-tab');
const whitelistContent = document.getElementById('whitelist-content');
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
    // Make sure we're on the whitelist tab when opening settings
    switchToTab('whitelist');
    renderWhitelist();
    initDelayControls?.();
    startCountdown();
    try { autosizeDomainInput(); } catch {}
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

// Cmd/Ctrl+Enter submits the Add Domain form while settings are visible
(function setupSubmitShortcut() {
  function handler(e) {
    if (!(e.key === 'Enter' && (e.metaKey || e.ctrlKey))) return;
    if (!settingsView || settingsView.classList.contains('hidden')) return;
    const active = document.activeElement;
    // Only trigger when focus is within settings (e.g., list or textarea)
    if (!settingsView.contains(active)) return;
    // If focused element is another input/textarea and isn't our domainInput, ignore
    if (active && active !== domainInput && isFocusableInput(active)) return;
    const hasText = String(domainInput?.value || '').trim().length > 0;
    if (!hasText) return;
    e.preventDefault();
    if (typeof addDomainForm?.requestSubmit === 'function') {
      addDomainForm.requestSubmit();
    } else {
      const evt = new Event('submit', { cancelable: true, bubbles: true });
      addDomainForm?.dispatchEvent(evt);
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
  const tabs = [whitelistTab, llmTab];
  const contents = [whitelistContent, llmContent];
  
  tabs.forEach(tab => tab?.classList.remove('active'));
  contents.forEach(content => content?.classList.remove('active'));
  
  if (tabName === 'llm') {
    llmTab?.classList.add('active');
    llmContent?.classList.add('active');
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
      if (!url) continue;
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

  // Hide suggestions when interacting with this webview
  el.addEventListener('focus', () => { hideSuggestions(); });
  // pointerdown handler removed (handled globally)

  // Update address bar when navigation occurs
  el.addEventListener('did-navigate', (e) => {
    debugLog('did-navigate', { id: viewId(el), url: e.url });
    
    // Reset conversation if navigating away from AI chat
    resetConversationIfNeeded(el, e.url);
    
    if (el === getVisibleWebView()) {
      updateAddressBarWithURL(e.url);
    }
    if (e.url && isUrlAllowed(e.url)) {
      setLastAllowed(el, e.url);
    }
    // If this el belongs to an active session, update its record and persist
    try {
      const aid = findActiveIdByWebView(el);
      if (aid && activeLocations.has(aid)) {
        const rec = activeLocations.get(aid);
        rec.url = e.url || rec.url;
        try {
          if (isAIChatURL(e.url || el.getURL?.() || '')) {
            rec.title = getAIChatInitialQueryFromWebView(el) || rec.title || '';
          } else {
            rec.title = el.getTitle?.() || rec.title || '';
          }
        } catch {}
        persistActiveSessions().catch(() => {});
      }
    } catch {}
    updateNavButtons();
    updateRefreshButtonUI();
    updateCloseButtonUI();
    finishLoadingBar();
  });
  el.addEventListener('did-navigate-in-page', (e) => {
    debugLog('did-navigate-in-page', { id: viewId(el), url: e.url });
    if (el === getVisibleWebView()) {
      updateAddressBarWithURL(e.url);
    }
    if (e.url && isUrlAllowed(e.url)) {
      setLastAllowed(el, e.url);
    }
    // Update persisted active session if applicable
    try {
      const aid = findActiveIdByWebView(el);
      if (aid && activeLocations.has(aid)) {
        const rec = activeLocations.get(aid);
        rec.url = e.url || rec.url;
        try {
          if (isAIChatURL(e.url || el.getURL?.() || '')) {
            rec.title = getAIChatInitialQueryFromWebView(el) || rec.title || '';
          } else {
            rec.title = el.getTitle?.() || rec.title || '';
          }
        } catch {}
        persistActiveSessions().catch(() => {});
      }
    } catch {}
    updateNavButtons();
    updateRefreshButtonUI();
    updateCloseButtonUI();
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
          rec.url = current || rec.url;
          try {
            if (isAIChatURL(current || el.getURL?.() || '')) {
              rec.title = getAIChatInitialQueryFromWebView(el) || rec.title || '';
            } else {
              rec.title = el.getTitle?.() || rec.title || '';
            }
          } catch {}
          persistActiveSessions().catch(() => {});
        }
      } catch {}
    } catch {}
    updateNavButtons();
    updateRefreshButtonUI();
    updateCloseButtonUI();
    finishLoadingBar();
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
  });
  el.addEventListener('did-fail-load', (e) => {
    debugLog('did-fail-load', { id: viewId(el), code: e?.errorCode, url: e?.validatedURL });
    if (el === getVisibleWebView()) {
      isLoading = false;
      updateRefreshButtonUI();
      finishLoadingBar();
    }
  });
}

function ensurePrimaryWebView() {
  // Ensure we have a primary ephemeral webview with id 'webview'
  let el = document.getElementById('webview');
  if (!el) {
    el = document.createElement('webview');
    el.id = 'webview';
    // Do not preset src here; caller will set the destination to avoid flashing about:blank
    el.setAttribute('disableblinkfeatures', 'AutomationControlled');
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

function switchToWebView(el) {
  if (!el) return;
  debugLog('switchToWebView', { from: viewId(currentVisibleView), to: viewId(el), fromURL: viewURL(currentVisibleView), toURL: viewURL(el) });
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
  updateCloseButtonUI();
  try {
    const url = el.getURL?.() || '';
    updateAddressBarWithURL(url);
  } catch {}
  // Persist which view is visible
  persistVisibleViewFor(el).catch(() => {});
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
  
  // Update bubble count and close button UI
  updateActiveCountBubble(flashUI);
  updateCloseButtonUI();
  
  // Flash the close button to indicate the change (when triggered by Shift+Enter)
  if (flashUI && closeActiveBtn) {
    closeActiveBtn.style.backgroundColor = '#2563eb';
    setTimeout(() => {
      closeActiveBtn.style.backgroundColor = '';
    }, 300);
  }
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
      updateCloseButtonUI();
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

function getActiveSuggestions(q) {
  const items = [];
  const query = String(q || '').trim();
  const currentActiveId = findActiveIdByWebView(currentVisibleView);
  
  for (const [, rec] of activeLocations) {
    // Skip the currently active/visible location
    if (rec.id === currentActiveId) continue;
    
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
    items.push({ kind: 'active', id: rec.id, label, detail, score: query ? m.score : 9999, matches: m.indices });
  }
  items.sort((a, b) => b.score - a.score);
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
  const target = normalizeToURL(input.value);
  debugLog('navigate()', { targetRaw: input.value, target, shift: !!opts.shiftKey });
  if (!target) { debugLog('navigate: invalid target'); return; }
  
  // Handle AI Chat URLs BEFORE whitelist check
  if (target.startsWith('ai-chat://query/')) {
    const query = decodeURIComponent(target.replace('ai-chat://query/', ''));
    handleAIChat(query, opts);
    return;
  }
  
  if (!isUrlAllowed(target)) {
    debugLog('navigate: blocked by whitelist', { target });
    showBlockedWithAdd(target);
    return;
  }
  const shiftKey = !!opts.shiftKey;
  const current = getVisibleWebView();
  debugLog('navigate: branch', { shiftKey, currentId: viewId(current), currentURL: viewURL(current) });
  if (shiftKey) {
    // Park current (if not already active) and navigate in a primary ephemeral view
    parkCurrentAsActive();
    const primary = ensurePrimaryWebView();
    // Set destination first, then switch to avoid lingering on about:blank
    // Prime fallback so a blocked redirect won’t revert to about:blank
    setLastAllowed(primary, target);
    debugLog('set src (shift)', { id: viewId(primary), target });
    try { primary.setAttribute('src', target); } catch { primary.src = target; }
    // Defer closing settings until load completes
    closeSettingsOnLoad(primary);
    // Watchdog: check after 1200ms (debug only)
    if (DEBUG) {
      setTimeout(() => {
        debugLog('watchdog (shift): after set src', { id: viewId(primary), url: viewURL(primary), isLoading: !!primary?.isLoading?.() });
      }, 1200);
    }
    switchToWebView(primary);
  } else {
    // If currently viewing an active location, navigate away in primary view; else reuse current
    let dest = current;
    let mustSwitch = false;
    for (const [, rec] of activeLocations) {
      if (rec.webview === current) { mustSwitch = true; break; }
    }
    if (mustSwitch) {
      dest = ensurePrimaryWebView();
      // Set destination first, keep current view visible until load completes
      setLastAllowed(dest, target);
      debugLog('set src (leave-active, preloading)', { id: viewId(dest), target });
      try { dest.setAttribute('src', target); } catch { dest.src = target; }
      // Start top loading bar while staying on current active view
      try { isLoading = true; updateRefreshButtonUI(); startLoadingBar(); } catch {}
      // Only reveal the new webview when it finishes loading
      const onDone = () => {
        try {
          debugLog('preload complete, switching', { id: viewId(dest), url: viewURL(dest) });
          switchToWebView(dest);
          // Now that the destination is ready, close settings (if open)
          leaveSettingsIfOpen();
        } finally {
          isLoading = false; updateRefreshButtonUI(); finishLoadingBar();
        }
      };
      const onFail = (e) => {
        try {
          debugLog('preload failed; staying on current', { id: viewId(dest), code: e?.errorCode, url: e?.validatedURL });
          // Keep current view; show banner if needed
          // Loading completed (failed); close settings if they were open
          leaveSettingsIfOpen();
        } finally {
          isLoading = false; updateRefreshButtonUI(); finishLoadingBar();
        }
      };
      dest.addEventListener('did-stop-loading', onDone, { once: true });
      dest.addEventListener('did-fail-load', onFail, { once: true });
    } else {
      setLastAllowed(dest, target);
      debugLog('set src (reuse)', { id: viewId(dest), target });
      try { dest.setAttribute('src', target); } catch { dest.src = target; }
      // Defer closing settings until load completes
      closeSettingsOnLoad(dest);
      if (DEBUG) {
        setTimeout(() => {
          debugLog('watchdog (reuse): after set src', { id: viewId(dest), url: viewURL(dest), isLoading: !!dest?.isLoading?.() });
        }, 1200);
      }
    }
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
  if (it.kind === 'active') {
    debugLog('acceptSuggestion -> active', { id: it.id, shift: !!opts.shiftKey });
    hideSuggestions();
    // Ensure settings are closed so the selected webview is shown
    leaveSettingsIfOpen();
    // If Shift is held, park the current view before switching to an existing active one
    if (opts && opts.shiftKey) {
      try { parkCurrentAsActive(); } catch {}
    }
    switchToActive(it.id);
    return;
  }
  debugLog('acceptSuggestion -> nav', { value: it.value, shift: !!opts.shiftKey });
  input.value = it.value;
  hideSuggestions();
  navigate({ shiftKey: !!opts.shiftKey });
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
      const strongFrag = renderHighlightedText(String(it.label), it.matches);
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = `  — Active  ${it.detail ? `(${it.detail})` : ''}`;
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
      li.appendChild(left);
      li.appendChild(closeBtn);
    } else if (it.typed) {
      const left = document.createElement('div');
      left.className = 'line-left';
      left.textContent = it.label;
      li.appendChild(left);
    } else {
      const left = document.createElement('div');
      left.className = 'line-left';
      left.appendChild(renderHighlightedText(String(it.label), it.matches));
      li.appendChild(left);
    }
    li.addEventListener('mouseenter', () => { suggSelected = idx; updateSuggestionSelection(); });
    li.addEventListener('mousedown', (e) => { e.preventDefault(); acceptSuggestion(idx, { shiftKey: e.shiftKey }); });
    suggestionsEl.appendChild(li);
  });
  if (items.length === 0) { hideSuggestions(); return; }
  updateSuggestionsPosition();
  suggestionsEl.classList.remove('hidden');
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
      if (closeActiveBtn) closeActiveBtn.disabled = true;
      if (extensionsBtn) extensionsBtn.disabled = true;
      return;
    }
    const view = getVisibleWebView();
    const canBack = !!view?.canGoBack?.();
    const canFwd = !!view?.canGoForward?.();
    if (navBackBtn) navBackBtn.disabled = !canBack;
    if (navForwardBtn) navForwardBtn.disabled = !canFwd;
    if (navRefreshBtn) navRefreshBtn.disabled = false;
    if (closeActiveBtn) closeActiveBtn.disabled = false;
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
    const count = activeLocations.size;
    
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
      activeCountBubble.classList.add('hidden');
    }
  } catch {}
}

function updateCloseButtonUI() {
  try {
    const view = getVisibleWebView();
    const aid = findActiveIdByWebView(view);
    const currentURL = view?.getURL?.() || '';
    const isBlankPage = currentURL === 'about:blank' || currentURL === '';
    
    if (closeActiveBtn) {
      // Always show; toggle label and a11y based on active state
      closeActiveBtn.classList.remove('hidden');
      if (aid) {
        closeActiveBtn.textContent = '✕';
        closeActiveBtn.classList.remove('danger');
        closeActiveBtn.setAttribute('aria-label', 'Close active session');
        closeActiveBtn.setAttribute('title', 'Close active session');
        closeActiveBtn.disabled = false;
      } else {
        closeActiveBtn.textContent = '+';
        closeActiveBtn.classList.remove('danger');
        closeActiveBtn.setAttribute('aria-label', 'Add as active session');
        closeActiveBtn.setAttribute('title', 'Add as active session');
        closeActiveBtn.disabled = isBlankPage;
      }
    }
    
    updateActiveCountBubble();
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

closeActiveBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  try {
    const v = getVisibleWebView();
    const aid = findActiveIdByWebView(v);
    debugLog('closeActiveBtn click', { id: viewId(v), url: viewURL(v), aid });
    if (aid) {
      closeCurrentActive();
    } else {
      const parked = parkCurrentAsActive();
      debugLog('park via plus button', { parked });
      updateCloseButtonUI();
    }
  } catch {}
});

// Input interactions
input.addEventListener('input', () => { 
  clearBannerAction(); // Clear banner action when user types
  renderSuggestions(); 
});
input.addEventListener('focus', () => { renderSuggestions(); });
input.addEventListener('click', () => { hideExtensionsPopover(); });

// Active count bubble click - show active locations in suggestions
activeCountBubble?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  try {
    // Focus input and trigger suggestions showing active locations
    if (input) {
      input.focus();
      renderSuggestions(true); // Force show active locations
    }
  } catch {}
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    debugLog('keydown Enter', { shift: !!e.shiftKey, suggSelected });
    e.preventDefault();
    
    // Check if there's a banner action available for confirmation
    if (currentBannerAction && banner && !banner.classList.contains('hidden')) {
      currentBannerAction();
      return;
    }
    
    // If Shift is held, just park the current view and don't navigate
    if (e.shiftKey) {
      try { 
        parkCurrentAsActive(true); // Flash the UI when triggered by Shift+Enter
        // Return early - no navigation
        return;
      } catch {}
    }
    
    if (suggSelected >= 0) {
      acceptSuggestion(suggSelected, { shiftKey: e.shiftKey });
    } else {
      navigate({ shiftKey: e.shiftKey });
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
    const state = await window.adblock?.getState?.();
    const enabled = !!state?.enabled;
    if (uboToggle) uboToggle.checked = enabled;
  } catch {
    if (uboToggle) uboToggle.checked = false;
  }
}

extensionsBtn?.addEventListener('click', async (e) => {
  e.preventDefault();
  toggleExtensionsPopover();
  await refreshUboToggle();
});

uboToggle?.addEventListener('change', async () => {
  try {
    const next = !!uboToggle.checked;
    await window.adblock?.setEnabled?.(next);
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
updateNavButtons();
updateRefreshButtonUI();
updateCloseButtonUI();
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


// Keyboard shortcuts from main process
try {
  window.nav?.onNavigate?.((action) => {
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
      case 'focus-address':
        try {
          input?.focus?.();
          input?.select?.();
          renderSuggestions(true); // Force show active locations
        } catch {}
        break;
      default:
        break;
    }
  });
} catch {}
