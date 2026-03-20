import {
  login,
  loginWithGoogle,
  logout,
  refreshAuthUser,
  register,
  resendVerificationEmail,
  resolveProfile,
  sendForgotPasswordEmail,
  syncSecuritySnapshot,
  watchAuth
} from './auth.js';
import {
  clearEntitySet,
  deleteEntity,
  getEntity,
  listEntities,
  saveAppSettings,
  setActiveCompanyContext,
  upsertEntity
} from './data.js';
import { renderDashboard } from './features/dashboard.js';
import { renderOperations } from './features/operations.js';
import { renderAssets } from './features/assets.js';
import { renderCalendar } from './features/calendar.js';
import { renderReports } from './features/reports.js';
import { renderAdmin } from './admin.js';
import { renderOnboarding } from './onboarding.js';
import { formatActionError, runActionFactory } from './uiActions.js';
import { buildPermissionContext, canDelete, isAdmin, isManager } from './roles.js';
import {
  buildAssetsCsv,
  buildAuditCsv,
  buildCompanyBackupBundle,
  buildInvitesCsv,
  buildLocationsCsv,
  buildMembersCsv,
  buildTasksCsv,
  buildWorkersCsv,
  exportBackupJson
} from './backup.js';
import {
  analyzeTaskTroubleshooting,
  answerTaskFollowup,
  approveAssetManual,
  enrichAssetDocumentation,
  previewAssetDocumentationLookup,
  regenerateTaskTroubleshooting,
  saveTaskFixToTroubleshootingLibrary
} from './aiAdapter.js';
import { buildCloseoutEvent, parseRouteState, pushRouteState } from './features/workflow.js';
import { buildNotificationCandidates, formatRelativeTime } from './features/notifications.js';
import { acceptInvite, createCompanyFromOnboarding, createCompanyInvite, revokeInvite } from './company.js';
import { buildLocationOptions, getLocationSelection, getLocationScopeLabel } from './features/locationContext.js';
import { createOperationsActions } from './features/operationsActions.js';
import { createAssetActions } from './features/assetActions.js';
import { createAdminActions } from './features/adminActions.js';
import { getWorkspaceReadiness } from './features/workspaceReadiness.js';
import { parseAssetCsv, parseBulkAssetList, normalizeAssetCandidate } from './features/assetIntake.js';
import { logAudit } from './audit.js';
import { renderAccount } from './account.js';
import { storage } from './firebase.js';
import { buildCompanyEvidencePath } from './storagePaths.js';
import { hydrateInviteCodeFromRoute, resolveAppElements, syncPendingInviteCode } from './app/boot.js';
import { reportActionError, withRequiredCompanyId } from './app/actions.js';
import {
  bootstrapCompanyContext as bootstrapCompanyContextState,
  refreshData as refreshAppData,
  setActiveMembership as setActiveMembershipState
} from './app/dataRefresh.js';
import {
  deleteObject,
  getDownloadURL,
  ref as storageRef,
  uploadBytes
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js';
import { buildTabs as buildTabsUi, openTab as openTabUi } from './app/router.js';
import {
  buildPreviewQueryKey,
  createEmptyAssetDraft,
  createInitialState,
  sections,
  setOnboardingFeedback,
  setSetupWizardFeedback,
  syncSetupWizardState
} from './app/state.js';

const {
  authView,
  appView,
  authMessage,
  activeCompanySwitcher,
  activeLocationSwitcher,
  locationScopeBadge,
  notificationBell,
  notificationBadge,
  notificationPanel
} = resolveAppElements(document);
const state = createInitialState();

function isPermissionRelatedError(error) {
  const code = `${error?.code || ''}`.toLowerCase();
  const message = `${error?.message || error || ''}`.toLowerCase();
  return code.includes('permission-denied') || message.includes('permission') || message.includes('missing or insufficient permissions');
}


function sanitizeStorageSegment(value, fallback = 'item') {
  const normalized = `${value || ''}`.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || fallback;
}

function buildTaskEvidenceStoragePath(companyId, taskId, filename = '') {
  const safeTaskId = sanitizeStorageSegment(taskId, 'task');
  const safeFilename = sanitizeStorageSegment(filename, 'evidence');
  const prefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return buildCompanyEvidencePath(companyId, safeTaskId, `${prefix}-${safeFilename}`);
}

function buildTaskEvidenceMeta({ taskId, file, storagePath, downloadURL, user }) {
  const uploadedBy = user?.email || user?.uid || 'unknown';
  return {
    id: `${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    filename: file.name,
    storagePath,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: Number(file.size || 0),
    uploadedBy,
    uploadedAt: new Date().toISOString(),
    downloadURL: downloadURL || ''
  };
}

function buildBootstrapErrorMessage(error) {
  if (!isPermissionRelatedError(error)) return formatActionError(error, 'Unable to finish account setup.');
  return 'Unable to finish account setup due to a workspace permission check. Your account was created, but bootstrap could not complete. Please retry in a moment or contact support if it keeps happening.';
}

function getEnrichmentFailureState(error) {
  const blocked = isPermissionRelatedError(error);
  return {
    status: blocked ? 'permission_blocked' : 'lookup_failed',
    message: blocked
      ? 'Asset saved. Access blocked while checking manuals/support links.'
      : 'Asset saved. Lookup failed; retry when ready.'
  };
}

async function markAssetEnrichmentFailure(assetId, error, preserveFollowup = false) {
  const current = state.assets.find((entry) => entry.id === assetId) || {};
  const failure = getEnrichmentFailureState(error);
  await upsertEntity('assets', assetId, {
    ...current,
    enrichmentStatus: failure.status,
    enrichmentUpdatedAt: new Date().toISOString(),
    enrichmentFailedAt: new Date().toISOString(),
    enrichmentErrorCode: `${error?.code || ''}`.trim() || 'unknown',
    enrichmentErrorMessage: `${error?.message || error || ''}`.trim().slice(0, 240),
    enrichmentFollowupQuestion: preserveFollowup ? (current.enrichmentFollowupQuestion || '') : '',
    enrichmentFollowupAnswer: preserveFollowup ? (current.enrichmentFollowupAnswer || '') : ''
  }, state.user);
  return failure;
}

function buildAssetSaveErrorMessage(error) {
  if (!isPermissionRelatedError(error)) return formatActionError(error, 'Unable to save asset.');
  return 'Unable to save asset due to company permissions. Verify your company access and try again.';
}

function buildAssetSaveDebugContext() {
  return {
    companyId: `${state.company?.id || state.activeMembership?.companyId || ''}`.trim() || 'unknown',
    companyRole: state.permissions?.companyRole || 'unknown'
  };
}

function setTaskAiUiState(taskId, nextState = null) {
  if (!taskId) return;
  const currentStates = { ...(state.operationsUi?.aiTaskStates || {}) };
  if (!nextState) {
    delete currentStates[taskId];
  } else {
    currentStates[taskId] = { ...nextState, updatedAt: new Date().toISOString() };
  }
  state.operationsUi = {
    ...(state.operationsUi || {}),
    aiTaskStates: currentStates
  };
}

function setTaskAiDisplayRun(taskId, run = null) {
  if (!taskId) return;
  const current = { ...(state.operationsUi?.aiDisplayRunsByTask || {}) };
  if (!run?.id) {
    delete current[taskId];
  } else {
    current[taskId] = run;
  }
  state.operationsUi = {
    ...(state.operationsUi || {}),
    aiDisplayRunsByTask: current
  };
}

function buildAiPendingRecordMessage(runId) {
  const safeRunId = `${runId || ''}`.trim();
  return safeRunId
    ? `AI callable succeeded (run ${safeRunId}), but the run record is still syncing. Waiting for refresh.`
    : 'AI callable succeeded, but the run record is still syncing. Waiting for refresh.';
}

function mapCallableRunStatus(status = '') {
  const normalized = `${status || ''}`.trim().toLowerCase();
  if (['queued', 'running', 'completed', 'failed', 'followup_required'].includes(normalized)) return normalized;
  return 'queued';
}

function mergeRunIntoState(run) {
  if (!run?.id) return;
  const existing = (state.taskAiRuns || []).filter((entry) => entry.id !== run.id);
  state.taskAiRuns = [run, ...existing]
    .sort((a, b) => `${b.updatedAt || b.createdAt || ''}`.localeCompare(`${a.updatedAt || a.createdAt || ''}`));
  if (run.taskId) setTaskAiDisplayRun(`${run.taskId}`.trim(), run);
}

async function pollForTaskAiRunRecord(taskId, runId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 20000);
  const intervalMs = Number(options.intervalMs || 900);
  const startedAt = Date.now();
  const expectedRunId = `${runId || ''}`.trim();
  const task = (state.tasks || []).find((entry) => entry.id === taskId) || null;
  const taskCompanyId = `${task?.companyId || ''}`.trim();
  let latestRuns = [];

  while (Date.now() - startedAt <= timeoutMs) {
    let directRun = null;
    try {
      directRun = await getEntity('taskAiRuns', expectedRunId, { bypassCompanyFilter: true });
    } catch (error) {
      return { found: false, run: null, timedOut: false, errorType: 'read_failed', error };
    }

    if (directRun) {
      const runTaskId = `${directRun.taskId || ''}`.trim();
      const runCompanyId = `${directRun.companyId || ''}`.trim();
      if (runTaskId && runTaskId !== `${taskId}`) {
        return { found: false, run: directRun, timedOut: false, errorType: 'task_mismatch' };
      }
      if (taskCompanyId && runCompanyId && runCompanyId !== taskCompanyId) {
        return { found: false, run: directRun, timedOut: false, errorType: 'company_mismatch' };
      }
      mergeRunIntoState(directRun);
      setTaskAiDisplayRun(`${taskId}`.trim(), directRun);
      state.taskAiFollowups = await listEntities('taskAiFollowups').catch(() => state.taskAiFollowups || []);
      return { found: true, run: directRun, timedOut: false, source: 'direct' };
    }

    try {
      latestRuns = await listEntities('taskAiRuns');
      state.taskAiRuns = latestRuns;
    } catch (error) {
      return { found: false, run: null, timedOut: false, errorType: 'query_failed', error };
    }

    const match = latestRuns.find((entry) => entry.id === expectedRunId && `${entry.taskId || ''}`.trim() === `${taskId}`);
    if (match) {
      const runCompanyId = `${match.companyId || ''}`.trim();
      if (taskCompanyId && runCompanyId && runCompanyId !== taskCompanyId) {
        return { found: false, run: match, timedOut: false, errorType: 'company_mismatch' };
      }
      setTaskAiDisplayRun(`${taskId}`.trim(), match);
      state.taskAiFollowups = await listEntities('taskAiFollowups').catch(() => state.taskAiFollowups || []);
      return { found: true, run: match, timedOut: false, source: 'query' };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  state.taskAiRuns = latestRuns;
  return { found: false, run: null, timedOut: true, errorType: 'not_found_yet' };
}

function getTaskAiFailureState(error, fallbackAction = 'run AI') {
  const code = `${error?.code || ''}`.toLowerCase();
  const message = `${error?.message || error || ''}`.trim();
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('missing company context')) {
    return {
      status: 'missing_company_context',
      message: 'Task is missing company context required for AI.'
    };
  }
  if (normalizedMessage.includes('disabled')) {
    return {
      status: 'disabled_by_settings',
      message: message || 'Company AI is disabled in settings.'
    };
  }
  if (code.includes('permission-denied') || normalizedMessage.includes('insufficient role')) {
    return {
      status: 'permission_blocked',
      message: message || 'Your company role does not allow this AI action.'
    };
  }
  return {
    status: 'failed',
    message: message || `Unable to ${fallbackAction}.`
  };
}

function buildPostSaveAiState({ isNewTask }) {
  const companyId = `${state.company?.id || state.activeMembership?.companyId || ''}`.trim();
  if (!companyId) {
    return {
      status: 'missing_company_context',
      message: 'Task saved, but company context is missing so AI cannot run yet.'
    };
  }
  if (!state.settings.aiEnabled) {
    return {
      status: 'disabled_by_settings',
      message: 'Task saved. AI is disabled for this company. Ask an admin/manager to enable it in Admin > AI settings.'
    };
  }
  if (isNewTask) {
    return {
      status: 'queued',
      message: state.settings.aiAllowManualRerun
        ? 'Task is open and saved; AI will run automatically if enabled. Use Rerun AI later if needed.'
        : 'Task is open and saved; AI will run automatically if enabled. Manual rerun is disabled by settings.'
    };
  }
  if (state.settings.aiAllowManualRerun) {
    return {
      status: 'idle',
      message: 'Task updated. Use Rerun AI to generate a fresh troubleshooting pass if needed.'
    };
  }
  return {
    status: 'idle',
    message: 'Task updated. AI does not rerun manually for this company.'
  };
}

function evaluatePassword(password = '') {
  const checks = [
    { label: 'at least 8 characters', ok: password.length >= 8 },
    { label: 'one uppercase letter', ok: /[A-Z]/.test(password) },
    { label: 'one lowercase letter', ok: /[a-z]/.test(password) },
    { label: 'one number', ok: /\d/.test(password) }
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
    message: checks.filter((check) => !check.ok).map((check) => check.label).join(', ')
  };
}

const runAction = runActionFactory({ reportActionError });
const withActiveCompanyId = (payload = {}, actionLabel = 'continue') => withRequiredCompanyId(state, payload, actionLabel);


function openTab(name, taskId = null, assetId = null) {
  openTabUi({ state, name, taskId, assetId });
}

async function refreshData() {
  await refreshAppData(state, { syncNotifications });
}

async function setActiveMembership(nextMembership, options = {}) {
  await setActiveMembershipState(state, nextMembership, { ...options, refreshData, render });
}

async function bootstrapCompanyContext() {
  await bootstrapCompanyContextState(state, { refreshData, render });
}

function renderActiveLocationSwitcher() {
  if (!activeLocationSwitcher || !locationScopeBadge) return;
  const options = buildLocationOptions(state);
  const selection = getLocationSelection(state);
  locationScopeBadge.textContent = getLocationScopeLabel(selection);
  activeLocationSwitcher.innerHTML = options.map((option) => `<option value="${option.key}" ${option.key === selection?.key ? 'selected' : ''}>${option.label}</option>`).join('');
  activeLocationSwitcher.onchange = (event) => {
    state.route = { ...state.route, locationKey: `${event.target.value || ''}`.trim() || null };
    pushRouteState(state.route);
    render();
  };
}


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
      await upsertEntity('notifications', candidate.id, withRequiredCompanyId(state, {
        ...candidate,
        userId: state.user.uid,
        readAt: null,
        dismissedAt: null,
        status: 'active',
        createdAtClient: nowIso,
        updatedAtClient: nowIso
      }, 'create notification'), state.user);
      continue;
    }
    if (current.status === 'dismissed') continue;
    const shouldRefreshUnread = !!candidate.happenedAt && `${candidate.happenedAt}` !== `${current.happenedAt || ''}`;
    await upsertEntity('notifications', current.id, withRequiredCompanyId(state, {
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
    }, 'update notification'), state.user);
  }
}

function unreadNotificationCount() {
  return (state.notifications || []).filter((item) => item.status !== 'dismissed' && !item.readAt).length;
}

async function markNotificationRead(notificationId) {
  const notification = (state.notifications || []).find((entry) => entry.id === notificationId);
  if (!notification || notification.readAt) return;
  await upsertEntity('notifications', notification.id, withRequiredCompanyId(state, {
    ...notification,
    readAt: new Date().toISOString(),
    updatedAtClient: new Date().toISOString()
  }, 'mark notification read'), state.user);
  await refreshData();
  render();
}

async function dismissNotification(notificationId) {
  const notification = (state.notifications || []).find((entry) => entry.id === notificationId);
  if (!notification) return;
  await upsertEntity('notifications', notification.id, withRequiredCompanyId(state, {
    ...notification,
    dismissedAt: new Date().toISOString(),
    status: 'dismissed',
    updatedAtClient: new Date().toISOString()
  }, 'dismiss notification'), state.user);
  await refreshData();
  render();
}

async function markAllNotificationsRead() {
  const unread = (state.notifications || []).filter((entry) => entry.status !== 'dismissed' && !entry.readAt);
  for (const notification of unread) {
    await upsertEntity('notifications', notification.id, withRequiredCompanyId(state, {
      ...notification,
      readAt: new Date().toISOString(),
      updatedAtClient: new Date().toISOString()
    }, 'mark all notifications read'), state.user);
  }
  await refreshData();
  render();
}

function routeFromNotificationAction(action = {}) {
  const nextRoute = {
    tab: action.tab || state.route.tab || 'dashboard',
    taskId: action.taskId || null,
    assetId: action.assetId || null,
    locationKey: state.route.locationKey || null,
    pmFilter: action.pmFilter || null
  };
  return nextRoute;
}

async function openNotification(notificationId) {
  const notification = (state.notifications || []).find((entry) => entry.id === notificationId);
  if (!notification) return;
  await markNotificationRead(notificationId);
  if (notification.action?.adminSection) state.adminSection = notification.action.adminSection;
  const nextRoute = routeFromNotificationAction(notification.action || {});
  state.route = { ...state.route, ...nextRoute };
  pushRouteState(state.route);
  if (notification.action?.focus) applyActionCenterFocus(notification.action.focus);
  openTab(nextRoute.tab, nextRoute.taskId, nextRoute.assetId);
  if (notificationPanel) notificationPanel.classList.add('hide');
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

function applyActionCenterFocus(focus) {
  if (focus === 'priority') {
    state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', exceptionFilter: 'priority' };
  } else if (focus === 'blocked') {
    state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', exceptionFilter: 'blocked' };
  } else if (focus === 'followup') {
    state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', ownershipFilter: 'followup' };
  } else if (focus === 'unassigned') {
    state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', ownershipFilter: 'unassigned' };
  } else if (focus === 'overdue_open') {
    state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', exceptionFilter: 'overdue' };
  } else if (focus === 'overdue_pm') {
    state.route = { ...(state.route || {}), pmFilter: 'overdue' };
  } else if (focus === 'due_soon_pm') {
    state.route = { ...(state.route || {}), pmFilter: 'due_soon' };
  }
}

function renderActiveCompanySwitcher() {
  if (!activeCompanySwitcher) return;
  const memberships = state.memberships || [];
  if (memberships.length <= 1 || state.onboardingRequired) {
    activeCompanySwitcher.classList.add('hide');
    activeCompanySwitcher.innerHTML = '';
    activeCompanySwitcher.onchange = null;
    return;
  }

  activeCompanySwitcher.classList.remove('hide');
  activeCompanySwitcher.innerHTML = memberships.map((membership) => {
    const companyName = state.membershipCompanies?.[membership.id]?.name || membership.companyId || 'Unknown company';
    const role = membership.role || 'pending';
    return `<option value="${membership.id}" ${membership.id === state.activeMembership?.id ? 'selected' : ''}>${companyName} (${role})</option>`;
  }).join('');
  activeCompanySwitcher.onchange = async (event) => {
    const nextId = `${event.target.value || ''}`.trim();
    if (!nextId || nextId === state.activeMembership?.id) return;
    await runAction('switch_company', async () => {
      await setActiveMembership(nextId);
    }, {
      fallbackMessage: 'Unable to switch company workspace.'
    });
  };
}


function normalizeAssetId(name = '') {
  const base = `${name}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'asset';
  return `asset-${base}`;
}

function pickUniqueAssetId(desiredId, assets) {
  const used = new Set((assets || []).map((a) => a.id));
  const clean = `${desiredId || ''}`.trim();
  if (clean && !used.has(clean)) return clean;
  const root = clean || normalizeAssetId(clean);
  if (!used.has(root)) return root;
  let i = 2;
  while (used.has(`${root}-${i}`)) i += 1;
  return `${root}-${i}`;
}

async function withTimeout(promise, ms, timeoutMessage) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), ms);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function downloadFile(filename, payload, type = 'application/json') {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function downloadJson(filename, payload) {
  downloadFile(filename, payload, 'application/json');
}




function dedupeUrls(values = []) {
  return [...new Set((values || []).map((v) => `${v || ''}`.trim()).filter(Boolean))];
}

function normalizeSupportEntries(values = []) {
  const mapped = (values || []).map((entry) => {
    if (typeof entry === 'string') return { url: entry.trim() };
    return { ...entry, url: `${entry?.url || ''}`.trim() };
  }).filter((entry) => entry.url);
  const seen = new Set();
  return mapped.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
}


async function render() {
  buildTabsUi({ state, sections, canViewAdminTab: () => isAdmin(state.permissions), onOpenTab: openTab });
  const roleLabel = state.permissions.companyRole || state.profile?.role || 'pending';
  renderActiveCompanySwitcher();
  renderActiveLocationSwitcher();
  document.getElementById('userBadge').textContent = `${state.user.email} (${roleLabel})${state.company?.name ? ` | ${state.company.name}` : ''}`;
  renderNotificationCenter();

  if (state.onboardingRequired || state.setupWizard?.active) {
    renderOnboarding(document.getElementById('dashboard'), state, {
      createCompany: async (payload) => {
        await runAction('create_company', async () => {
          setOnboardingFeedback(state, 'Creating your workspace…', 'info', { pendingAction: 'create_company', handoffStatus: 'working' });
          render();
          await createCompanyFromOnboarding(state.user, payload);
          await bootstrapCompanyContext();
          await refreshData();
          render();
        }, {
          fallbackMessage: 'Unable to create company workspace.',
          onError: (error) => {
            setOnboardingFeedback(state, formatActionError(error, 'Unable to create company workspace.'), 'error', { pendingAction: '', handoffStatus: 'error' });
            render();
          }
        });
      },
      acceptInvite: async (inviteCode) => {
        await runAction('accept_invite', async () => {
          setOnboardingFeedback(state, 'Joining company…', 'info', { pendingAction: 'accept_invite', handoffStatus: 'working' });
          render();
          await acceptInvite({ inviteCode, user: state.user });
          await bootstrapCompanyContext();
          await refreshData();
          render();
        }, {
          fallbackMessage: 'Unable to accept invite.',
          onError: (error) => {
            setOnboardingFeedback(state, formatActionError(error, 'Unable to accept invite.'), 'error', { pendingAction: '', handoffStatus: 'error' });
            render();
          }
        });
      },
      setSetupStep: (step) => {
        state.setupWizard = { ...(state.setupWizard || {}), step: Math.max(1, Math.min(6, Number(step) || 1)), message: '', tone: 'info' };
        render();
      },
      skipSetupStep: async (step) => {
        state.setupWizard = { ...(state.setupWizard || {}), step: Math.max(1, Math.min(6, (Number(step) || 1) + 1)), message: 'Skipped for now. You can return to Admin anytime.', tone: 'info' };
        await refreshData();
        render();
      },
      dismissReadiness: async () => {
        const readiness = getWorkspaceReadiness(state);
        if (!readiness.requiredComplete) {
          setSetupWizardFeedback(state, 'Finish required readiness items before dismissing this checklist.', 'warn');
          render();
          return;
        }
        await saveAppSettings({ ...state.settings, workspaceReadinessDismissedAt: new Date().toISOString() }, state.user);
        await refreshData();
        render();
      },
      submitSetupStep: async (step, payload) => {
        await runAction('setup_wizard_step', async () => {
          setSetupWizardFeedback(state, '');
          const currentStep = Number(step) || 1;
          if (currentStep === 1) {
            await upsertEntity('companies', state.company.id, withRequiredCompanyId(state, {
              ...state.company,
              name: `${payload.companyName || state.company?.name || ''}`.trim(),
              primaryEmail: `${payload.primaryEmail || ''}`.trim(),
              primaryPhone: `${payload.primaryPhone || ''}`.trim(),
              timeZone: `${payload.timeZone || state.company?.timeZone || 'UTC'}`.trim()
            }, 'save company basics'), state.user);
          }
          if (currentStep === 2) {
            const firstLocation = (state.companyLocations || [])[0];
            if (firstLocation?.id) {
              await upsertEntity('companyLocations', firstLocation.id, withRequiredCompanyId(state, {
                ...firstLocation,
                name: `${payload.locationName || firstLocation.name || ''}`.trim(),
                address: `${payload.locationAddress || firstLocation.address || ''}`.trim(),
                timeZone: `${payload.locationTimeZone || firstLocation.timeZone || state.company?.timeZone || 'UTC'}`.trim()
              }, 'save first location'), state.user);
            }
          }
          if (currentStep === 3) {
            const ownerWorker = (state.workers || []).find((worker) => `${worker.email || ''}`.toLowerCase() === `${state.user?.email || ''}`.toLowerCase());
            if (ownerWorker?.id) {
              await upsertEntity('workers', ownerWorker.id, withRequiredCompanyId(state, {
                ...ownerWorker,
                displayName: `${payload.ownerWorkerDisplayName || ownerWorker.displayName || ''}`.trim() || ownerWorker.displayName
              }, 'update owner worker record'), state.user);
            }
            const name = `${payload.newWorkerName || ''}`.trim();
            const email = `${payload.newWorkerEmail || ''}`.trim().toLowerCase();
            if (name) {
              await upsertEntity('workers', `worker-${Date.now().toString(36)}`, withRequiredCompanyId(state, {
                displayName: name,
                email,
                role: 'staff',
                enabled: true,
                available: true
              }, 'create first worker'), state.user);
            }
            const inviteEmail = `${payload.inviteEmail || ''}`.trim().toLowerCase();
            if (inviteEmail) await createCompanyInvite({ companyId: state.company.id, email: inviteEmail, role: payload.inviteRole || 'staff', user: state.user });
          }
          if (currentStep === 4) {
            const defaultLocationName = `${payload.assetLocation || ''}`.trim();
            const manualCandidate = normalizeAssetCandidate({
              name: `${payload.assetName || ''}`.trim(),
              manufacturer: `${payload.assetManufacturer || ''}`.trim(),
              locationName: defaultLocationName
            }, { defaultLocationName });
            const csvResult = parseAssetCsv(`${payload.assetCsvText || ''}`, { defaultLocationName });
            const bulkResult = parseBulkAssetList(`${payload.assetBulkList || ''}`, { defaultLocationName });
            const validationErrors = [...csvResult.errors, ...bulkResult.errors];
            const intakeRows = [
              ...(manualCandidate.name ? [{ ...manualCandidate, source: 'manual', sourceRow: 1 }] : []),
              ...csvResult.rows,
              ...bulkResult.rows
            ];
            if (!intakeRows.length) {
              throw new Error('Add at least one asset manually, CSV, or paste list before continuing (or click Skip for now).');
            }
            if (validationErrors.length) {
              state.assetUi = {
                ...(state.assetUi || {}),
                onboardingValidationErrors: validationErrors,
                onboardingReviewQueue: intakeRows
              };
              throw new Error(`Please fix import errors before continuing: ${validationErrors[0]}`);
            }
            state.assetUi = {
              ...(state.assetUi || {}),
              onboardingValidationErrors: [],
              onboardingReviewQueue: intakeRows
            };
            for (const [index, row] of intakeRows.entries()) {
              const requestedId = index === 0 ? `${payload.assetId || ''}`.trim() : '';
              const id = requestedId || `asset-${row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(Date.now() + index).toString(36).slice(-4)}`;
              const manufacturer = row.manufacturer || row.manufacturerSuggestion || '';
              const category = row.category || row.categorySuggestion || '';
              const shouldReview = row.reviewNeeded || !!row.manufacturerSuggestion || !!row.categorySuggestion;
              await upsertEntity('assets', id, withRequiredCompanyId(state, {
                id,
                name: row.name,
                manufacturer,
                model: row.model || '',
                category,
                locationName: row.locationName || defaultLocationName,
                serialNumber: row.serialNumber || '',
                status: 'active',
                reviewState: shouldReview ? 'pending_review' : 'ready',
                reviewReason: shouldReview ? 'onboarding_normalization' : '',
                enrichmentStatus: state.settings.aiEnabled ? 'queued' : 'unavailable_disabled',
                enrichmentRequestedAt: state.settings.aiEnabled ? new Date().toISOString() : null,
                enrichmentLastRunAt: null,
                manufacturerSuggestion: row.manufacturerSuggestion || '',
                categorySuggestion: row.categorySuggestion || '',
                normalizationConfidence: row.normalizationConfidence || 'low',
                importSource: row.source || 'manual'
              }, 'create first asset'), state.user);
              if (state.settings.aiEnabled) {
                enrichAssetDocumentation(id, { trigger: 'onboarding_asset_step' }).catch(() => {});
              }
            }
          }
          if (currentStep === 5) {
            await saveAppSettings({ ...state.settings, aiEnabled: payload.aiEnabled === 'yes', aiConfiguredExplicitly: true }, state.user);
          }
          if (currentStep === 6) {
            await upsertEntity('companies', state.company.id, withRequiredCompanyId(state, {
              ...state.company,
              onboardingCompleted: true,
              onboardingCompletedAt: new Date().toISOString()
            }, 'launch workspace'), state.user);
          }
          await refreshData();
          if (currentStep === 4) {
            state.route = { ...(state.route || {}), tab: 'assets', assetId: null };
            state.setupWizard = { ...(state.setupWizard || {}), step: 5, message: 'Assets added. Review normalization and documentation suggestions in Assets.', tone: 'success' };
            syncSetupWizardState(state);
            render();
            return;
          }
          state.setupWizard = { ...(state.setupWizard || {}), step: Math.min(6, currentStep + 1), message: currentStep < 6 ? 'Saved. Continue to the next step.' : 'Workspace launched.', tone: 'success' };
          syncSetupWizardState(state);
          render();
        }, {
          fallbackMessage: 'Unable to save setup step.',
          onError: (error) => {
            setSetupWizardFeedback(state, formatActionError(error, 'Unable to save setup step.'), 'error');
            render();
          }
        });
      }
    });
    openTab('dashboard');
    return;
  }

  renderDashboard(document.getElementById('dashboard'), state, openTab, (focus) => {
    if (focus === 'critical') {
      state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', exceptionFilter: 'priority' };
    } else if (focus === 'blocked') {
      state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', exceptionFilter: 'blocked' };
    } else if (focus === 'followup') {
      state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', ownershipFilter: 'followup' };
    } else if (focus === 'unassigned') {
      state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', ownershipFilter: 'unassigned' };
    } else if (focus === 'overdue_open') {
      state.operationsUi = { ...(state.operationsUi || {}), statusFilter: 'open', exceptionFilter: 'overdue' };
    } else if (focus === 'pending_invites') {
      state.adminSection = 'invites';
    } else if (focus === 'overdue_pm') {
      state.route = { ...(state.route || {}), pmFilter: 'overdue' };
      pushRouteState(state.route);
    } else if (focus === 'due_soon_pm') {
      state.route = { ...(state.route || {}), pmFilter: 'due_soon' };
      pushRouteState(state.route);
    } else if (focus === 'missing_docs') {
      state.route = { ...(state.route || {}), assetFilter: 'missing_docs' };
      pushRouteState(state.route);
    }
  });

  const operationsActions = createOperationsActions({
    state,
    onLocationFilter: (locationKey) => {
      state.route = { ...state.route, locationKey, tab: 'operations' };
      pushRouteState(state.route);
      render();
    },
    saveTask: async (_id, payload) => {
      const taskId = `${payload?.id || ''}`.trim() || `${_id || ''}`.trim();
      if (!taskId) return alert('Unable to save task: missing generated task ID.');
      const existing = state.tasks.find((entry) => entry.id === taskId);
      if (existing && existing.id === taskId && existing.updatedAtClient !== payload.updatedAtClient && existing.createdAtClient !== payload.createdAtClient) {
        alert(`Task ID ${taskId} is already in use. Refresh the form to generate a new task ID.`);
        return false;
      }
      if (payload.status === 'in_progress' && !(payload.assignedWorkers || []).length) {
        alert('Assign a worker before moving a task into progress.');
        return false;
      }
      const saved = await runAction('save_task', async () => {
        await upsertEntity('tasks', taskId, withRequiredCompanyId(state, { ...payload, id: taskId }, 'save a task'), state.user);
        setTaskAiUiState(taskId, buildPostSaveAiState({ isNewTask: !existing }));
        state.operationsUi = {
          ...(state.operationsUi || {}),
          expandedTaskIds: [...new Set([...(state.operationsUi?.expandedTaskIds || []), taskId])],
          lastSavedTaskId: taskId,
          lastSaveFeedback: `Task ${taskId} saved for ${payload.assetName || payload.assetId || 'the selected asset'}.`,
          lastSaveTone: 'success'
        };
        state.route = { ...state.route, tab: 'operations', taskId };
        await refreshData();
        render();
        return true;
      }, {
        fallbackMessage: 'Unable to save task.',
        onError: (error) => {
          state.operationsUi = {
            ...(state.operationsUi || {}),
            lastSaveFeedback: formatActionError(error, 'Unable to save task.'),
            lastSaveTone: 'error'
          };
          render();
        }
      });
      return !!saved;
    },
    appendTaskTimeline: async (taskId, entry = {}) => {
      const task = state.tasks.find((row) => row.id === taskId);
      if (!task) return;
      if (!`${entry.note || ''}`.trim() && !Object.values(entry.attachments || {}).some((items) => (items || []).length)) return;
      await upsertEntity('tasks', taskId, {
        ...task,
        timeline: [...(task.timeline || []), {
          at: new Date().toISOString(),
          type: 'update',
          note: `${entry.note || ''}`.trim(),
          by: state.user?.email || state.user?.uid || 'unknown',
          attachments: entry.attachments || {}
        }],
        updatedAtClient: new Date().toISOString()
      }, state.user);
      state.operationsUi = {
        ...(state.operationsUi || {}),
        lastSaveFeedback: `Timeline updated for task ${taskId}.`,
        lastSaveTone: 'success'
      };
      await refreshData();
      render();
    },
    reassignTask: async (taskId) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const nextWorker = `${state.operationsUi?.reassignSelections?.[taskId] || ''}`.trim();
      if (!nextWorker) {
        alert('Select a worker before reassigning.');
        return;
      }
      await upsertEntity('tasks', taskId, {
        ...task,
        assignedWorkers: [nextWorker],
        timeline: [...(task.timeline || []), {
          at: new Date().toISOString(),
          type: 'assignment',
          note: `Assigned to ${nextWorker}.`,
          by: state.user?.email || state.user?.uid || 'unknown'
        }],
        updatedAtClient: new Date().toISOString()
      }, state.user);
      await refreshData();
      render();
    },
    prepareAssetCreation: ({ assetName = '', locationName = '' } = {}) => {
      state.assetDraft = {
        ...createEmptyAssetDraft(),
        name: `${assetName || ''}`.trim(),
        locationName: `${locationName || ''}`.trim()
      };
      state.route = { ...state.route, tab: 'assets', assetId: null, taskId: null };
      pushRouteState(state.route);
      render();
    },
    uploadTaskEvidence: async (taskId, file) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task || !file) return;
      const companyId = `${task.companyId || state.company?.id || state.activeMembership?.companyId || ''}`.trim();
      if (!companyId) throw new Error('Missing company context for evidence upload.');
      if (!task.id) throw new Error('Missing task ID for evidence upload.');
      const storagePath = buildTaskEvidenceStoragePath(companyId, task.id, file.name);
      const evidenceRef = storageRef(storage, storagePath);
      await uploadBytes(evidenceRef, file, { contentType: file.type || 'application/octet-stream' });
      const downloadURL = await getDownloadURL(evidenceRef).catch(() => '');
      const entry = buildTaskEvidenceMeta({ taskId: task.id, file, storagePath, downloadURL, user: state.user });
      await upsertEntity('tasks', task.id, {
        ...task,
        uploadedEvidence: [...(Array.isArray(task.uploadedEvidence) ? task.uploadedEvidence : []), entry],
        updatedAtClient: new Date().toISOString()
      }, state.user);
      await refreshData();
      render();
    },
    removeTaskEvidence: async (taskId, evidenceId) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const existing = (Array.isArray(task.uploadedEvidence) ? task.uploadedEvidence : []).find((entry) => entry.id === evidenceId);
      if (!existing) return;
      if (existing.storagePath) {
        await deleteObject(storageRef(storage, existing.storagePath)).catch(() => {});
      }
      await upsertEntity('tasks', task.id, {
        ...task,
        uploadedEvidence: (task.uploadedEvidence || []).filter((entry) => entry.id !== evidenceId),
        updatedAtClient: new Date().toISOString()
      }, state.user);
      await refreshData();
      render();
    },
    completeTask: async (taskId, closeout) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const saveToLibrary = closeout.saveToLibrary === 'yes' || (closeout.saveToLibrary !== 'no' && state.settings.aiSaveSuccessfulFixesToLibraryDefault);
      const completedAt = new Date().toISOString();
      const closeoutTimeline = {
        at: completedAt,
        type: 'closeout',
        note: closeout.bestFixSummary || closeout.fixPerformed || 'Task closed',
        detail: closeout.verification || closeout.rootCause || '',
        by: state.user?.email || state.user?.uid || 'unknown',
        attachments: closeout.attachments || {}
      };
      await upsertEntity('tasks', taskId, {
        ...task,
        status: 'completed',
        closeout: { ...closeout, completedAt },
        timeline: [...(task.timeline || []), closeoutTimeline]
      }, state.user);
      if (task.assetId) {
        const asset = state.assets.find((entry) => entry.id === task.assetId) || { id: task.assetId };
        const event = buildCloseoutEvent(taskId, closeout, state.user);
        await upsertEntity('assets', task.assetId, { ...asset, history: [...(asset.history || []), event] }, state.user);
      }
      if (saveToLibrary && closeout.fixPerformed) {
        await saveTaskFixToTroubleshootingLibrary({ taskId, successfulFix: closeout.bestFixSummary || closeout.fixPerformed });
        await logAudit({
          action: 'create',
          actionType: 'ai_fix_saved_to_library',
          category: 'operations_tasks',
          entityType: 'tasks',
          entityId: taskId,
          targetType: 'task',
          targetId: taskId,
          targetLabel: task.title || taskId,
          summary: `AI fix saved to library from task ${task.title || taskId}`,
          user: state.user,
          metadata: { source: 'task_closeout', taskId }
        });
      }
      state.operationsUi = {
        ...(state.operationsUi || {}),
        lastSaveFeedback: `Task ${taskId} closed successfully. ${saveToLibrary ? 'Fix saved to library settings path.' : 'Closeout recorded.'}`,
        lastSaveTone: 'success',
        expandedTaskIds: [...new Set([...(state.operationsUi?.expandedTaskIds || []), taskId])]
      };
      await refreshData();
      render();
    },
    deleteTask: async (id) => {
      if (!canDelete(state.permissions)) return;
      await deleteEntity('tasks', id, state.user);
      await refreshData();
      render();
    },
    runAi: async (taskId) => {
      setTaskAiUiState(taskId, { status: 'running', message: 'AI run started for this task.' });
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (task) {
        await upsertEntity('tasks', taskId, {
          ...task,
          timeline: [...(task.timeline || []), {
            at: new Date().toISOString(),
            type: 'ai_run',
            note: 'AI troubleshooting run started.',
            by: state.user?.email || state.user?.uid || 'unknown'
          }],
          updatedAtClient: new Date().toISOString()
        }, state.user);
      }
      render();
      let result = null;
      try {
        result = await analyzeTaskTroubleshooting(taskId);
      } catch (error) {
        setTaskAiUiState(taskId, getTaskAiFailureState(error, 'run AI'));
        render();
        reportActionError('run_ai', error, 'Unable to run task AI.');
        return;
      }

      const runId = `${result?.runId || ''}`.trim() || null;
      const callableStatus = mapCallableRunStatus(result?.status);
      setTaskAiUiState(taskId, {
        status: callableStatus,
        runId,
        message: runId ? `AI run ${runId} ${callableStatus.replaceAll('_', ' ')}.` : `AI run ${callableStatus.replaceAll('_', ' ')}.`
      });
      render();

      if (runId) {
        setTaskAiUiState(taskId, {
          status: 'waiting_for_refresh',
          runId,
          message: buildAiPendingRecordMessage(runId)
        });
        render();
        const pollResult = await pollForTaskAiRunRecord(taskId, runId);
        if (pollResult.found && pollResult.run) {
          setTaskAiUiState(taskId, {
            status: `${pollResult.run.status || 'completed'}`,
            runId,
            message: `AI run ${runId} is now visible with status ${pollResult.run.status || 'completed'} (${pollResult.source || 'sync'} read).`
          });
        } else if (pollResult.errorType === 'company_mismatch') {
          const runCompanyId = `${pollResult.run?.companyId || 'none'}`.trim();
          const taskCompanyId = `${state.tasks.find((entry) => entry.id === taskId)?.companyId || 'none'}`.trim();
          setTaskAiUiState(taskId, {
            status: 'failed',
            runId,
            message: `AI run ${runId} exists but company mismatch was detected (run company: ${runCompanyId}, task company: ${taskCompanyId}).`
          });
        } else if (pollResult.errorType === 'task_mismatch') {
          setTaskAiUiState(taskId, {
            status: 'failed',
            runId,
            message: `AI run ${runId} exists but is linked to task ${pollResult.run?.taskId || 'unknown'} instead of ${taskId}.`
          });
        } else if (pollResult.errorType === 'read_failed' || pollResult.errorType === 'query_failed') {
          const reason = `${pollResult.error?.message || 'Unable to read AI run records.'}`.trim();
          setTaskAiUiState(taskId, {
            status: 'failed',
            runId,
            message: `AI run ${runId} started, but readback failed: ${reason}`
          });
        } else {
          setTaskAiUiState(taskId, {
            status: 'waiting_for_refresh',
            runId,
            message: `${buildAiPendingRecordMessage(runId)} This can happen briefly under normal load.`
          });
        }
      }

      render();

      await refreshData();
      render();
    },
    rerunAi: async (taskId) => {
      setTaskAiUiState(taskId, { status: 'running', message: 'AI rerun started for this task.' });
      render();
      let result = null;
      try {
        result = await regenerateTaskTroubleshooting(taskId);
      } catch (error) {
        setTaskAiUiState(taskId, getTaskAiFailureState(error, 'rerun AI'));
        render();
        reportActionError('rerun_ai', error, 'Unable to rerun task AI.');
        return;
      }

      const runId = `${result?.runId || ''}`.trim() || null;
      const callableStatus = mapCallableRunStatus(result?.status);
      setTaskAiUiState(taskId, {
        status: callableStatus,
        runId,
        message: runId ? `AI rerun ${runId} ${callableStatus.replaceAll('_', ' ')}.` : `AI rerun ${callableStatus.replaceAll('_', ' ')}.`
      });
      render();

      if (runId) {
        setTaskAiUiState(taskId, {
          status: 'waiting_for_refresh',
          runId,
          message: buildAiPendingRecordMessage(runId)
        });
        render();
        const pollResult = await pollForTaskAiRunRecord(taskId, runId);
        if (pollResult.found && pollResult.run) {
          setTaskAiUiState(taskId, {
            status: `${pollResult.run.status || 'completed'}`,
            runId,
            message: `AI rerun ${runId} is now visible with status ${pollResult.run.status || 'completed'} (${pollResult.source || 'sync'} read).`
          });
        } else if (pollResult.errorType === 'company_mismatch') {
          const runCompanyId = `${pollResult.run?.companyId || 'none'}`.trim();
          const taskCompanyId = `${state.tasks.find((entry) => entry.id === taskId)?.companyId || 'none'}`.trim();
          setTaskAiUiState(taskId, {
            status: 'failed',
            runId,
            message: `AI rerun ${runId} exists but company mismatch was detected (run company: ${runCompanyId}, task company: ${taskCompanyId}).`
          });
        } else if (pollResult.errorType === 'task_mismatch') {
          setTaskAiUiState(taskId, {
            status: 'failed',
            runId,
            message: `AI rerun ${runId} exists but is linked to task ${pollResult.run?.taskId || 'unknown'} instead of ${taskId}.`
          });
        } else if (pollResult.errorType === 'read_failed' || pollResult.errorType === 'query_failed') {
          const reason = `${pollResult.error?.message || 'Unable to read AI run records.'}`.trim();
          setTaskAiUiState(taskId, {
            status: 'failed',
            runId,
            message: `AI rerun ${runId} started, but readback failed: ${reason}`
          });
        } else {
          setTaskAiUiState(taskId, {
            status: 'waiting_for_refresh',
            runId,
            message: `${buildAiPendingRecordMessage(runId)} This can happen briefly under normal load.`
          });
        }
      }

      render();

      await refreshData();
      render();
    },
    submitFollowup: async (taskId, runId, answers) => {
      setTaskAiUiState(taskId, { status: 'running', message: 'Submitting follow-up answers to AI.' });
      try {
        await answerTaskFollowup(taskId, runId, answers);
        const task = state.tasks.find((entry) => entry.id === taskId);
        if (task) {
          await upsertEntity('tasks', taskId, {
            ...task,
            timeline: [...(task.timeline || []), {
              at: new Date().toISOString(),
              type: 'followup',
              note: 'AI follow-up answers submitted.',
              by: state.user?.email || state.user?.uid || 'unknown'
            }],
            updatedAtClient: new Date().toISOString()
          }, state.user);
        }
        setTaskAiUiState(taskId, { status: 'queued', message: 'Follow-up answers submitted. AI is continuing the run.' });
      } catch (error) {
        setTaskAiUiState(taskId, getTaskAiFailureState(error, 'submit AI follow-up answers'));
        render();
        reportActionError('submit_followup', error, 'Unable to submit AI follow-up answers.');
        return;
      }
      await refreshData();
      render();
    },
    saveFix: async (taskId) => {
      const successfulFix = prompt('Summarize the successful fix for the troubleshooting library:');
      if (!successfulFix) return;
      const task = state.tasks.find((entry) => entry.id === taskId);
      await saveTaskFixToTroubleshootingLibrary({ taskId, successfulFix });
      await logAudit({
        action: 'create',
        actionType: 'ai_fix_saved_to_library',
        category: 'operations_tasks',
        entityType: 'tasks',
        entityId: taskId,
        targetType: 'task',
        targetId: taskId,
        targetLabel: task?.title || taskId,
        summary: `AI fix saved to library from task ${task?.title || taskId}`,
        user: state.user,
        metadata: { source: 'manual_save_fix', fixLength: `${successfulFix}`.length }
      });
      if (task) {
        await upsertEntity('tasks', taskId, {
          ...task,
          timeline: [...(task.timeline || []), {
            at: new Date().toISOString(),
            type: 'library',
            note: 'Fix saved to troubleshooting library.',
            detail: successfulFix,
            by: state.user?.email || state.user?.uid || 'unknown'
          }],
          updatedAtClient: new Date().toISOString()
        }, state.user);
      }
      state.operationsUi = {
        ...(state.operationsUi || {}),
        lastSaveFeedback: `Saved task ${taskId} fix to troubleshooting library.`,
        lastSaveTone: 'success'
      };
      await refreshData();
      render();
    },
    setAiFixState: async (taskId, aiFixState) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const nextFixState = ['pending_review', 'approved', 'rejected'].includes(`${aiFixState || ''}`.trim()) ? aiFixState : 'pending_review';
      await upsertEntity('tasks', taskId, {
        ...task,
        aiFixState: nextFixState,
        aiUpdatedAt: new Date().toISOString()
      }, state.user);
      await refreshData();
      render();
    },
    openAiSettings: () => {
      state.adminSection = 'tools';
      state.route = { ...state.route, tab: 'admin' };
      pushRouteState(state.route);
      render();
    }
  });
  renderOperations(document.getElementById('operations'), state, operationsActions);

  const assetActions = createAssetActions({
    state,
    onLocationFilter: (locationKey) => {
      state.route = { ...state.route, locationKey, tab: 'assets' };
      pushRouteState(state.route);
      render();
    },
    render,
    refreshData,
    runAction,
    withRequiredCompanyId: withActiveCompanyId,
    upsertEntity,
    deleteEntity,
    approveAssetManual,
    enrichAssetDocumentation,
    previewAssetDocumentationLookup,
    markAssetEnrichmentFailure,
    normalizeAssetId,
    pickUniqueAssetId,
    createEmptyAssetDraft,
    withTimeout,
    dedupeUrls,
    normalizeSupportEntries,
    canDelete,
    isAdmin,
    isManager,
    buildAssetSaveErrorMessage,
    buildAssetSaveDebugContext,
    isPermissionRelatedError,
    buildPreviewQueryKey
  });
  renderAssets(document.getElementById('assets'), state, assetActions);
  renderCalendar(document.getElementById('calendar'), state);
  renderReports(document.getElementById('reports'), state, openTab, (focus) => {
    if (focus) applyActionCenterFocus(focus);
    if (focus === 'pending_invites') state.adminSection = 'invites';
    if (focus === 'missing_docs') state.route = { ...(state.route || {}), assetFilter: 'missing_docs' };
    if (focus === 'overdue_pm' || focus === 'due_soon_pm' || focus === 'missing_docs') pushRouteState(state.route);
  });
  renderAccount(document.getElementById('account'), state, {
    resendVerification: async () => {
      await resendVerificationEmail();
      const refreshed = await refreshAuthUser();
      state.profile = await syncSecuritySnapshot(refreshed || { uid: state.user?.uid, email: state.user?.email }, state.profile || {});
      render();
    },
    refreshVerification: async () => {
      const refreshed = await refreshAuthUser();
      if (!refreshed) throw new Error('No authenticated user found.');
      state.profile = await syncSecuritySnapshot(refreshed, state.profile || {});
      render();
    },
    sendPasswordReset: async () => {
      await sendForgotPasswordEmail(state.user?.email || '');
    }
  });
  renderAdmin(document.getElementById('admin'), state, createAdminActions({
    state,
    render,
    refreshData,
    runAction,
    withRequiredCompanyId: withActiveCompanyId,
    upsertEntity,
    clearEntitySet,
    saveAppSettings,
    exportBackupJson,
    buildAssetsCsv,
    buildTasksCsv,
    buildAuditCsv,
    buildWorkersCsv,
    buildMembersCsv,
    buildInvitesCsv,
    buildLocationsCsv,
    buildCompanyBackupBundle,
    downloadFile,
    downloadJson,
    normalizeAssetId,
    dedupeUrls,
    enrichAssetDocumentation,
    isManager,
    createCompanyInvite,
    revokeInvite
  }));
  if (state.route?.tab === 'operations' && Number.isFinite(state.operationsUi?.scrollY)) {
    requestAnimationFrame(() => window.scrollTo({ top: state.operationsUi.scrollY, behavior: 'auto' }));
  }

  openTab(state.route.tab, state.route.taskId, state.route.assetId);
}

