import { login, logout, register, resolveProfile, watchAuth } from './auth.js';
import { clearEntitySet, countEntities, deleteEntity, getAppSettings, listAudit, listEntities, saveAppSettings, saveUserProfile, setActiveCompanyContext, upsertEntity } from './data.js';
import { renderDashboard } from './features/dashboard.js';
import { renderOperations } from './features/operations.js';
import { renderAssets } from './features/assets.js';
import { renderCalendar } from './features/calendar.js';
import { renderReports } from './features/reports.js';
import { renderAdmin } from './admin.js';
import { buildPermissionContext, canDelete, isAdmin, isGlobalAdmin, isManager } from './roles.js';
import { previewLegacyImport, importLegacyData } from './migration.js';
import { dryRunBackup, exportBackupJson, restoreBackup, validateBackup } from './backup.js';
import { analyzeTaskTroubleshooting, answerTaskFollowup, enrichAssetDocumentation, previewAssetDocumentationLookup, regenerateTaskTroubleshooting, saveTaskFixToTroubleshootingLibrary } from './aiAdapter.js';
import { buildCloseoutEvent, parseRouteState, pushRouteState } from './features/workflow.js';
import { acceptInvite, createCompanyFromOnboarding, createCompanyInvite, ensureBootstrapCompanyForLegacyUser, getCompany, listMembershipsByUser, revokeInvite } from './company.js';

const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const authMessage = document.getElementById('authMessage');
const activeCompanySwitcher = document.getElementById('activeCompanySwitcher');
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

const state = { user: null, profile: null, company: null, memberships: [], membershipCompanies: {}, activeMembership: null, permissions: buildPermissionContext(), onboardingRequired: false, tasks: [], operations: [], assets: [], pmSchedules: [], manuals: [], notes: [], users: [], workers: [], invites: [], companyLocations: [], importHistory: [], auditLogs: [], taskAiRuns: [], taskAiFollowups: [], troubleshootingLibrary: [], settings: {}, restorePayload: null, route: parseRouteState(), assetDraft: createEmptyAssetDraft(), operationsUi: { draft: {}, moreDetailsOpen: false, expandedTaskIds: [], scrollY: 0 } };

function formatActionError(error, fallbackMessage) {
  const detail = `${error?.message || error || ''}`.trim();
  return detail ? `${fallbackMessage} ${detail}` : fallbackMessage;
}

