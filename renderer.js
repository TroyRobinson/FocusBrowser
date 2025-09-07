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
const settingsView = document.getElementById('settings-view');
const webview = document.getElementById('webview');
const banner = document.getElementById('banner');
const delayInput = document.getElementById('delay-input');
const delaySaveBtn = document.getElementById('delay-save-button');
const delayCountdownEl = document.getElementById('delay-countdown');
const extensionsBtn = document.getElementById('extensions-button');
const extensionsPopover = document.getElementById('extensions-popover');
const uboToggle = document.getElementById('ubo-toggle');

// Track last successfully allowed URL to keep the user in place on block
let lastAllowedURL = 'about:blank';

// Whitelist storage
const WL_KEY = 'whitelist';
const DELAY_KEY = 'whitelist_delay_minutes';
const DELAY_PENDING_MIN_KEY = 'whitelist_delay_pending_minutes';
const DELAY_PENDING_AT_KEY = 'whitelist_delay_pending_activate_at';

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
    // Allow about:blank and data URLs only if explicitly whitelisted? Keep simple: block non-http(s) unless whitelisted hostname exists.
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
  if (!settingsView || !webview) return;
  if (visible) {
    settingsView.classList.remove('hidden');
    webview.classList.add('hidden');
  } else {
    settingsView.classList.add('hidden');
    webview.classList.remove('hidden');
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
  delayInputDirty = false;
  if (delayInput) delayInput.value = String(getDelayMinutes());
  renderDelayControls();
  updateSaveButtonState();
});

delaySaveBtn?.addEventListener('mouseenter', () => {
  if (getPendingDelay()) {
    delayCancelHover = true;
    renderDelayControls();
  }
});

delaySaveBtn?.addEventListener('mouseleave', () => {
  if (delayCancelHover) {
    delayCancelHover = false;
    renderDelayControls();
  }
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

function navigate() {
  const target = normalizeToURL(input.value);
  if (!target) return;
  if (!isUrlAllowed(target)) {
    // Keep current page unchanged; offer to add domain
    showBlockedWithAdd(target);
    return;
  }
  webview.src = target;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  navigate();
});

goBtn.addEventListener('click', (e) => {
  e.preventDefault();
  navigate();
});

// Update address bar when navigation occurs
webview?.addEventListener('did-navigate', (e) => {
  input.value = e.url || input.value;
  if (e.url && isUrlAllowed(e.url)) {
    lastAllowedURL = e.url;
  }
});
webview?.addEventListener('did-navigate-in-page', (e) => {
  input.value = e.url || input.value;
  if (e.url && isUrlAllowed(e.url)) {
    lastAllowedURL = e.url;
  }
});

// Enforce whitelist on navigations triggered inside webview
webview?.addEventListener('will-navigate', (e) => {
  if (!isUrlAllowed(e.url)) {
    e.preventDefault();
    // Keep current page; offer to add domain
    showBlockedWithAdd(e.url);
  }
});

webview?.addEventListener('will-redirect', (e) => {
  if (!isUrlAllowed(e.url)) {
    e.preventDefault();
    showBlockedWithAdd(e.url);
  }
});

webview?.addEventListener('new-window', (e) => {
  // Open allowed targets in same webview; block others
  e.preventDefault();
  if (isUrlAllowed(e.url)) {
    webview.src = e.url;
  } else {
    showBlockedWithAdd(e.url);
  }
});

// Fallback: ensure initial load respects whitelist but keep current page unchanged
webview?.addEventListener('dom-ready', () => {
  try {
    const current = webview.getURL?.() || '';
    if (current && current !== 'about:blank' && !isUrlAllowed(current)) {
      // Keep as-is, only inform and offer to add
      showBlockedWithAdd(current);
    }
  } catch {
    // ignore
  }
});

// Fallback guard: if a navigation manages to start, stop and revert to last allowed
webview?.addEventListener('did-start-navigation', (e) => {
  try {
    const { url, isMainFrame } = e;
    if (!isMainFrame) return;
    if (url && !isUrlAllowed(url)) {
      webview.stop();
      if (lastAllowedURL && webview.getURL?.() !== lastAllowedURL) {
        webview.src = lastAllowedURL;
      }
      showBlockedWithAdd(url);
    }
  } catch {
    // ignore
  }
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
