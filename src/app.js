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
  attachAssetManualFromStoragePath,
  attachAssetManualFromUrl,
  repairAssetDocumentationState,
  bootstrapAttachAssetManualFromCsvHint,
  enrichAssetDocumentation,
  previewAssetDocumentationLookup,
  researchAssetTitles,
  regenerateTaskTroubleshooting,
  saveTaskFixToTroubleshootingLibrary
} from './aiAdapter.js';
import { buildNotificationCandidates, formatRelativeTime } from './features/notifications.js';
import { acceptInvite as acceptCompanyInvite, createCompanyInvite, revokeInvite } from './company.js';
import { logAudit } from './audit.js';
import { storage } from './firebase.js';
import { buildCompanyBrandingLogoPath, buildCompanyEvidencePath } from './storagePaths.js';
import { hydrateInviteCodeFromRoute, resolveAppElements } from './app/boot.js';
import { reportActionError, withRequiredCompanyId } from './app/actions.js';
import { applyActionCenterFocus as applyActionCenterFocusState, applyShellFocus } from './app/actionCenter.js';
import { createContextSwitcherController } from './app/contextSwitcher.js';
import { createNotificationController } from './app/notifications.js';
import { createOnboardingController } from './app/onboardingController.js';
import { createNavigationController } from './app/navigationController.js';
import { createOperationsController } from './app/operationsController.js';
import { createAssetsController } from './app/assetsController.js';
import { createAdminController } from './app/adminController.js';
import { createReportsController } from './app/reportsController.js';
import { createAccountController } from './app/accountController.js';
import { createAuthController } from './app/authController.js';
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
import { createEmptyAssetDraft, createInitialState, sections, setOnboardingFeedback } from './app/state.js';
import { finalizeOnboardingBootstrap, shouldFinalizeOnboardingBootstrap } from './app/bootstrapRepair.js';
import { buildBootstrapErrorMessage } from './app/bootstrapErrors.js';
import { canFallbackToOnboarding, buildOnboardingFallbackState } from './app/authHandoff.js';
import { createGlobalBusyHelpers, renderGlobalBusyOverlay } from './app/globalBusy.js';
import { applyAppearancePreference, loadAppearancePreference } from './app/theme.js';
import { setRootViewVisibility } from './app/viewVisibility.js';

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
state.ui = { ...(state.ui || {}), appearance: loadAppearancePreference() };

const runAction = runActionFactory({ reportActionError });
const withActiveCompanyId = (payload = {}, actionLabel = 'continue') => withRequiredCompanyId(state, payload, actionLabel);
const globalBusy = createGlobalBusyHelpers(state, () => render());

let onboardingRepairInFlight = null;
let lastResolvedCompanyLogoPath = '';
let pendingLogoLoadToken = 0;

function setBootstrapLoading(active = false, detail = '') {
  const loadingEl = document.getElementById('appBootstrapLoading');
  const detailEl = document.getElementById('appBootstrapLoadingDetail');
  if (!loadingEl) return;
  loadingEl.classList.toggle('hide', !active);
  if (detailEl) detailEl.textContent = detail || 'Loading workspace…';
}

async function resolveCompanyLogoUrl() {
  const logoUrl = `${state.company?.logoUrl || ''}`.trim();
  const logoStoragePath = `${state.company?.logoStoragePath || ''}`.trim();
  if (logoUrl) return logoUrl;
  if (!logoStoragePath) return '';
  if (logoStoragePath === lastResolvedCompanyLogoPath && state.company?.resolvedLogoUrl) return `${state.company.resolvedLogoUrl || ''}`.trim();
  const resolved = await getDownloadURL(storageRef(storage, logoStoragePath)).catch(() => '');
  lastResolvedCompanyLogoPath = logoStoragePath;
  state.company = { ...(state.company || {}), resolvedLogoUrl: resolved };
  return resolved;
}

