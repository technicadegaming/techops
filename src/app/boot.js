const REQUIRED_APP_ELEMENT_IDS = [
  'authView',
  'appView',
  'authMessage',
  'activeCompanySwitcher',
  'activeLocationSwitcher',
  'locationScopeBadge',
  'notificationBell',
  'notificationBadge',
  'notificationPanel'
];

export function resolveAppElements(documentRef = document) {
  const elements = {
    authView: documentRef.getElementById('authView'),
    appView: documentRef.getElementById('appView'),
    authMessage: documentRef.getElementById('authMessage'),
    activeCompanySwitcher: documentRef.getElementById('activeCompanySwitcher'),
    activeLocationSwitcher: documentRef.getElementById('activeLocationSwitcher'),
    locationScopeBadge: documentRef.getElementById('locationScopeBadge'),
    notificationBell: documentRef.getElementById('notificationBell'),
    notificationBadge: documentRef.getElementById('notificationBadge'),
    notificationPanel: documentRef.getElementById('notificationPanel')
  };

  const missing = REQUIRED_APP_ELEMENT_IDS.filter((id) => !elements[id]);
  if (missing.length) {
    throw new Error(`App bootstrap failed: missing required root DOM elements (${missing.join(', ')}). Verify index.html is being served at the site root for GitHub Pages deployment.`);
  }

  return elements;
}

export function getAuthInviteCodeValue(documentRef = document) {
  const input = documentRef.getElementById('authInviteCode');
  return `${input?.value || ''}`.trim();
}

export function syncPendingInviteCode(state, documentRef = document) {
  const inviteCode = getAuthInviteCodeValue(documentRef);
  state.onboardingUi = { ...(state.onboardingUi || {}), inviteCodePrefill: inviteCode };
}

export function hydrateInviteCodeFromRoute(state, locationRef = window.location, documentRef = document) {
  const params = new URLSearchParams(locationRef.search || '');
  const inviteCode = `${params.get('invite') || params.get('inviteCode') || ''}`.trim();
  if (!inviteCode) return;
  const input = documentRef.getElementById('authInviteCode');
  if (input && !input.value) input.value = inviteCode;
  state.onboardingUi = { ...(state.onboardingUi || {}), inviteCodePrefill: inviteCode };
}
