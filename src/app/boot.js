export function resolveAppElements(documentRef = document) {
  return {
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
