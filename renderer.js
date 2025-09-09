function normalizeToURL(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

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

const form = document.getElementById('address-form');
const input = document.getElementById('address-input');
const goBtn = document.getElementById('go-button');
const settingsBtn = document.getElementById('settings-button');
const backBtn = document.getElementById('back-button');
const navBackBtn = document.getElementById('nav-back-button');
const navForwardBtn = document.getElementById('nav-forward-button');
const navRefreshBtn = document.getElementById('nav-refresh-button');
const loadingBar = document.getElementById('loading-bar');
const suggestionsEl = document.getElementById('address-suggestions');
let isLoading = false;
let loadingInterval = null;
let loadingProgress = 0; // 0..100
let indeterminateTimer = null;
const settingsView = document.getElementById('settings-view');
// Primary (ephemeral) webview always uses id "webview"; active sessions get their own webviews
let primaryWebView = document.getElementById('webview');
let currentVisibleView = primaryWebView; // track which webview is currently shown

// --- Debug logging ---
const DEBUG = false;
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

// Whitelist storage
const WL_KEY = 'whitelist';
const DELAY_KEY = 'whitelist_delay_minutes';
const DELAY_PENDING_MIN_KEY = 'whitelist_delay_pending_minutes';
const DELAY_PENDING_AT_KEY = 'whitelist_delay_pending_activate_at';

// Active sessions persistence
const ACTIVE_SESSIONS_KEY = 'active_sessions_v1';
const VISIBLE_VIEW_KEY = 'visible_view_v1';

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

function saveWhitelist(list) {
  const map = new Map();
  for (const it of list) {
    if (!it || !it.domain) continue;
    const domain = String(it.domain).trim().toLowerCase();
    const at = Number(it.activateAt || 0);
    const norm = { domain, activateAt: Number.isFinite(at) ? at : 0 };
    const ex = map.get(domain);
    if (!ex || norm.activateAt < ex.activateAt) map.set(domain, norm);
  }
  localStorage.setItem(WL_KEY, JSON.stringify(Array.from(map.values())));
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

function clearPendingDelay() {
  localStorage.removeItem(DELAY_PENDING_MIN_KEY);
  localStorage.removeItem(DELAY_PENDING_AT_KEY);
}

function setEffectiveDelayMinutes(n) {
  const v = sanitizeDelay(n);
  localStorage.setItem(DELAY_KEY, String(v));
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

function getDelayMinutes() {
  // Returns the current effective delay; promotes pending if due.
  promotePendingIfDue();
  const raw = localStorage.getItem(DELAY_KEY);
  return sanitizeDelay(raw);
}

function schedulePendingDelay(newMinutes) {
  const effective = getDelayMinutes();
  const next = sanitizeDelay(newMinutes);
  if (effective === 0) {
    // Immediate effect, no countdown
    setEffectiveDelayMinutes(next);
    clearPendingDelay();
    return { immediate: true };
  }
  const activateAt = Date.now() + effective * 60 * 1000;
  localStorage.setItem(DELAY_PENDING_MIN_KEY, String(next));
  localStorage.setItem(DELAY_PENDING_AT_KEY, String(activateAt));
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
    if (u.hostname) return isHostAllowed(u.hostname);
    return false;
  } catch {
    return false;
  }
}

let bannerTimeout = null;
function clearBanner() {
  if (!banner) return;
  banner.classList.add('hidden');
  banner.textContent = '';
  banner.classList.remove('error');
  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = null;
}

function showBanner(message, kind = '', durationMs = 2600) {
  if (!banner) return;
  banner.classList.remove('hidden', 'error');
  if (kind) banner.classList.add(kind);
  banner.textContent = '';
  const span = document.createElement('span');
  span.textContent = message;
  banner.appendChild(span);
  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    banner.classList.add('hidden');
  }, durationMs);
}

function showActionBanner(message, actionLabel, onAction, kind = '', durationMs = 6000) {
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
  btn.addEventListener('click', () => {
    try { onAction?.(); } finally { clearBanner(); }
  });
  banner.appendChild(span);
  banner.appendChild(btn);
  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    banner.classList.add('hidden');
  }, durationMs);
}

