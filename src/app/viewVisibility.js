export function setRootViewVisibility({ authView, appView, showAuth }) {
  const shouldShowAuth = !!showAuth;
  authView?.classList.toggle('hide', !shouldShowAuth);
  appView?.classList.toggle('hide', shouldShowAuth);
}

export function setAppChromeVisibility({
  headerEl,
  tabsEl,
  companySwitcherEl,
  locationSwitcherEl,
  locationScopeBadgeEl,
  notificationBellEl,
  notificationPanelEl,
  logoutButtonEl,
  companyLogoEl,
  showChrome,
}) {
  const shouldShowChrome = !!showChrome;
  headerEl?.classList.toggle('hide', !shouldShowChrome);
  tabsEl?.classList.toggle('hide', !shouldShowChrome);
  companySwitcherEl?.classList.toggle('hide', !shouldShowChrome);
  locationSwitcherEl?.classList.toggle('hide', !shouldShowChrome);
  locationScopeBadgeEl?.classList.toggle('hide', !shouldShowChrome);
  notificationBellEl?.classList.toggle('hide', !shouldShowChrome);
  notificationPanelEl?.classList.add('hide');
  logoutButtonEl?.classList.toggle('hide', !shouldShowChrome);
  companyLogoEl?.classList.toggle('hide', !shouldShowChrome);
}
