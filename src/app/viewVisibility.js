export function setRootViewVisibility({ authView, appView, showAuth }) {
  const shouldShowAuth = !!showAuth;
  authView?.classList.toggle('hide', !shouldShowAuth);
  appView?.classList.toggle('hide', shouldShowAuth);
}