window.addEventListener('popstate', () => {
  state.route = parseRouteState();
  openTab(state.route.tab, state.route.taskId, state.route.assetId);
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  syncPendingInviteCode(state);
  try {
    await login(fd.get('email'), fd.get('password'));
  } catch (err) { authMessage.textContent = err.message; }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const fullName = `${fd.get('fullName') || ''}`.trim();
  const password = `${fd.get('password') || ''}`;
  const confirmPassword = `${fd.get('confirmPassword') || ''}`;
  const passwordState = evaluatePassword(password);
  if (!fullName) {
    authMessage.textContent = 'Full name is required.';
    return;
  }
  if (password !== confirmPassword) {
    authMessage.textContent = 'Passwords do not match.';
    return;
  }
  if (!passwordState.ok) {
    authMessage.textContent = `Password must include ${passwordState.message}.`;
    return;
  }
  try {
    syncPendingInviteCode(state);
    setActiveCompanyContext(null);
    await register(fd.get('email'), password, { fullName });
    authMessage.textContent = 'Account created. Handing off to workspace setup...';
  } catch (err) { authMessage.textContent = err.message; }
});

document.getElementById('googleLoginBtn')?.addEventListener('click', async () => {
  syncPendingInviteCode(state);
  try {
    await loginWithGoogle();
    authMessage.textContent = 'Google sign-in successful. Finishing setup...';
  } catch (error) {
    authMessage.textContent = formatActionError(error, 'Google sign-in failed.');
  }
});

