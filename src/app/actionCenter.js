export function applyActionCenterFocus(state, focus) {
  if (focus === 'priority' || focus === 'critical') {
    state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', exceptionFilter: 'priority' };
    return { routeChanged: false };
  }
  if (focus === 'blocked') {
    state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', exceptionFilter: 'blocked' };
    return { routeChanged: false };
  }
  if (focus === 'followup') {
    state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', ownershipFilter: 'followup' };
    return { routeChanged: false };
  }
  if (focus === 'unassigned') {
    state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', ownershipFilter: 'unassigned' };
    return { routeChanged: false };
  }
  if (focus === 'overdue_open') {
    state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', exceptionFilter: 'overdue' };
    return { routeChanged: false };
  }
  if (focus === 'overdue_pm') {
    state.route = { ...(state.route || {}), pmFilter: 'overdue' };
    return { routeChanged: true };
  }
  if (focus === 'due_soon_pm') {
    state.route = { ...(state.route || {}), pmFilter: 'due_soon' };
    return { routeChanged: true };
  }
  return { routeChanged: false };
}

export function applyShellFocus(state, focus, { setAdminSection } = {}) {
  const result = applyActionCenterFocus(state, focus);
  if (focus === 'pending_invites') {
    setAdminSection?.('people');
    return { routeChanged: false };
  }
  if (focus === 'missing_docs') {
    state.route = { ...(state.route || {}), assetFilter: 'missing_docs' };
    return { routeChanged: true };
  }
  return result;
}
