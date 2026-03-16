import { login, logout, register, resolveProfile, watchAuth } from './auth.js';
import { clearEntitySet, countEntities, deleteEntity, getAppSettings, listAudit, listEntities, saveAppSettings, saveUserProfile, setActiveCompanyContext, upsertEntity } from './data.js';
import { renderDashboard } from './features/dashboard.js';
import { renderOperations } from './features/operations.js';
import { renderAssets } from './features/assets.js';
import { renderCalendar } from './features/calendar.js';
import { renderReports } from './features/reports.js';
import { renderAdmin } from './admin.js';
import { renderOnboarding } from './onboarding.js';
import { formatActionError, runActionFactory } from './uiActions.js';
import { buildPermissionContext, canDelete, isAdmin, isGlobalAdmin, isManager } from './roles.js';
import { previewLegacyImport, importLegacyData } from './migration.js';
import { dryRunBackup, exportBackupJson, restoreBackup, validateBackup } from './backup.js';
import { analyzeTaskTroubleshooting, answerTaskFollowup, enrichAssetDocumentation, previewAssetDocumentationLookup, regenerateTaskTroubleshooting, saveTaskFixToTroubleshootingLibrary } from './aiAdapter.js';
import { buildCloseoutEvent, parseRouteState, pushRouteState } from './features/workflow.js';
import { acceptInvite, createCompanyFromOnboarding, createCompanyInvite, ensureBootstrapCompanyForLegacyUser, getCompany, listCompanyMembers, listMembershipsByUser, revokeInvite } from './company.js';
import { buildLocationOptions, getLocationSelection, getLocationScopeLabel } from './features/locationContext.js';
import { createOperationsActions } from './features/operationsActions.js';
import { createAssetActions } from './features/assetActions.js';
import { createAdminActions } from './features/adminActions.js';

const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const authMessage = document.getElementById('authMessage');
const activeCompanySwitcher = document.getElementById('activeCompanySwitcher');
const activeLocationSwitcher = document.getElementById('activeLocationSwitcher');
const locationScopeBadge = document.getElementById('locationScopeBadge');
const ACTIVE_MEMBERSHIP_STORAGE_KEY = 'techops.activeMembership';

const sections = ['dashboard', 'operations', 'assets', 'calendar', 'reports', 'admin'];
function createEmptyAssetDraft() {
  return {
    name: '',
    serialNumber: '',
    manufacturer: '',
    id: '',
    status: '',
    ownerWorkers: '',
    manualLinksText: '',
    historyNote: '',
    notes: '',
    manualLinks: [],
    supportResources: [],
    supportContacts: [],
    preview: null,
    previewStatus: 'idle',
    previewMeta: { inFlightQuery: '', lastCompletedQuery: '' },
    draftNameNormalized: '',
    saveFeedback: '',
    saveSecondaryFeedback: '',
    saveDebugContext: '',
    saveFeedbackTone: 'success',
    saving: false
  };
}

