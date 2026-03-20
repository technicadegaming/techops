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
import { buildNotificationCandidates, formatRelativeTime } from './features/notifications.js';
import { acceptInvite, createCompanyFromOnboarding, createCompanyInvite, revokeInvite } from './company.js';
import { getWorkspaceReadiness } from './features/workspaceReadiness.js';
import { logAudit } from './audit.js';
import { renderAccount } from './account.js';
import { storage } from './firebase.js';
import { buildCompanyEvidencePath } from './storagePaths.js';
import { hydrateInviteCodeFromRoute, resolveAppElements, syncPendingInviteCode } from './app/boot.js';
import { reportActionError, withRequiredCompanyId } from './app/actions.js';
import { applyActionCenterFocus as applyActionCenterFocusState, applyShellFocus } from './app/actionCenter.js';
import { createContextSwitcherController } from './app/contextSwitcher.js';
import { createNotificationController } from './app/notifications.js';
import { createOnboardingController } from './app/onboardingController.js';
import { createNavigationController } from './app/navigationController.js';
import { createOperationsController } from './app/operationsController.js';
import { createAssetsController } from './app/assetsController.js';
import { createAdminController } from './app/adminController.js';
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
import { createEmptyAssetDraft, createInitialState, sections } from './app/state.js';

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


function buildBootstrapErrorMessage(error) {
  if (!isPermissionRelatedError(error)) return formatActionError(error, 'Unable to finish account setup.');
  return 'Unable to finish account setup due to a workspace permission check. Your account was created, but bootstrap could not complete. Please retry in a moment or contact support if it keeps happening.';
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


async function refreshData() {
  await refreshAppData(state, { syncNotifications: notificationController.syncNotifications });
}

async function setActiveMembership(nextMembership, options = {}) {
  await setActiveMembershipState(state, nextMembership, { ...options, refreshData, render });
}

async function bootstrapCompanyContext() {
  await bootstrapCompanyContextState(state, { refreshData, render });
}

const navigationController = createNavigationController({
  state,
  sections,
  canViewAdminTab: () => isAdmin(state.permissions),
  applyShellFocus: (focus, options = {}) => applyShellFocus(state, focus, options)
});

const notificationController = createNotificationController({
  state,
  elements: { notificationBell, notificationBadge, notificationPanel },
  buildNotificationCandidates,
  formatRelativeTime,
  withRequiredCompanyId: (payload = {}, actionLabel = 'continue') => withRequiredCompanyId(state, payload, actionLabel),
  upsertEntity: (collection, id, payload) => upsertEntity(collection, id, payload, state.user),
  refreshData,
  render,
  openTab: navigationController.openTab,
  pushRouteState: navigationController.updateRoute,
  applyActionCenterFocus,
  setAdminSection: navigationController.setAdminSection
});

function applyActionCenterFocus(focus) {
  return applyActionCenterFocusState(state, focus);
}

const contextSwitcherController = createContextSwitcherController({
  state,
  elements: { activeCompanySwitcher, activeLocationSwitcher, locationScopeBadge },
  setActiveMembership,
  pushRouteState: navigationController.updateRoute,
  render,
  runAction
});

const onboardingController = createOnboardingController({
  state,
  runAction,
  render,
  refreshData,
  bootstrapCompanyContext,
  upsertEntity,
  saveAppSettings,
  withRequiredCompanyId: (payload = {}, actionLabel = 'continue') => withRequiredCompanyId(state, payload, actionLabel),
  enrichAssetDocumentation
});


function normalizeAssetId(name = '') {
  const base = `${name}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'asset';
  return `asset-${base}`;
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




async function render() {
  navigationController.renderTabs();
  contextSwitcherController.renderHeaderContext();
  notificationController.renderNotificationCenter();

  if (state.onboardingRequired || state.setupWizard?.active) {
    renderOnboarding(document.getElementById('dashboard'), state, onboardingController);
    navigationController.openTab('dashboard');
    return;
  }

  renderDashboard(document.getElementById('dashboard'), state, navigationController.openTab, (focus) => {
    navigationController.applyShellFocusAndPush(focus);
  });

  const operationsController = createOperationsController({
    state,
    navigationController,
    refreshData,
    render,
    runAction,
    formatActionError,
    withRequiredCompanyId,
    upsertEntity,
    deleteEntity,
    getEntity,
    listEntities,
    storage,
    storageRef,
    uploadBytes,
    getDownloadURL,
    deleteObject,
    analyzeTaskTroubleshooting,
    regenerateTaskTroubleshooting,
    answerTaskFollowup,
    saveTaskFixToTroubleshootingLibrary,
    logAudit,
    reportActionError,
    createEmptyAssetDraft,
    buildCompanyEvidencePath
  });
  const operationsActions = operationsController.createActions();
  renderOperations(document.getElementById('operations'), state, operationsActions);

  const assetsController = createAssetsController({
    state,
    navigationController,
    render,
    refreshData,
    runAction,
    withRequiredCompanyId: withActiveCompanyId,
    upsertEntity,
    deleteEntity,
    approveAssetManual,
    enrichAssetDocumentation,
    previewAssetDocumentationLookup,
    canDelete,
    isAdmin,
    isManager
  });
  renderAssets(document.getElementById('assets'), state, assetsController.createActions());
  renderCalendar(document.getElementById('calendar'), state);
  renderReports(document.getElementById('reports'), state, navigationController.openTab, (focus) => {
    navigationController.applyShellFocusAndPush(focus);
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
  const adminController = createAdminController({
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
  });
  adminController.renderAdminSection(document.getElementById('admin'));
  if (state.route?.tab === 'operations' && Number.isFinite(state.operationsUi?.scrollY)) {
    requestAnimationFrame(() => window.scrollTo({ top: state.operationsUi.scrollY, behavior: 'auto' }));
  }

  navigationController.openTab(state.route.tab, state.route.taskId, state.route.assetId);
}

window.addEventListener('popstate', () => {
  navigationController.syncFromUrl();
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


notificationController.bindNotificationUi();

hydrateInviteCodeFromRoute(state);

watchAuth(async (user) => {
  if (!user) {
    setActiveCompanyContext(null);
    state.user = null;
    state.profile = null;
    state.company = null;
    state.memberships = [];
    state.activeMembership = null;
    notificationController.resetNotifications();
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
