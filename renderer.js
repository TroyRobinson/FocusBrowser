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

// Track last successfully allowed URL to keep the user in place on block
let lastAllowedURL = 'about:blank';

// Whitelist storage
const WL_KEY = 'whitelist';

function loadWhitelist() {
  try {
    const raw = localStorage.getItem(WL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // normalize to lower-case hostnames
    return parsed
      .map((d) => String(d || '').trim().toLowerCase())
      .filter((d) => d.length > 0);
  } catch {
    return [];
  }
}

function saveWhitelist(list) {
  const dedup = Array.from(new Set(list.map((d) => d.trim().toLowerCase())));
  localStorage.setItem(WL_KEY, JSON.stringify(dedup));
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

function isHostAllowed(hostname) {
  if (!hostname) return false;
  const list = loadWhitelist();
  const host = hostname.toLowerCase();
  return list.some((d) => host === d || host.endsWith(`.${d}`));
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
    showActionBanner(
      `Blocked: ${host} is not in whitelist.`,
      `Add ${root}`,
      () => {
        const wl = loadWhitelist();
        if (!wl.includes(root)) {
          wl.push(root);
          saveWhitelist(wl);
          renderWhitelist();
          showBanner(`Added ${root} to whitelist`);
        } else {
          showBanner(`${root} already whitelisted`);
        }
      },
      'error',
      8000
    );
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

function renderWhitelist() {
  if (!domainList) return;
  const list = loadWhitelist();
  domainList.innerHTML = '';
  if (list.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No domains added yet.';
    domainList.appendChild(li);
    return;
  }
  list.forEach((domain) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'domain';
    span.textContent = domain;
    const btn = document.createElement('button');
    btn.className = 'remove';
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => {
      const next = loadWhitelist().filter((d) => d !== domain);
      saveWhitelist(next);
      renderWhitelist();
    });
    li.appendChild(span);
    li.appendChild(btn);
    domainList.appendChild(li);
  });
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
    if (wl.includes(host)) {
      showBanner('Domain already in whitelist');
    } else {
      wl.push(host);
      saveWhitelist(wl);
      renderWhitelist();
      showBanner(`Added ${host} to whitelist`);
      domainInput.value = '';
    }
  });
}

settingsBtn?.addEventListener('click', () => {
  setSettingsVisible(true);
  renderWhitelist();
});

backBtn?.addEventListener('click', () => {
  setSettingsVisible(false);
});

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
