export function createNotificationController({
  state,
  elements,
  buildNotificationCandidates,
  formatRelativeTime,
  withRequiredCompanyId,
  upsertEntity,
  refreshData,
  render,
  openTab,
  pushRouteState,
  applyActionCenterFocus,
  setAdminSection = (value) => {
    state.adminSection = value;
  },
  documentRef = document
}) {
  const { notificationBell, notificationBadge, notificationPanel } = elements;

  function getNotificationTypeLabel(type = '') {
    return `${type || ''}`.replaceAll('_', ' ').trim() || 'notification';
  }

  function getEnabledNotificationTypes() {
    const explicit = state.notificationPrefs?.enabledTypes;
    if (Array.isArray(explicit) && explicit.length) return new Set(explicit);
    return null;
  }

  function applyNotificationPreferences(items = []) {
    const enabled = getEnabledNotificationTypes();
    if (!enabled) return items;
    return items.filter((item) => enabled.has(item.type));
  }

  async function syncNotifications() {
    if (!state.company?.id || !state.user?.uid) {
      state.notifications = [];
      return;
    }
    const existingByKey = new Map((state.notifications || []).map((item) => [item.eventKey, item]));
    const candidates = applyNotificationPreferences(buildNotificationCandidates(state));
    const nowIso = new Date().toISOString();

    for (const candidate of candidates) {
      const current = existingByKey.get(candidate.eventKey);
      if (!current) {
        await upsertEntity('notifications', candidate.id, withRequiredCompanyId({
          ...candidate,
          userId: state.user.uid,
          readAt: null,
          dismissedAt: null,
          status: 'active',
          createdAtClient: nowIso,
          updatedAtClient: nowIso
        }, 'create notification'));
        continue;
      }
      if (current.status === 'dismissed') continue;
      const shouldRefreshUnread = !!candidate.happenedAt && `${candidate.happenedAt}` !== `${current.happenedAt || ''}`;
      await upsertEntity('notifications', current.id, withRequiredCompanyId({
        ...current,
        title: candidate.title,
        body: candidate.body,
        level: candidate.level,
        action: candidate.action,
        happenedAt: candidate.happenedAt,
        type: candidate.type,
        eventKey: candidate.eventKey,
        status: 'active',
        readAt: shouldRefreshUnread ? null : (current.readAt || null),
        updatedAtClient: nowIso
      }, 'update notification'));
    }
  }

  function unreadNotificationCount() {
    return (state.notifications || []).filter((item) => item.status !== 'dismissed' && !item.readAt).length;
  }

  async function markNotificationRead(notificationId) {
    const notification = (state.notifications || []).find((entry) => entry.id === notificationId);
    if (!notification || notification.readAt) return;
    await upsertEntity('notifications', notification.id, withRequiredCompanyId({
      ...notification,
      readAt: new Date().toISOString(),
      updatedAtClient: new Date().toISOString()
    }, 'mark notification read'));
    await refreshData();
    render();
  }

  async function dismissNotification(notificationId) {
    const notification = (state.notifications || []).find((entry) => entry.id === notificationId);
    if (!notification) return;
    await upsertEntity('notifications', notification.id, withRequiredCompanyId({
      ...notification,
      dismissedAt: new Date().toISOString(),
      status: 'dismissed',
      updatedAtClient: new Date().toISOString()
    }, 'dismiss notification'));
    await refreshData();
    render();
  }

  async function markAllNotificationsRead() {
    const unread = (state.notifications || []).filter((entry) => entry.status !== 'dismissed' && !entry.readAt);
    for (const notification of unread) {
      await upsertEntity('notifications', notification.id, withRequiredCompanyId({
        ...notification,
        readAt: new Date().toISOString(),
        updatedAtClient: new Date().toISOString()
      }, 'mark all notifications read'));
    }
    await refreshData();
    render();
  }

  function routeFromNotificationAction(action = {}) {
    return {
      tab: action.tab || state.route.tab || 'dashboard',
      taskId: action.taskId || null,
      assetId: action.assetId || null,
      locationKey: state.route.locationKey || null,
      pmFilter: action.pmFilter || null
    };
  }

  async function openNotification(notificationId) {
    const notification = (state.notifications || []).find((entry) => entry.id === notificationId);
    if (!notification) return;
    await markNotificationRead(notificationId);
    if (notification.action?.adminSection) setAdminSection(notification.action.adminSection);
    const nextRoute = routeFromNotificationAction(notification.action || {});
    state.route = { ...state.route, ...nextRoute };
    pushRouteState(state.route);
    if (notification.action?.focus) applyActionCenterFocus(notification.action.focus);
    openTab(nextRoute.tab, nextRoute.taskId, nextRoute.assetId);
    hideNotificationPanel();
  }

  function renderNotificationCenter() {
    if (!notificationBell || !notificationBadge || !notificationPanel) return;
    const visible = (state.notifications || [])
      .filter((entry) => entry.status !== 'dismissed' && entry.userId === state.user?.uid)
      .sort((a, b) => `${b.happenedAt || b.updatedAt || ''}`.localeCompare(`${a.happenedAt || a.updatedAt || ''}`))
      .slice(0, 30);
    const unread = unreadNotificationCount();
    notificationBadge.textContent = unread > 9 ? '9+' : `${unread}`;
    notificationBadge.classList.toggle('hide', unread === 0);
    notificationBell.setAttribute('aria-label', `Notifications (${unread} unread)`);

    if (!visible.length) {
      notificationPanel.innerHTML = `<div class="item"><b>Notifications</b><div class="tiny mt">No notifications yet. You're all caught up.</div></div>`;
      return;
    }

    notificationPanel.innerHTML = `
      <div class="item row space">
        <b>Action center</b>
        <button type="button" data-notif-read-all>Mark all read</button>
      </div>
      <div class="list mt">${visible.map((entry) => `
        <div class="item ${entry.readAt ? '' : 'selected'}">
          <div class="row space"><b>${entry.title || getNotificationTypeLabel(entry.type)}</b><span class="tiny">${formatRelativeTime(entry.happenedAt || entry.updatedAt)}</span></div>
          <div class="tiny mt">${entry.body || ''}</div>
          <div class="row mt">
            <button type="button" data-notif-open="${entry.id}">Open</button>
            ${entry.readAt ? '' : `<button type="button" data-notif-read="${entry.id}">Mark read</button>`}
            <button type="button" data-notif-dismiss="${entry.id}">Dismiss</button>
          </div>
        </div>
      `).join('')}</div>
    `;

    notificationPanel.querySelector('[data-notif-read-all]')?.addEventListener('click', () => { markAllNotificationsRead(); });
    notificationPanel.querySelectorAll('[data-notif-open]').forEach((button) => button.addEventListener('click', () => { openNotification(button.dataset.notifOpen); }));
    notificationPanel.querySelectorAll('[data-notif-read]').forEach((button) => button.addEventListener('click', () => { markNotificationRead(button.dataset.notifRead); }));
    notificationPanel.querySelectorAll('[data-notif-dismiss]').forEach((button) => button.addEventListener('click', () => { dismissNotification(button.dataset.notifDismiss); }));
  }

  function hideNotificationPanel() {
    notificationPanel?.classList.add('hide');
  }

  function resetNotifications() {
    state.notifications = [];
    hideNotificationPanel();
  }

  function bindNotificationUi() {
    if (!notificationBell || !notificationPanel) return;
    notificationBell.addEventListener('click', () => {
      notificationPanel.classList.toggle('hide');
    });
    documentRef.addEventListener('click', (event) => {
      if (notificationPanel.classList.contains('hide')) return;
      if (notificationPanel.contains(event.target) || notificationBell.contains(event.target)) return;
      notificationPanel.classList.add('hide');
    });
  }

  return {
    bindNotificationUi,
    hideNotificationPanel,
    renderNotificationCenter,
    resetNotifications,
    syncNotifications
  };
}