function buildPreviewQueryKey(payload = {}) {
  const assetName = `${payload.assetName || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const manufacturer = `${payload.manufacturer || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const serialNumber = `${payload.serialNumber || ''}`.trim().toLowerCase();
  const assetId = `${payload.assetId || ''}`.trim().toLowerCase();
  const followupAnswer = `${payload.followupAnswer || ''}`.trim().toLowerCase();
  return [assetName, manufacturer, serialNumber, assetId, followupAnswer].join('|');
}

const state = {
  user: null,
  profile: null,
  company: null,
  memberships: [],
  membershipCompanies: {},
  activeMembership: null,
  permissions: buildPermissionContext(),
  onboardingRequired: false,
  tasks: [],
  operations: [],
  assets: [],
  pmSchedules: [],
  manuals: [],
  notes: [],
  users: [],
  companyMembers: [],
  workers: [],
  invites: [],
  companyLocations: [],
  importHistory: [],
  auditLogs: [],
  taskAiRuns: [],
  taskAiFollowups: [],
  troubleshootingLibrary: [],
  settings: {},
  restorePayload: null,
  route: parseRouteState(),
  assetDraft: createEmptyAssetDraft(),
  assetUi: { lastActionByAsset: {} },
  adminUi: { tone: 'info', message: '', importPreview: '', importSummary: '', importTone: 'info' },
  operationsUi: { draft: {}, moreDetailsOpen: false, expandedTaskIds: [], scrollY: 0, statusFilter: 'open', ownershipFilter: 'all', lastSaveFeedback: '', lastSaveTone: 'info' },
  adminSection: 'company'
};

function isPermissionRelatedError(error) {
  const code = `${error?.code || ''}`.toLowerCase();
  const message = `${error?.message || error || ''}`.toLowerCase();
  return code.includes('permission-denied') || message.includes('permission') || message.includes('missing or insufficient permissions');
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

function reportActionError(label, error, fallbackMessage) {
  console.error(`[${label}]`, error);
  alert(formatActionError(error, fallbackMessage));
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

function requireActiveCompanyId(actionLabel = 'continue') {
  const companyId = `${state.company?.id || state.activeMembership?.companyId || state.memberships?.[0]?.companyId || ''}`.trim();
  if (!companyId) {
    throw new Error(`No active company context is available. Complete onboarding before trying to ${actionLabel}.`);
  }
  return companyId;
}

function getStoredActiveMembershipId() {
  const userId = `${state.user?.uid || ''}`.trim();
  if (!userId) return '';
  try {
    return localStorage.getItem(`${ACTIVE_MEMBERSHIP_STORAGE_KEY}:${userId}`) || '';
  } catch {
    return '';
  }
}

function storeActiveMembershipId(membershipId) {
  const userId = `${state.user?.uid || ''}`.trim();
  if (!userId) return;
  try {
    if (membershipId) {
      localStorage.setItem(`${ACTIVE_MEMBERSHIP_STORAGE_KEY}:${userId}`, membershipId);
      return;
    }
    localStorage.removeItem(`${ACTIVE_MEMBERSHIP_STORAGE_KEY}:${userId}`);
  } catch {
    // Ignore local storage failures and keep the selection in memory.
  }
}

function withRequiredCompanyId(payload = {}, actionLabel = 'continue') {
  return { ...payload, companyId: requireActiveCompanyId(actionLabel) };
}

const runAction = runActionFactory({ reportActionError });

function tabVisible(tab) {
  if (state.onboardingRequired) return tab === 'dashboard';
  if (tab === 'admin') return isAdmin(state.permissions);
  return true;
}

function buildTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = sections.filter(tabVisible).map((id) => `<button class="tab ${id === state.route.tab ? 'active' : ''}" data-tab="${id}">${id}</button>`).join('');
  tabs.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
}

function openTab(name, taskId = null, assetId = null) {
  state.route = { ...state.route, tab: name, taskId: taskId || null, assetId: assetId || null };
  pushRouteState(state.route);
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === name));
  if (taskId) setTimeout(() => document.getElementById(`task-${taskId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
  if (assetId) setTimeout(() => document.getElementById(`asset-${assetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
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

async function refreshData() {
  state.tasks = await listEntities('tasks').catch(() => []);
  state.operations = await listEntities('operations').catch(() => []);
  state.assets = await listEntities('assets').catch(() => []);
  state.pmSchedules = await listEntities('pmSchedules').catch(() => []);
  state.manuals = await listEntities('manuals').catch(() => []);
  state.notes = await listEntities('notes').catch(() => []);
  state.users = await listEntities('users').catch(() => []);
  state.companyMembers = state.company?.id ? await listCompanyMembers(state.company.id).catch(() => []) : [];
  state.workers = await listEntities('workers').catch(() => []);
  state.invites = await listEntities('companyInvites').catch(() => []);
  state.companyLocations = await listEntities('companyLocations').catch(() => []);
  state.importHistory = await listEntities('importHistory').catch(() => []);
  state.settings = await getAppSettings().catch(() => ({}));
  state.auditLogs = await listAudit().catch(() => []);
  state.taskAiRuns = await listEntities('taskAiRuns').catch(() => []);
  state.taskAiFollowups = await listEntities('taskAiFollowups').catch(() => []);
  state.troubleshootingLibrary = await listEntities('troubleshootingLibrary').catch(() => []);
}

async function hydrateMembershipCompanies(memberships = []) {
  const companyEntries = await Promise.all((memberships || []).map(async (membership) => {
    const company = await getCompany(membership.companyId).catch(() => null);
    return [membership.id, company];
  }));
  state.membershipCompanies = Object.fromEntries(companyEntries);
}

async function setActiveMembership(nextMembership, options = {}) {
  const membershipId = typeof nextMembership === 'string' ? nextMembership : nextMembership?.id;
  const membership = (state.memberships || []).find((entry) => entry.id === membershipId) || (typeof nextMembership === 'object' ? nextMembership : null);
  if (!membership) {
    state.activeMembership = null;
    state.company = null;
    state.permissions = buildPermissionContext({ profile: state.profile, membership: null });
    state.onboardingRequired = true;
    storeActiveMembershipId('');
    setActiveCompanyContext(null);
    if (!options.skipRender) render();
    return;
  }

  state.activeMembership = membership;
  state.permissions = buildPermissionContext({ profile: state.profile, membership });
  const company = state.membershipCompanies?.[membership.id] || await getCompany(membership.companyId);
  state.membershipCompanies = { ...state.membershipCompanies, [membership.id]: company };
  state.company = company;
  state.onboardingRequired = false;
  storeActiveMembershipId(membership.id);
  setActiveCompanyContext(company?.id || membership.companyId, { allowLegacy: isGlobalAdmin(state.permissions) });

  if (!options.skipRefresh) await refreshData();
  if (!options.skipRender) render();
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


async function bootstrapCompanyContext() {
  setActiveCompanyContext(null);
  const memberships = await listMembershipsByUser(state.user.uid);
  state.memberships = memberships;
  const hasLegacyData = (await countEntities('assets').catch(() => 0)) + (await countEntities('tasks').catch(() => 0)) + (await countEntities('operations').catch(() => 0)) > 0;
  if (!memberships.length) {
    const adopted = await ensureBootstrapCompanyForLegacyUser(state.user, state.profile, hasLegacyData);
    if (adopted?.membership) {
      state.memberships = [adopted.membership];
    }
  }

  await hydrateMembershipCompanies(state.memberships);
  const currentMembershipId = `${state.activeMembership?.id || ''}`.trim();
  const storedMembershipId = getStoredActiveMembershipId();
  const activeMembership = state.memberships.find((membership) => membership.id === currentMembershipId)
    || state.memberships.find((membership) => membership.id === storedMembershipId)
    || state.memberships[0]
    || null;
  await setActiveMembership(activeMembership, { skipRefresh: true, skipRender: true });
}

async function render() {
  buildTabs();
  const roleLabel = state.permissions.companyRole || state.profile?.role || 'pending';
  renderActiveCompanySwitcher();
  renderActiveLocationSwitcher();
  document.getElementById('userBadge').textContent = `${state.user.email} (${roleLabel})${state.company?.name ? ` | ${state.company.name}` : ''}`;

  if (state.onboardingRequired) {
    renderOnboarding(document.getElementById('dashboard'), state, {
      createCompany: async (payload) => {
        await runAction('create_company', async () => {
          await createCompanyFromOnboarding(state.user, payload);
          await bootstrapCompanyContext();
          await refreshData();
          render();
        }, { fallbackMessage: 'Unable to create company workspace.' });
      },
      acceptInvite: async (inviteCode) => {
        await runAction('accept_invite', async () => {
          await acceptInvite({ inviteCode, user: state.user });
          await bootstrapCompanyContext();
          await refreshData();
          render();
        }, { fallbackMessage: 'Unable to accept invite.' });
      }
    });
    openTab('dashboard');
    return;
  }

  renderDashboard(document.getElementById('dashboard'), state, openTab);

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
      if ((payload.status === 'in_progress' || payload.status === 'completed') && !(payload.assignedWorkers || []).length) {
        alert('Assign a worker before moving a task into progress or completion.');
        return false;
      }
      const saved = await runAction('save_task', async () => {
        await upsertEntity('tasks', taskId, withRequiredCompanyId({ ...payload, id: taskId }, 'save a task'), state.user);
        state.operationsUi = {
          ...(state.operationsUi || {}),
          lastSaveFeedback: `Task ${taskId} saved for ${payload.assetName || payload.assetId || 'the selected asset'}.`,
          lastSaveTone: 'success'
        };
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
    reassignTask: async (taskId) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const nextWorker = `${state.operationsUi?.reassignSelections?.[taskId] || ''}`.trim();
      if (!nextWorker) {
        alert('Select a worker before reassigning.');
        return;
      }
      await upsertEntity('tasks', taskId, { ...task, assignedWorkers: [nextWorker], updatedAtClient: new Date().toISOString() }, state.user);
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
    completeTask: async (taskId, closeout) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const saveToLibrary = closeout.saveToLibrary === 'yes' || (closeout.saveToLibrary !== 'no' && state.settings.aiSaveSuccessfulFixesToLibraryDefault);
      await upsertEntity('tasks', taskId, { ...task, status: 'completed', closeout: { ...closeout, completedAt: new Date().toISOString() } }, state.user);
      if (task.assetId) {
        const asset = state.assets.find((entry) => entry.id === task.assetId) || { id: task.assetId };
        const event = buildCloseoutEvent(taskId, closeout, state.user);
        await upsertEntity('assets', task.assetId, { ...asset, history: [...(asset.history || []), event] }, state.user);
      }
      if (saveToLibrary && closeout.fixPerformed) await saveTaskFixToTroubleshootingLibrary({ taskId, successfulFix: closeout.bestFixSummary || closeout.fixPerformed });
      await upsertEntity('auditLogs', `closeout-${taskId}-${Date.now()}`, { action: 'task_closeout', entityType: 'tasks', entityId: taskId, summary: `Task ${taskId} closeout saved` }, state.user);
      await refreshData();
      render();
    },
    deleteTask: async (id) => {
      if (!canDelete(state.permissions)) return;
      await deleteEntity('tasks', id, state.user);
      await refreshData();
      render();
    },
    runAi: async (taskId) => { await analyzeTaskTroubleshooting(taskId); await refreshData(); render(); },
    rerunAi: async (taskId) => { await regenerateTaskTroubleshooting(taskId); await refreshData(); render(); },
    submitFollowup: async (taskId, runId, answers) => { await answerTaskFollowup(taskId, runId, answers); await refreshData(); render(); },
    saveFix: async (taskId) => {
      const successfulFix = prompt('Summarize the successful fix for the troubleshooting library:');
      if (!successfulFix) return;
      await saveTaskFixToTroubleshootingLibrary({ taskId, successfulFix });
      await refreshData();
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
    withRequiredCompanyId,
    upsertEntity,
    deleteEntity,
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
  renderReports(document.getElementById('reports'), state);
  renderAdmin(document.getElementById('admin'), state, createAdminActions({
    state,
    render,
    refreshData,
    runAction,
    withRequiredCompanyId,
    upsertEntity,
    clearEntitySet,
    saveAppSettings,
    exportBackupJson,
    downloadFile,
    downloadJson,
    normalizeAssetId,
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
  try { await login(fd.get('email'), fd.get('password')); } catch (err) { authMessage.textContent = err.message; }
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
    await register(fd.get('email'), password, { fullName });
    authMessage.textContent = 'Account created. Continue with company setup or invite acceptance.';
  } catch (err) { authMessage.textContent = err.message; }
});

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

watchAuth(async (user) => {
  if (!user) {
    setActiveCompanyContext(null);
    authView.classList.remove('hide');
    appView.classList.add('hide');
    return;
  }
  state.user = { uid: user.uid, email: user.email, displayName: user.displayName };
  state.profile = await resolveProfile(user);
  state.permissions = buildPermissionContext({ profile: state.profile, membership: null });
  if (state.profile.enabled === false) {
    await logout();
    authMessage.textContent = 'This account is disabled.';
    return;
  }
  authView.classList.add('hide');
  appView.classList.remove('hide');
  await bootstrapCompanyContext();
  await refreshData();
  await render();
});