function showBlockedWithAdd(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    const root = getRegistrableDomain(host);
    const wl = loadWhitelist();
    const pending = wl.find((it) => (host === it.domain || host.endsWith(`.${it.domain}`)) && !isActive(it));
    if (pending) {
      const remaining = Math.max(0, (pending.activateAt || 0) - Date.now());
      const label = fmtRemaining(remaining) || 'Less than 1s';
      showBanner(`${label} left until active`, 'error', 8000);
    } else {
      showActionBanner(
        `Blocked: ${host} is not in whitelist.`,
        `Add ${root}`,
        () => addDomainWithDelay(root),
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
  } else {
    settingsView.classList.add('hidden');
    // restore only current visible view
    getVisibleWebView()?.classList.remove('hidden');
  }
}

// Settings UI wiring
const addDomainForm = document.getElementById('add-domain-form');
const domainInput = document.getElementById('domain-input');
const domainList = document.getElementById('domain-list');

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
  }, 1000);
}
function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function renderWhitelist() {
  if (!domainList) return;
  const list = loadWhitelist();
  domainList.innerHTML = '';
  if (list.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No domains added yet.';
    domainList.appendChild(li);
  } else {
    list.forEach((item) => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.className = 'domain';
      left.textContent = item.domain;

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
      btn.addEventListener('click', () => {
        const next = loadWhitelist().filter((d) => d.domain !== item.domain);
        saveWhitelist(next);
        renderWhitelist();
      });
      right.appendChild(btn);

      li.appendChild(left);
      li.appendChild(right);
      domainList.appendChild(li);
    });
  }

  // Countdown interval is managed by settings open/close.
}

if (addDomainForm) {
  addDomainForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const host = extractHostname(domainInput.value);
    if (!host) {
      showBanner('Enter a valid domain (e.g., example.com)', 'error');
      return;
    }
    const wl = loadWhitelist();
    if (wl.some((it) => it.domain === host)) {
      showBanner('Domain already in whitelist');
    } else {
      const delayMin = getDelayMinutes();
      const activateAt = delayMin > 0 ? Date.now() + delayMin * 60 * 1000 : 0;
      wl.push({ domain: host, activateAt });
      saveWhitelist(wl);
      renderWhitelist();
      if (delayMin > 0) {
        showBanner(`Added ${host}. Activates in ${delayMin} min`);
      } else {
        showBanner(`Added ${host} to whitelist`);
      }
      domainInput.value = '';
    }
  });
}

settingsBtn?.addEventListener('click', () => {
  setSettingsVisible(true);
  renderWhitelist();
  initDelayControls?.();
  startCountdown();
});

backBtn?.addEventListener('click', () => {
  setSettingsVisible(false);
  stopCountdown();
});

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

delayInput?.addEventListener('input', () => {
  delayInputDirty = true;
  updateSaveButtonState();
});

