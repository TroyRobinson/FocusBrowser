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
const webview = document.getElementById('webview');

function navigate() {
  const target = normalizeToURL(input.value);
  if (target) {
    webview.src = target;
  }
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

