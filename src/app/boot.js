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