document.getElementById('googleRegisterBtn')?.addEventListener('click', async () => {
  syncPendingInviteCode(state);
  try {
    await loginWithGoogle();
    authMessage.textContent = 'Google sign-in successful. Finishing setup...';
  } catch (error) {
    authMessage.textContent = formatActionError(error, 'Google sign-in failed.');
  }
});

document.getElementById('forgotPasswordBtn')?.addEventListener('click', async () => {
  const email = `${document.querySelector('#loginForm [name="email"]')?.value || ''}`.trim();
  try {
    await sendForgotPasswordEmail(email);
    authMessage.textContent = 'Password reset email sent. Check your inbox.';
  } catch (error) {
    authMessage.textContent = formatActionError(error, 'Unable to start password reset.');
  }
});

document.getElementById('authInviteCode')?.addEventListener('input', syncPendingInviteCode);

const registerForm = document.getElementById('registerForm');
const registerPasswordInput = registerForm?.querySelector('[name="password"]');
const registerConfirmInput = registerForm?.querySelector('[name="confirmPassword"]');
const registerPasswordHelp = document.getElementById('registerPasswordHelp');
const syncRegisterPasswordHelp = () => {
  const password = `${registerPasswordInput?.value || ''}`;
  const confirmPassword = `${registerConfirmInput?.value || ''}`;
  const passwordState = evaluatePassword(password);
  const requirements = passwordState.checks.map((check) => `${check.ok ? 'ok' : 'missing'} ${check.label}`).join(' | ');
  const confirmState = confirmPassword ? ` | ${password === confirmPassword ? 'passwords match' : 'passwords do not match'}` : '';
  if (registerPasswordHelp) registerPasswordHelp.textContent = `${requirements}${confirmState}`;
};
registerPasswordInput?.addEventListener('input', syncRegisterPasswordHelp);
registerConfirmInput?.addEventListener('input', syncRegisterPasswordHelp);