delaySaveBtn?.addEventListener('click', () => {
  if (!delayInput) return;
  const pending = getPendingDelay();
  if (pending && delayCancelHover) {
    // Cancel pending change
    clearPendingDelay();
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
  const result = schedulePendingDelay(next);
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

function addDomainWithDelay(host) {
  const wl = loadWhitelist();
  if (wl.some((it) => it.domain === host)) {
    showBanner(`${host} already whitelisted`);
    return;
  }
  const delayMin = getDelayMinutes();
  const activateAt = delayMin > 0 ? Date.now() + delayMin * 60 * 1000 : 0;
  wl.push({ domain: host, activateAt });
  saveWhitelist(wl);
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

// Persistence helpers for active sessions
function persistActiveSessions() {
  try {
    const arr = [];
    for (const [id, rec] of activeLocations) {
      const url = (rec?.webview?.getURL?.() || rec?.url || '').trim();
      const title = String(rec?.title || '');
      if (!url) continue;
      arr.push({ id: String(id), url, title });
    }
    localStorage.setItem(ACTIVE_SESSIONS_KEY, JSON.stringify(arr));
  } catch {}
}

function loadActiveSessions() {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSIONS_KEY);
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

function persistVisibleViewFor(el) {
  try {
    let data = { kind: 'primary' };
    // Primary is only when this is the ephemeral primary with id 'webview'
    if (!(el === primaryWebView && el?.id === 'webview')) {
      const id = findActiveIdByWebView(el);
      if (id) data = { kind: 'active', id: String(id) };
    }
    localStorage.setItem(VISIBLE_VIEW_KEY, JSON.stringify(data));
  } catch {}
}

function loadVisibleView() {
  try {
    const raw = localStorage.getItem(VISIBLE_VIEW_KEY);
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

function restoreActiveSessionsFromStorage() {
  try {
    const list = loadActiveSessions();
    if (!Array.isArray(list) || list.length === 0) {
      // Still initialize visible view key to current primary
      persistVisibleViewFor(getVisibleWebView());
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

    // Restore last visible
    const vv = loadVisibleView();
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
  el.addEventListener('pointerdown', () => { hideSuggestions(); });

  // Update address bar when navigation occurs
  el.addEventListener('did-navigate', (e) => {
    debugLog('did-navigate', { id: viewId(el), url: e.url });
    if (el === getVisibleWebView()) {
      input.value = e.url || input.value;
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
        try { rec.title = el.getTitle?.() || rec.title || ''; } catch {}
        persistActiveSessions();
      }
    } catch {}
    updateNavButtons();
    updateRefreshButtonUI();
    finishLoadingBar();
  });
  el.addEventListener('did-navigate-in-page', (e) => {
    debugLog('did-navigate-in-page', { id: viewId(el), url: e.url });
    if (el === getVisibleWebView()) {
      input.value = e.url || input.value;
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
        try { rec.title = el.getTitle?.() || rec.title || ''; } catch {}
        persistActiveSessions();
      }
    } catch {}
    updateNavButtons();
    updateRefreshButtonUI();
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
          try { rec.title = el.getTitle?.() || rec.title || ''; } catch {}
          persistActiveSessions();
        }
      } catch {}
    } catch {}
    updateNavButtons();
    updateRefreshButtonUI();
    finishLoadingBar();
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
  updateNavButtons();
  updateRefreshButtonUI();
  try {
    const url = el.getURL?.() || '';
    if (url) input.value = url;
  } catch {}
  // Persist which view is visible
  try { persistVisibleViewFor(el); } catch {}
}

function parkCurrentAsActive() {
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
  activeLocations.set(id, { id, title: '', url: currentURL, webview: el });
  debugLog('parkCurrentAsActive: created', { id, viewId: viewId(el), url: currentURL });
  // Try to update title asynchronously
  setTimeout(() => {
    try {
      const rec = activeLocations.get(id);
      if (rec) rec.title = el.getTitle?.() || '';
      persistActiveSessions();
    } catch {}
  }, 0);
  // Persist after creation
  try { persistActiveSessions(); } catch {}
  return id;
}

function switchToActive(id) {
  const rec = activeLocations.get(String(id));
  if (!rec) { debugLog('switchToActive: not found', { id }); return; }
  debugLog('switchToActive', { id, viewId: viewId(rec.webview), url: viewURL(rec.webview) });
  switchToWebView(rec.webview);
}

function getActiveSuggestions(q) {
  const items = [];
  const query = String(q || '').trim();
  for (const [, rec] of activeLocations) {
    // Build a display label using title or hostname
    const url = rec.webview?.getURL?.() || rec.url || '';
    let label = rec.title || '';
    if (!label) {
      try { label = new URL(url).hostname; } catch { label = url; }
    }
    const matchBase = `${label} ${url}`.trim();
    const m = fuzzyMatch(query, matchBase);
    if (query && m.score < 0) continue;
    items.push({ kind: 'active', id: rec.id, label, detail: url, score: query ? m.score : 9999, matches: m.indices });
  }
  items.sort((a, b) => b.score - a.score);
  return items;
}

function navigate(opts = {}) {
  const target = normalizeToURL(input.value);
  debugLog('navigate()', { targetRaw: input.value, target, shift: !!opts.shiftKey });
  if (!target) { debugLog('navigate: invalid target'); return; }
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
        } finally {
          isLoading = false; updateRefreshButtonUI(); finishLoadingBar();
        }
      };
      const onFail = (e) => {
        try {
          debugLog('preload failed; staying on current', { id: viewId(dest), code: e?.errorCode, url: e?.validatedURL });
          // Keep current view; show banner if needed
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
  if (!suggItems[idx]) return;
  const it = suggItems[idx];
  if (it.kind === 'active') {
    debugLog('acceptSuggestion -> active', { id: it.id });
    hideSuggestions();
    switchToActive(it.id);
    return;
  }
  debugLog('acceptSuggestion -> nav', { value: it.value, shift: !!opts.shiftKey });
  input.value = it.value;
  hideSuggestions();
  navigate({ shiftKey: !!opts.shiftKey });
}

function renderSuggestions() {
  if (!suggestionsEl || !input) return;
  const raw = String(input.value || '');
  const q = raw.trim();
  if (!q) { hideSuggestions(); return; }
  const list = loadWhitelist();
  const candidates = Array.from(new Set(list.map((it) => it?.domain).filter(Boolean)));
  const scored = candidates
    .map((c) => ({ c, m: fuzzyMatch(q, c) }))
    .filter((it) => it.m.score >= 0)
    .sort((a, b) => b.m.score - a.m.score)
    .slice(0, 8);
  const active = getActiveSuggestions(q).slice(0, 6);

  // Only show the custom submit (typed) option when the user has either:
  // - pressed space after a term (trailing space), e.g. "word "
  // - added a period after a term (trailing period), e.g. "word."
  const showTyped = raw.endsWith(' ') || raw.endsWith('.');

  const items = [
    ...active,
    ...(showTyped ? [{ kind: 'typed', value: q, label: q, typed: true }] : []),
    ...scored.map((it) => ({ kind: 'domain', value: it.c, label: it.c, matches: it.m.indices }))
  ];
  suggItems = items;
  suggSelected = items.length > 0 ? 0 : -1;
  suggestionsEl.innerHTML = '';
  items.forEach((it, idx) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    if (idx === suggSelected) li.classList.add('selected');
    if (it.kind === 'active') {
      const line = document.createElement('div');
      const strongFrag = renderHighlightedText(String(it.label), it.matches);
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = `  — Active  ${it.detail ? `(${it.detail})` : ''}`;
      line.appendChild(strongFrag);
      line.appendChild(hint);
      li.appendChild(line);
    } else if (it.typed) {
      li.textContent = it.label;
    } else {
      li.innerHTML = '';
      li.appendChild(renderHighlightedText(String(it.label), it.matches));
    }
    li.addEventListener('mouseenter', () => { suggSelected = idx; updateSuggestionSelection(); });
    li.addEventListener('mousedown', (e) => { e.preventDefault(); acceptSuggestion(idx, { shiftKey: e.shiftKey }); });
    suggestionsEl.appendChild(li);
  });
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
    const view = getVisibleWebView();
    const canBack = !!view?.canGoBack?.();
    const canFwd = !!view?.canGoForward?.();
    if (navBackBtn) navBackBtn.disabled = !canBack;
    if (navForwardBtn) navForwardBtn.disabled = !canFwd;
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

// --- Events wiring ---
wireWebView(primaryWebView);
// Restore any previously persisted active sessions and last visible view
try { restoreActiveSessionsFromStorage(); } catch {}

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
    if (loading) {
      v?.stop?.();
    } else {
      v?.reload?.();
    }
  } catch {}
});

// Input interactions
input.addEventListener('input', () => { renderSuggestions(); });

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    debugLog('keydown Enter', { shift: !!e.shiftKey, suggSelected });
    e.preventDefault();
    if (suggSelected >= 0) {
      acceptSuggestion(suggSelected, { shiftKey: e.shiftKey });
    } else {
      navigate({ shiftKey: e.shiftKey });
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    if (!suggestionsEl || suggestionsEl.classList.contains('hidden')) { renderSuggestions(); return; }
    const last = suggItems.length - 1;
    suggSelected = Math.min(last, suggSelected + 1);
    updateSuggestionSelection();
  } else if (e.key === 'ArrowUp') {
    const min = 0;
    suggSelected = Math.max(min, suggSelected - 1);
    updateSuggestionSelection();
  } else if (e.key === 'Tab') {
    if (suggSelected >= 0) {
      e.preventDefault();
      acceptSuggestion(suggSelected, { shiftKey: e.shiftKey });
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

window.addEventListener('resize', () => {
  if (!suggestionsEl || suggestionsEl.classList.contains('hidden')) return;
  updateSuggestionsPosition();
});

document.addEventListener('click', (e) => {
  if (!suggestionsEl) return;
  const target = e.target;
  if (!(target instanceof Node)) return;
  if (suggestionsEl.contains(target) || input.contains(target)) return;
  hideSuggestions();
});

// Also hide suggestions when any webview is interacted with
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if (t && t.tagName && String(t.tagName).toLowerCase() === 'webview') hideSuggestions();
}, true);

form.addEventListener('submit', (e) => {
  // Prevent default; navigation is handled by keydown (Enter) or Go button click
  e.preventDefault();
});

goBtn.addEventListener('click', (e) => {
  e.preventDefault();
  debugLog('Go click', { shift: !!e.shiftKey });
  navigate({ shiftKey: !!e.shiftKey });
});

// --- Extensions (uBlock) UI ---
function hideExtensionsPopover() {
  if (extensionsPopover) extensionsPopover.classList.add('hidden');
}

function toggleExtensionsPopover() {
  if (!extensionsPopover) return;
  const isHidden = extensionsPopover.classList.contains('hidden');
  if (isHidden) {
    extensionsPopover.classList.remove('hidden');
  } else {
    extensionsPopover.classList.add('hidden');
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
  if (extensionsPopover.contains(target) || extensionsBtn.contains(target)) return;
  hideExtensionsPopover();
});

// Ensure initial state is synced
refreshUboToggle();
updateNavButtons();
updateRefreshButtonUI();

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
      case 'refresh':
        try { getVisibleWebView()?.reload?.(); } catch {}
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
        } catch {}
        break;
      default:
        break;
    }
  });
} catch {}