async function renderHeaderBranding() {
  const logoEl = document.getElementById('appCompanyLogo');
  const titleEl = document.getElementById('appBrandTitle');
  if (!logoEl) return;
  const token = ++pendingLogoLoadToken;
  logoEl.classList.add('hide');
  logoEl.removeAttribute('src');
  logoEl.onerror = () => {
    logoEl.classList.add('hide');
    logoEl.removeAttribute('src');
    if (titleEl) titleEl.textContent = `${state.company?.name || 'Scoot Business'}`;
  };
  const logoUrl = await resolveCompanyLogoUrl();
  if (token !== pendingLogoLoadToken || !logoUrl) return;
  logoEl.onload = () => logoEl.classList.remove('hide');
  logoEl.src = logoUrl;
}

async function repairOperationalOnboardingState() {
  if (!shouldFinalizeOnboardingBootstrap(state) || onboardingRepairInFlight) return;

  onboardingRepairInFlight = (async () => {
    try {
      await finalizeOnboardingBootstrap(state);
      await refreshAppData(state, { syncNotifications: notificationController.syncNotifications });
    } finally {
      onboardingRepairInFlight = null;
    }
  })();

  await onboardingRepairInFlight;
}

async function refreshData() {
  await refreshAppData(state, { syncNotifications: notificationController.syncNotifications });
  await repairOperationalOnboardingState();
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
  previewAssetDocumentationLookup
});

const reportsController = createReportsController({
  state,
  navigationController
});

const authController = createAuthController({
  state,
  authMessage,
  login,
  register,
  loginWithGoogle,
  sendForgotPasswordEmail,
  applyInviteCode: async (inviteCode) => {
    await acceptCompanyInvite({ inviteCode, user: state.user });
    state.onboardingUi = { ...(state.onboardingUi || {}), inviteCodePrefill: '' };
    await bootstrapCompanyContext();
    await refreshData();
    state.route = { ...(state.route || {}), tab: 'dashboard' };
    await render();
    navigationController.openTab('dashboard');
    setRootViewVisibility({ authView, appView, showAuth: false });
  }
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

async function render() {
  state.storageRuntime = { storage, storageRef, getDownloadURL };
  await renderHeaderBranding();
  applyAppearancePreference(state.ui?.appearance || {});
  navigationController.renderTabs();
  contextSwitcherController.renderHeaderContext();
  notificationController.renderNotificationCenter();

  if (state.onboardingRequired || state.setupWizard?.active) {
    const appView = document.getElementById('appView');
    appView?.querySelector('.global-busy-overlay')?.remove();
    if (appView) appView.insertAdjacentHTML('beforeend', renderGlobalBusyOverlay(state));
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
    buildCompanyEvidencePath,
    withGlobalBusy: globalBusy.withGlobalBusy
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
    attachAssetManualFromStoragePath,
    attachAssetManualFromUrl,
    repairAssetDocumentationState,
    enrichAssetDocumentation,
    previewAssetDocumentationLookup,
    researchAssetTitles,
    storage,
    storageRef,
    uploadBytes,
    canDelete,
    isAdmin,
    isManager,
    withGlobalBusy: globalBusy.withGlobalBusy
  });
  renderAssets(document.getElementById('assets'), state, assetsController.createActions());
  renderCalendar(document.getElementById('calendar'), state);
  reportsController.renderReportsSection(document.getElementById('reports'));
  const accountController = createAccountController({
    state,
    render,
    resendVerificationEmail,
    refreshAuthUser,
    syncSecuritySnapshot,
    sendForgotPasswordEmail,
    persistAppearancePreference: (next) => { state.ui = { ...(state.ui || {}), appearance: next }; },
    withGlobalBusy: globalBusy.withGlobalBusy
  });
  accountController.renderAccountSection(document.getElementById('account'));
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
    enrichAssetDocumentation,
    repairAssetDocumentationState,
    bootstrapAttachAssetManualFromCsvHint,
    createCompanyInvite,
    revokeInvite,
    sendForgotPasswordEmail,
    withGlobalBusy: globalBusy.withGlobalBusy,
    storage,
    storageRef,
    uploadBytes,
    getDownloadURL,
    buildCompanyBrandingLogoPath
  });
  adminController.renderAdminSection(document.getElementById('admin'));
  const appViewElement = document.getElementById('appView');
  appViewElement?.querySelector('.global-busy-overlay')?.remove();
  appViewElement?.insertAdjacentHTML('beforeend', renderGlobalBusyOverlay(state));

  if (state.route?.tab === 'operations' && Number.isFinite(state.operationsUi?.scrollY)) {
    requestAnimationFrame(() => window.scrollTo({ top: state.operationsUi.scrollY, behavior: 'auto' }));
  }

  navigationController.openTab(state.route.tab, state.route.taskId, state.route.assetId);
}