document.getElementById('logoutBtn').addEventListener('click', () => logout());


if (notificationBell && notificationPanel) {
  notificationBell.addEventListener('click', () => {
    notificationPanel.classList.toggle('hide');
  });
  document.addEventListener('click', (event) => {
    if (notificationPanel.classList.contains('hide')) return;
    if (notificationPanel.contains(event.target) || notificationBell.contains(event.target)) return;
    notificationPanel.classList.add('hide');
  });
}

hydrateInviteCodeFromRoute(state);

watchAuth(async (user) => {
  if (!user) {
    setActiveCompanyContext(null);
    state.user = null;
    state.profile = null;
    state.company = null;
    state.memberships = [];
    state.activeMembership = null;
    state.notifications = [];
    if (notificationPanel) notificationPanel.classList.add('hide');
    setOnboardingFeedback(state, '', 'info', { pendingAction: '', handoffStatus: 'idle' });
    authView.classList.remove('hide');
    appView.classList.add('hide');
    return;
  }
  try {
    authMessage.textContent = 'Finishing workspace setup…';
    authView.classList.remove('hide');
    appView.classList.add('hide');
    setActiveCompanyContext(null);
    setOnboardingFeedback(state, '', 'info', { pendingAction: '', handoffStatus: 'working' });
    state.user = { uid: user.uid, email: user.email, displayName: user.displayName };
    state.profile = await resolveProfile(user);
    state.profile = await syncSecuritySnapshot(user, state.profile);
    state.permissions = buildPermissionContext({ profile: state.profile, membership: null });
    if (state.profile.enabled === false) {
      await logout();
      authMessage.textContent = 'This account is disabled.';
      return;
    }
    authMessage.textContent = '';
    authView.classList.add('hide');
    appView.classList.remove('hide');
    await bootstrapCompanyContext();
    await refreshData();
    await render();
  } catch (error) {
    console.error('[watchAuth]', error);
    authMessage.textContent = buildBootstrapErrorMessage(error);
    setOnboardingFeedback(state, authMessage.textContent, 'error', { pendingAction: '', handoffStatus: 'error' });
    authView.classList.remove('hide');
    appView.classList.add('hide');
    setActiveCompanyContext(null);
  }
});
