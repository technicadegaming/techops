const MIN_VISIBLE_MS = 300;

function ensureUiState(state) {
  state.ui = {
    ...(state.ui || {}),
    globalBusy: {
      active: false,
      title: '',
      detail: '',
      startedAt: '',
      blocking: true,
      ...((state.ui && state.ui.globalBusy) || {})
    }
  };
}

export function createGlobalBusyHelpers(state, render) {
  ensureUiState(state);

  function setGlobalBusy(title = 'Working…', detail = 'This can take a few seconds. Please do not refresh.', options = {}) {
    ensureUiState(state);
    state.ui.globalBusy = {
      active: true,
      title,
      detail,
      startedAt: new Date().toISOString(),
      blocking: options.blocking !== false
    };
    render();
  }

  async function clearGlobalBusy() {
    ensureUiState(state);
    const startedAtMs = Date.parse(state.ui.globalBusy?.startedAt || '') || Date.now();
    const elapsed = Date.now() - startedAtMs;
    if (elapsed < MIN_VISIBLE_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_MS - elapsed));
    }
    state.ui.globalBusy = {
      ...(state.ui.globalBusy || {}),
      active: false,
      title: '',
      detail: '',
      startedAt: ''
    };
    render();
  }

  async function withGlobalBusy(title, detail, asyncFn, options = {}) {
    setGlobalBusy(title, detail, options);
    try {
      return await asyncFn();
    } finally {
      await clearGlobalBusy();
    }
  }

  return { setGlobalBusy, clearGlobalBusy, withGlobalBusy };
}

export function renderGlobalBusyOverlay(state = {}) {
  const busy = state.ui?.globalBusy || {};
  if (!busy.active) return '';
  return `<div class="global-busy-overlay" role="status" aria-live="polite" aria-busy="true">
    <div class="global-busy-card">
      <div class="global-busy-spinner" aria-hidden="true"></div>
      <h3>${busy.title || 'Working…'}</h3>
      <p>${busy.detail || 'This can take a few seconds. Please do not refresh.'}</p>
    </div>
  </div>`;
}