window.addEventListener('popstate', () => {
  navigationController.syncFromUrl();
});

authController.bindAuthUi();
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
    setBootstrapLoading(false);
    setRootViewVisibility({ authView, appView, showAuth: true });
    return;
  }
  try {
    authController.setAuthMessage('Finishing workspace setup…');
    setRootViewVisibility({ authView, appView, showAuth: false });
    setBootstrapLoading(true, 'Loading company, memberships, settings, and branding…');
    setActiveCompanyContext(null);
    setOnboardingFeedback(state, '', 'info', { pendingAction: '', handoffStatus: 'working' });
    state.user = { uid: user.uid, email: user.email, displayName: user.displayName };
    state.profile = await resolveProfile(user);
    state.profile = await syncSecuritySnapshot(user, state.profile);
    state.permissions = buildPermissionContext({ profile: state.profile, membership: null });
    if (state.profile.enabled === false) {
      await logout();
      authController.setAuthMessage('This account is disabled.');
      return;
    }
    const pendingInviteCode = `${state.onboardingUi?.inviteCodePrefill || ''}`.trim();
    if (pendingInviteCode) {
      try {
        await acceptCompanyInvite({ inviteCode: pendingInviteCode, user: state.user });
        state.onboardingUi = { ...(state.onboardingUi || {}), inviteCodePrefill: '' };
      } catch (error) {
        console.warn('[watchAuth] Pending invite acceptance failed during sign-in handoff.', error);
        authController.setAuthMessage(formatActionError(error, 'Signed in, but invite acceptance failed. You can retry from onboarding.'));
      }
    }
    if (!authMessage.textContent) authController.setAuthMessage('');
    setRootViewVisibility({ authView, appView, showAuth: false });
    await bootstrapCompanyContext();
    setBootstrapLoading(true, 'Loading workspace data…');
    await refreshData();
    await render();
    setBootstrapLoading(false);
  } catch (error) {
    if (canFallbackToOnboarding(error)) {
      console.warn('[watchAuth] Falling back to onboarding handoff without membership context.', error);
      const fallbackState = buildOnboardingFallbackState(state);
      Object.assign(state, fallbackState);
      state.permissions = buildPermissionContext({ profile: state.profile, membership: null });
      authController.setAuthMessage('');
      setOnboardingFeedback(state, 'Signed in. Continue with workspace setup.', 'info', { pendingAction: '', handoffStatus: 'degraded' });
      setBootstrapLoading(false);
      setRootViewVisibility({ authView, appView, showAuth: false });
      await render();
      return;
    }

    console.error('[watchAuth]', error);
    authController.setAuthMessage(buildBootstrapErrorMessage(error));
    setOnboardingFeedback(state, authMessage.textContent, 'error', { pendingAction: '', handoffStatus: 'error' });
    setBootstrapLoading(false);
    setRootViewVisibility({ authView, appView, showAuth: true });
    setActiveCompanyContext(null);
  }
});