function reportActionError(label, error, fallbackMessage) {
  console.error(`[${label}]`, error);
  alert(formatActionError(error, fallbackMessage));
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

async function runAction(label, work, options = {}) {
  try {
    return await work();
  } catch (error) {
    reportActionError(label, error, options.fallbackMessage || `${label} failed.`);
    if (typeof options.onError === 'function') options.onError(error);
    return null;
  } finally {
    if (typeof options.onFinally === 'function') options.onFinally();
  }
}

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

async function refreshData() {
  state.tasks = await listEntities('tasks').catch(() => []);
  state.operations = await listEntities('operations').catch(() => []);
  state.assets = await listEntities('assets').catch(() => []);
  state.pmSchedules = await listEntities('pmSchedules').catch(() => []);
  state.manuals = await listEntities('manuals').catch(() => []);
  state.notes = await listEntities('notes').catch(() => []);
  state.users = await listEntities('users').catch(() => []);
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


function renderOnboarding(el) {
  el.innerHTML = `
    <h2>Welcome to WOW Technicade Operations</h2>
    <p class="tiny">Set up your company workspace to continue. Existing legacy data can be adopted into your first company safely.</p>
    <div class="grid grid-2">
      <form id="createCompanyForm" class="item">
        <h3>Create company</h3>
        <label>Company name<input name="name" placeholder="Example: WOW Technicade" required /></label>
        <label>Contact email<input name="primaryEmail" type="email" placeholder="name@company.com" value="${state.user?.email || ''}" /></label>
        <label>Primary phone<input name="primaryPhone" placeholder="Example: (555) 555-5555" /></label>
        <label>HQ address<input name="address" placeholder="Street, city, state" /></label>
        <label>Timezone<input name="timeZone" placeholder="Example: America/Chicago" value="${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}" /></label>
        <div class="row">
          <label style="flex:1;">Estimated users<input name="estimatedUsers" type="number" min="0" placeholder="Example: 25" /></label>
          <label style="flex:1;">Estimated assets<input name="estimatedAssets" type="number" min="0" placeholder="Example: 150" /></label>
        </div>
        <label>First location / primary location notes<textarea name="locations" placeholder="One per line: Name | Address | Timezone | Notes"></textarea></label>
        <button class="primary">Create company workspace</button>
      </form>
      <form id="joinCompanyForm" class="item">
        <h3>Join existing company</h3>
        <label>Invite code<input name="inviteCode" placeholder="Paste the code from your admin" required /></label>
        <button class="primary">Accept invite & join</button>
        <p class="tiny">Ask your admin for an invite code from the Admin &gt; Users/Invites section.</p>
      </form>
    </div>`;

  el.querySelector('#createCompanyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const locations = `${fd.get('locations') || ''}`.split('\n').map((line) => {
      const [name, address, timeZone, notes] = line.split('|').map((v) => `${v || ''}`.trim());
      return { name, address, timeZone, notes };
    }).filter((row) => row.name);
    await runAction('create_company', async () => {
      await createCompanyFromOnboarding(state.user, {
        name: fd.get('name'),
        primaryEmail: fd.get('primaryEmail'),
        primaryPhone: fd.get('primaryPhone'),
        address: fd.get('address'),
        timeZone: fd.get('timeZone'),
        estimatedUsers: fd.get('estimatedUsers'),
        estimatedAssets: fd.get('estimatedAssets'),
        locations
      });
      await bootstrapCompanyContext();
      await refreshData();
      render();
    }, {
      fallbackMessage: 'Unable to create company workspace.'
    });
  });

  el.querySelector('#joinCompanyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await runAction('accept_invite', async () => {
      await acceptInvite({ inviteCode: fd.get('inviteCode'), user: state.user });
      await bootstrapCompanyContext();
      await refreshData();
      render();
    }, {
      fallbackMessage: 'Unable to accept invite.'
    });
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
  document.getElementById('userBadge').textContent = `${state.user.email} (${roleLabel})${state.company?.name ? ` • ${state.company.name}` : ''}`;

  if (state.onboardingRequired) {
    renderOnboarding(document.getElementById('dashboard'));
    openTab('dashboard');
    return;
  }

  renderDashboard(document.getElementById('dashboard'), state, openTab);
  renderOperations(document.getElementById('operations'), state, {
    saveTask: async (_id, payload) => {
      const taskId = `${payload?.id || ''}`.trim() || `${_id || ''}`.trim();
      if (!taskId) return alert('Unable to save task: missing generated task ID.');
      const saved = await runAction('save_task', async () => {
        await upsertEntity('tasks', taskId, withRequiredCompanyId({ ...payload, id: taskId }, 'save a task'), state.user);
        await refreshData();
        render();
        return true;
      }, {
        fallbackMessage: 'Unable to save task.'
      });
      return !!saved;
    },
    reassignTask: async (taskId) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return;
      const worker = prompt('Reassign to worker uid/email:');
      if (!worker) return;
      await upsertEntity('tasks', taskId, { ...task, assignedWorkers: [worker.trim()] }, state.user);
      await refreshData(); render();
    },
    completeTask: async (taskId, closeout) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return;
      const saveToLibrary = closeout.saveToLibrary === 'yes' || (closeout.saveToLibrary !== 'no' && state.settings.aiSaveSuccessfulFixesToLibraryDefault);
      await upsertEntity('tasks', taskId, { ...task, status: 'completed', closeout: { ...closeout, completedAt: new Date().toISOString() } }, state.user);
      if (task.assetId) {
        const asset = state.assets.find((a) => a.id === task.assetId) || { id: task.assetId };
        const event = buildCloseoutEvent(taskId, closeout, state.user);
        await upsertEntity('assets', task.assetId, { ...asset, history: [...(asset.history || []), event] }, state.user);
      }
      if (saveToLibrary && closeout.fixPerformed) {
        await saveTaskFixToTroubleshootingLibrary({ taskId, successfulFix: closeout.bestFixSummary || closeout.fixPerformed });
      }
      await upsertEntity('auditLogs', `closeout-${taskId}-${Date.now()}`, { action: 'task_closeout', entityType: 'tasks', entityId: taskId, summary: `Task ${taskId} closeout saved` }, state.user);
      await refreshData(); render();
    },
    deleteTask: async (id) => {
      if (!canDelete(state.permissions)) return;
      await deleteEntity('tasks', id, state.user); await refreshData(); render();
    },
    runAi: async (taskId) => { await analyzeTaskTroubleshooting(taskId); await refreshData(); render(); },
    rerunAi: async (taskId) => { await regenerateTaskTroubleshooting(taskId); await refreshData(); render(); },
    submitFollowup: async (taskId, runId, answers) => { await answerTaskFollowup(taskId, runId, answers); await refreshData(); render(); },
    saveFix: async (taskId) => {
      const successfulFix = prompt('Summarize the successful fix for the troubleshooting library:');
      if (!successfulFix) return;
      await saveTaskFixToTroubleshootingLibrary({ taskId, successfulFix });
      await refreshData(); render();
    }
  });

  const assetActions = {
    saveAsset: async (id, payload) => {
      const name = `${payload.name || ''}`.trim();
      const manufacturer = `${payload.manufacturer || ''}`.trim();
      if (!name) return alert('Asset name is required.');
      if (!manufacturer) return alert('Manufacturer is required.');
      state.assetDraft = { ...(state.assetDraft || {}), saving: true, saveFeedback: '', saveFeedbackTone: 'success' };
      render();
      try {
        const desiredId = `${id || ''}`.trim() || normalizeAssetId(name);
        const current = state.assets.find((a) => a.id === desiredId) || {};
        const finalId = current.id ? desiredId : pickUniqueAssetId(desiredId, state.assets);
        const draft = state.assetDraft || {};
        const entityPayload = {
          ...current,
          ...payload,
          id: finalId,
          name,
          serialNumber: `${payload.serialNumber || current.serialNumber || ''}`.trim(),
          manufacturer: `${manufacturer || draft.manufacturer || current.manufacturer || ''}`.trim(),
          ownerWorkers: `${payload.ownerWorkers || ''}`.split(',').map((v) => v.trim()).filter(Boolean),
          manualLinks: `${payload.manualLinks || ''}`.split(',').map((v) => v.trim()).filter(Boolean).concat(Array.isArray(draft.manualLinks) ? draft.manualLinks : []).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 5),
          enrichmentStatus: (payload.manualLinks || current.manualLinks?.length) ? (current.enrichmentStatus || 'idle') : 'searching_docs',
          enrichmentRequestedAt: (payload.manualLinks || current.manualLinks?.length) ? (current.enrichmentRequestedAt || null) : new Date().toISOString(),
          history: payload.historyNote ? [...(current.history || []), { at: new Date().toISOString(), note: payload.historyNote }] : (current.history || []),
          supportResourcesSuggestion: Array.isArray(draft.supportResources) && draft.supportResources.length ? draft.supportResources : (current.supportResourcesSuggestion || []),
          supportContactsSuggestion: Array.isArray(draft.supportContacts) && draft.supportContacts.length ? draft.supportContacts : (current.supportContactsSuggestion || []),
          notes: `${payload.notes || ''}`.trim() || `${current.notes || ''}`.trim() || (draft.notes ? `${draft.notes}`.trim() : '')
        };
        await upsertEntity('assets', finalId, withRequiredCompanyId(entityPayload, 'save an asset'), state.user);
        state.assetDraft = { ...createEmptyAssetDraft(), saveFeedback: 'Asset saved - documentation search running.', saveFeedbackTone: 'success' };
        await refreshData();
        render();
        enrichAssetDocumentation(finalId, { trigger: 'post_save' })
          .then(async () => { await refreshData(); render(); })
          .catch(async (error) => {
            console.error('[asset_post_save_enrichment]', error);
            await refreshData();
            render();
          });
        return;
      } catch (error) {
        reportActionError('save_asset', error, 'Unable to save asset.');
        state.assetDraft = { ...(state.assetDraft || {}), saving: false, saveFeedback: formatActionError(error, 'Unable to save asset.'), saveFeedbackTone: 'error' };
        render();
        return;
      } finally {
        if (state.assetDraft?.saving) {
          state.assetDraft = { ...(state.assetDraft || {}), saving: false };
          render();
        }
      }
    },
    previewAssetLookup: async (payload) => {
      const assetName = `${payload?.assetName || ''}`.trim();
      const normalizedQuery = buildPreviewQueryKey(payload);
      const previewMeta = state.assetDraft?.previewMeta || { inFlightQuery: '', lastCompletedQuery: '' };
      const normalizedName = assetName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (assetName.length < 3 || !normalizedName) {
        state.assetDraft = {
          ...state.assetDraft,
          preview: null,
          previewStatus: 'idle',
          previewMeta: { ...previewMeta, inFlightQuery: '' },
          draftNameNormalized: normalizedName
        };
        render();
        return;
      }

      if (previewMeta.inFlightQuery === normalizedQuery || previewMeta.lastCompletedQuery === normalizedQuery) {
        return;
      }

      state.assetDraft = {
        ...state.assetDraft,
        previewStatus: payload?.reason === 'manufacturer_refine' ? 'searching_refined' : 'searching',
        previewMeta: { ...previewMeta, inFlightQuery: normalizedQuery },
        draftNameNormalized: normalizedName
      };
      render();

      try {
        const preview = await previewAssetDocumentationLookup(payload);
        state.assetDraft = {
          ...state.assetDraft,
          preview,
          previewStatus: preview?.status || 'found_suggestions',
          previewMeta: { inFlightQuery: '', lastCompletedQuery: normalizedQuery },
          draftNameNormalized: normalizedName
        };
      } catch (error) {
        state.assetDraft = {
          ...state.assetDraft,
          previewStatus: 'no_strong_match',
          previewMeta: { ...previewMeta, inFlightQuery: '' },
          draftNameNormalized: normalizedName
        };
      }
      render();
    },
    applyPreviewToDraft: (partialPayload = {}) => {
      const { triggerRefinedPreview, ...draftPatch } = partialPayload;
      state.assetDraft = { ...state.assetDraft, ...draftPatch };
      render();
      if (triggerRefinedPreview) {
        const draft = state.assetDraft || {};
        const name = `${draft.name || ''}`.trim();
        if (name.length >= 3) {
          const followupAnswer = draft.preview?.followupAnswer || '';
          assetActions.previewAssetLookup({
            assetName: name,
            manufacturer: `${draft.manufacturer || ''}`.trim(),
            serialNumber: `${draft.serialNumber || ''}`.trim(),
            assetId: `${draft.id || ''}`.trim(),
            followupAnswer,
            reason: 'manufacturer_refine'
          });
        }
      }
    },
    updateAssetDraftField: (field, value) => {
      state.assetDraft = { ...state.assetDraft, [field]: value };
    },
    handleDraftNameChange: (assetName) => {
      const normalizedName = `${assetName || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const previousNormalizedName = `${state.assetDraft?.draftNameNormalized || ''}`;
      const shouldClear = !normalizedName || (previousNormalizedName && normalizedName !== previousNormalizedName);
      if (!shouldClear) return;
      state.assetDraft = {
        ...state.assetDraft,
        preview: null,
        previewStatus: 'idle',
        previewMeta: { ...(state.assetDraft?.previewMeta || {}), inFlightQuery: '' },
        draftNameNormalized: normalizedName
      };
      render();
    },
    clearPreview: () => {
      state.assetDraft = {
        ...state.assetDraft,
        preview: null,
        previewStatus: 'idle',
        previewMeta: { ...(state.assetDraft?.previewMeta || {}), inFlightQuery: '' }
      };
      render();
    },
    runAssetEnrichment: async (id) => {
      const current = state.assets.find((a) => a.id === id) || {};
      await upsertEntity('assets', id, { ...current, enrichmentStatus: 'in_progress', enrichmentRequestedAt: new Date().toISOString() }, state.user);
      await refreshData(); render();
      await enrichAssetDocumentation(id, { trigger: 'manual' });
      await refreshData(); render();
    },
    submitEnrichmentFollowup: async (id, answer) => {
      const trimmedAnswer = `${answer || ''}`.trim();
      if (!trimmedAnswer) return alert('Please enter an answer before retrying enrichment.');
      const current = state.assets.find((a) => a.id === id) || {};
      await upsertEntity('assets', id, {
        ...current,
        enrichmentFollowupAnswer: trimmedAnswer,
        enrichmentFollowupAnsweredAt: new Date().toISOString(),
        enrichmentStatus: 'in_progress',
        enrichmentRequestedAt: new Date().toISOString()
      }, state.user);
      await refreshData(); render();
      await enrichAssetDocumentation(id, {
        trigger: 'followup_answer',
        followupAnswer: trimmedAnswer
      });
      await refreshData(); render();
    },
    applyDocSuggestions: async (id) => {
      if (!isAdmin(state.permissions)) return;

      const current = state.assets.find((a) => a.id === id) || {};
      const suggestions = Array.isArray(current.documentationSuggestions) ? current.documentationSuggestions : [];
      const strongSuggestions = suggestions
        .filter((s) => {
          const score = Number(s?.matchScore || 0);
          const isStrong = score >= 70 || (s?.isOfficial && score >= 62) || (s?.sourceType === 'manufacturer' && score >= 60);
          return isStrong && !!s?.verified;
        })
        .sort((a, b) => Number(b?.matchScore || 0) - Number(a?.matchScore || 0));
      const links = strongSuggestions.slice(0, 2).map((s) => s.url).filter(Boolean);
      if (!links.length) {
        const weakQuestion = current.enrichmentFollowupQuestion || 'Can you confirm cabinet type/version from the manufacturer plate?';
        await upsertEntity('assets', id, { ...current, enrichmentStatus: 'needs_follow_up', enrichmentFollowupQuestion: weakQuestion }, state.user);
        await refreshData(); render();
        return;
      }

      await upsertEntity('assets', id, { ...current, manualLinks: dedupeUrls([...(current.manualLinks || []), ...links]), enrichmentStatus: 'docs_found', enrichmentFollowupQuestion: '' }, state.user);
      await refreshData(); render();
    },
    applyEnrichmentSuggestions: async (id, mode) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((a) => a.id === id) || {};
      const patch = {};
      if (mode === 'manufacturer' || mode === 'all') {
        const suggestedManufacturer = `${current.manufacturerSuggestion || ''}`.trim();
        if (suggestedManufacturer) patch.manufacturer = suggestedManufacturer;
      }
      if (mode === 'manuals' || mode === 'all') {
        const strongManuals = (Array.isArray(current.documentationSuggestions) ? current.documentationSuggestions : [])
          .filter((s) => !!s?.verified)
          .sort((a, b) => Number(b?.matchScore || 0) - Number(a?.matchScore || 0))
          .map((s) => s?.url)
          .filter(Boolean)
          .slice(0, 2);
        if (strongManuals.length) patch.manualLinks = dedupeUrls([...(current.manualLinks || []), ...strongManuals]);
      }
      if (mode === 'support' || mode === 'all') {
        const supportLinks = (Array.isArray(current.supportResourcesSuggestion) ? current.supportResourcesSuggestion : [])
          .map((s) => s?.url)
          .filter(Boolean)
          .slice(0, 3);
        if (supportLinks.length) patch.supportResourcesSuggestion = normalizeSupportEntries([...(current.supportResourcesSuggestion || []), ...supportLinks.map((url) => ({ url }))]);
      }
      if (mode === 'contacts' || mode === 'all') {
        const contacts = Array.isArray(current.supportContactsSuggestion) ? current.supportContactsSuggestion : [];
        if (contacts.length) {
          patch.supportContactsSuggestion = contacts;
          const contactSummary = contacts.map((c) => `${c.label || c.contactType || 'contact'}: ${c.value || ''}`).filter(Boolean).join(' | ');
          patch.notes = [current.notes, contactSummary].filter(Boolean).join(' | ');
        }
      }
      if (!Object.keys(patch).length) return;
      await upsertEntity('assets', id, { ...current, ...patch }, state.user);
      await refreshData(); render();
    },
    applySingleDocSuggestion: async (id, index) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((a) => a.id === id) || {};
      const suggestions = Array.isArray(current.documentationSuggestions) ? current.documentationSuggestions : [];
      const selected = suggestions[index];
      const url = `${selected?.url || ''}`.trim();
      if (!url) return;
      await upsertEntity('assets', id, {
        ...current,
        manualLinks: dedupeUrls([...(current.manualLinks || []), url]),
        enrichmentStatus: 'docs_found'
      }, state.user);
      await refreshData(); render();
    },
    applySingleSupportSuggestion: async (id, index) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((a) => a.id === id) || {};
      const suggestions = Array.isArray(current.supportResourcesSuggestion) ? current.supportResourcesSuggestion : [];
      const selected = suggestions[index];
      const url = `${selected?.url || selected || ''}`.trim();
      if (!url) return;
      const label = selected?.label || selected?.title || url;
      await upsertEntity('assets', id, {
        ...current,
        supportResourcesSuggestion: normalizeSupportEntries([...(current.supportResourcesSuggestion || []), { url, label }])
      }, state.user);
      await refreshData(); render();
    },
    removeManualLink: async (id, url) => {
      if (!isAdmin(state.permissions)) return;
      const clean = `${url || ''}`.trim();
      if (!clean) return;
      const current = state.assets.find((a) => a.id === id) || {};
      await upsertEntity('assets', id, {
        ...current,
        manualLinks: (current.manualLinks || []).filter((entry) => `${entry}`.trim() !== clean)
      }, state.user);
      await refreshData(); render();
    },
    removeSupportLink: async (id, url) => {
      if (!isAdmin(state.permissions)) return;
      const clean = `${url || ''}`.trim();
      if (!clean) return;
      const current = state.assets.find((a) => a.id === id) || {};
      await upsertEntity('assets', id, {
        ...current,
        supportResourcesSuggestion: normalizeSupportEntries((current.supportResourcesSuggestion || []).filter((entry) => `${entry?.url || entry || ''}`.trim() !== clean))
      }, state.user);
      await refreshData(); render();
    },
    editAsset: async (currentId, payload) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((a) => a.id === currentId) || {};
      const nextId = `${payload.id || currentId}`.trim() || currentId;
      await upsertEntity('assets', nextId, {
        ...current,
        ...payload,
        id: nextId,
        name: `${payload.name || current.name || ''}`.trim(),
        serialNumber: `${payload.serialNumber || current.serialNumber || ''}`.trim(),
        manufacturer: `${payload.manufacturer || current.manufacturer || ''}`.trim(),
        manualLinks: `${payload.manualLinks || ''}`.split(',').map((v) => v.trim()).filter(Boolean)
      }, state.user);
      if (nextId !== currentId) await deleteEntity('assets', currentId, state.user);
      await refreshData(); render();
    },
    markDocsReviewed: async (id) => {
      const current = state.assets.find((a) => a.id === id) || {};
      await upsertEntity('assets', id, { ...current, docsLastReviewedAt: new Date().toISOString() }, state.user);
      await refreshData(); render();
    },
    clearAssetEnrichmentState: async (id) => {
      if (!isManager(state.permissions)) return;
      const current = state.assets.find((a) => a.id === id) || {};
      await upsertEntity('assets', id, {
        ...current,
        enrichmentStatus: 'idle',
        enrichmentFollowupQuestion: '',
        enrichmentFollowupAnswer: '',
        enrichmentRequestedAt: null
      }, state.user);
      await refreshData(); render();
    },
    deleteAsset: async (id) => { if (!canDelete(state.permissions)) return; await deleteEntity('assets', id, state.user); await refreshData(); render(); }
  };
  renderAssets(document.getElementById('assets'), state, assetActions);
  renderCalendar(document.getElementById('calendar'), state);
  renderReports(document.getElementById('reports'), state);
  renderAdmin(document.getElementById('admin'), state, {
    saveWorker: async (id, payload) => {
      const existing = state.workers.find((u) => u.id === id) || {};
      await upsertEntity('workers', id, { ...existing, ...payload, accountStatus: existing.accountStatus || (payload.email ? 'invited_or_unlinked' : 'directory_only') }, state.user);
      await refreshData(); render();
    },
    createWorker: async (payload) => {
      const id = `worker-${Date.now().toString(36)}`;
      await upsertEntity('workers', id, {
        id,
        displayName: `${payload.displayName || ''}`.trim(),
        email: `${payload.email || ''}`.trim().toLowerCase(),
        role: payload.role || 'staff',
        enabled: true,
        available: true,
        skills: [],
        inviteStatus: 'not_invited',
        accountStatus: payload.email ? 'unlinked' : 'directory_only',
        phone: '',
        defaultLocationId: ''
      }, state.user);
      await refreshData(); render();
    },
    createInvite: async ({ email, role }) => {
      await runAction('create_invite', async () => {
        const invite = await createCompanyInvite({ companyId: state.company.id, email, role, user: state.user });
        state.invites = [
          {
            id: invite.id,
            companyId: state.company.id,
            email: `${email || ''}`.trim().toLowerCase(),
            role,
            inviteCode: invite.inviteCode,
            token: invite.token,
            status: 'pending'
          },
          ...(state.invites || []).filter((entry) => entry.id !== invite.id)
        ];
        render();
        alert(`Invite created. Share code: ${invite.inviteCode}`);
        await refreshData();
        render();
      }, {
        fallbackMessage: 'Unable to create invite.'
      });
    },
    revokeInvite: async (inviteId) => { await revokeInvite(inviteId, state.user); await refreshData(); render(); },
    addLocation: async (payload) => {
      const id = `loc-${Date.now().toString(36)}`;
      await runAction('add_location', async () => {
        await upsertEntity('companyLocations', id, withRequiredCompanyId({ id, ...payload }, 'add a company location'), state.user);
        await refreshData();
        render();
      }, {
        fallbackMessage: 'Unable to add company location.'
      });
    },
    downloadAssetTemplate: () => downloadFile('asset-template.csv', 'asset name,assetId,manufacturer,model,serial,location,zone,notes,category,status\n', 'text/csv'),
    downloadEmployeeTemplate: () => downloadFile('employee-template.csv', 'name,email,role,enabled,available,shift start,skills,location,phone\n', 'text/csv'),
    importAssets: async (rows) => {
      for (const row of rows) {
        const id = `${row.assetId || row.id || normalizeAssetId(row['asset name'] || row.name || '')}`;
        if (!id) continue;
        await upsertEntity('assets', id, withRequiredCompanyId({
          id,
          name: row['asset name'] || row.name || id,
          manufacturer: row.manufacturer || '',
          model: row.model || '',
          serialNumber: row.serial || row.serialNumber || '',
          locationName: row.location || '',
          zone: row.zone || row.area || '',
          notes: row.notes || '',
          category: row.category || row.type || '',
          status: row.status || 'active'
        }, 'import assets'), state.user);
      }
      await upsertEntity('importHistory', `import-assets-${Date.now()}`, { type: 'assets', rowCount: rows.length }, state.user);
      await refreshData(); render();
    },
    importEmployees: async (rows) => {
      for (const row of rows) {
        const id = `worker-${(row.email || row.name || Date.now()).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        await upsertEntity('workers', id, {
          id,
          displayName: row.name || '',
          email: (row.email || '').toLowerCase(),
          role: row.role || 'staff',
          enabled: `${row.enabled || 'true'}`.toLowerCase() !== 'false',
          available: `${row.available || 'true'}`.toLowerCase() !== 'false',
          shiftStart: row['shift start'] || row.shiftStart || '',
          skills: `${row.skills || ''}`.split(/[|;]+/).map((v) => v.trim()).filter(Boolean),
          locationName: row.location || '',
          phone: row.phone || '',
          accountStatus: row.email ? 'unlinked' : 'directory_only'
        }, state.user);
      }
      await upsertEntity('importHistory', `import-employees-${Date.now()}`, { type: 'employees', rowCount: rows.length }, state.user);
      await refreshData(); render();
    },
    exportBackup: async () => downloadJson(`wow-backup-${Date.now()}.json`, await exportBackupJson()),
    clearTasks: async () => {
      const n1 = await clearEntitySet('tasks', state.user);
      const n2 = await clearEntitySet('operations', state.user);
      alert(`Cleared ${n1} tasks and ${n2} operations.`);
      await refreshData(); render();
    },
    clearAssets: async () => {
      const n = await clearEntitySet('assets', state.user);
      alert(`Cleared ${n} assets.`);
      await refreshData(); render();
    },
    clearWorkers: async () => {
      const n = await clearEntitySet('workers', state.user, (w) => (w.email || '').toLowerCase() !== (state.user.email || '').toLowerCase());
      alert(`Cleared ${n} worker directory entries.`);
      await refreshData(); render();
    },
    resetWorkspace: async () => {
      await clearEntitySet('tasks', state.user);
      await clearEntitySet('operations', state.user);
      await clearEntitySet('assets', state.user);
      await clearEntitySet('notes', state.user);
      await clearEntitySet('manuals', state.user);
      await clearEntitySet('taskAiRuns', state.user);
      await clearEntitySet('taskAiFollowups', state.user);
      await clearEntitySet('troubleshootingLibrary', state.user);
      alert('Workspace reset complete. Company profile, owner membership, and locations were kept.');
      await refreshData(); render();
    },
    saveAISettings: async (settings) => { await saveAppSettings(settings, state.user); await refreshData(); render(); }
  });

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
  try { await register(fd.get('email'), fd.get('password')); } catch (err) { authMessage.textContent = err.message; }
});

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
