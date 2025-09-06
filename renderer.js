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
function showBanner(message, kind = '') {
  if (!banner) return;
  banner.textContent = message;
  banner.classList.remove('hidden', 'error');
  if (kind) banner.classList.add(kind);
  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    banner.classList.add('hidden');
  }, 2600);
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
    showBanner('Blocked: domain not in whitelist', 'error');
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
});
webview?.addEventListener('did-navigate-in-page', (e) => {
  input.value = e.url || input.value;
});

// Enforce whitelist on navigations triggered inside webview
webview?.addEventListener('will-navigate', (e) => {
  if (!isUrlAllowed(e.url)) {
    e.preventDefault();
    showBanner('Blocked: domain not in whitelist', 'error');
  }
});

webview?.addEventListener('will-redirect', (e) => {
  if (!isUrlAllowed(e.url)) {
    e.preventDefault();
    showBanner('Blocked: redirect to non-whitelisted domain', 'error');
  }
});

webview?.addEventListener('new-window', (e) => {
  // Open allowed targets in same webview; block others
  e.preventDefault();
  if (isUrlAllowed(e.url)) {
    webview.src = e.url;
  } else {
    showBanner('Blocked: popup not in whitelist', 'error');
  }
});

// If initial src is not allowed, ensure we stay on about:blank
webview?.addEventListener('dom-ready', () => {
  try {
    const current = webview.getURL?.() || '';
    if (current && current !== 'about:blank' && !isUrlAllowed(current)) {
      webview.src = 'about:blank';
      showBanner('Blocked initial page: not in whitelist', 'error');
    }
  } catch {
    // ignore
  }
});
