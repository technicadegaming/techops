import { login, logout, register, resolveProfile, watchAuth } from './auth.js';
import { deleteEntity, getAppSettings, listAudit, listEntities, saveAppSettings, saveUserProfile, upsertEntity } from './data.js';
import { renderDashboard } from './features/dashboard.js';
import { renderOperations } from './features/operations.js';
import { renderAssets } from './features/assets.js';
import { renderCalendar } from './features/calendar.js';
import { renderReports } from './features/reports.js';
import { renderAdmin } from './admin.js';
import { canDelete } from './roles.js';
import { previewLegacyImport, importLegacyData } from './migration.js';
import { dryRunBackup, exportBackupJson, restoreBackup, validateBackup } from './backup.js';
import { analyzeTaskTroubleshooting, answerTaskFollowup, enrichAssetDocumentation, previewAssetDocumentationLookup, regenerateTaskTroubleshooting, saveTaskFixToTroubleshootingLibrary } from './aiAdapter.js';
import { buildCloseoutEvent, parseRouteState, pushRouteState } from './features/workflow.js';

const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const authMessage = document.getElementById('authMessage');

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

const state = { user: null, profile: null, tasks: [], operations: [], assets: [], pmSchedules: [], manuals: [], notes: [], users: [], auditLogs: [], taskAiRuns: [], taskAiFollowups: [], troubleshootingLibrary: [], settings: {}, restorePayload: null, route: parseRouteState(), assetDraft: createEmptyAssetDraft() };

function tabVisible(tab) {
  if (tab === 'admin') return state.profile?.role === 'admin';
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
  state.settings = await getAppSettings().catch(() => ({}));
  state.auditLogs = await listAudit().catch(() => []);
  state.taskAiRuns = await listEntities('taskAiRuns').catch(() => []);
  state.taskAiFollowups = await listEntities('taskAiFollowups').catch(() => []);
  state.troubleshootingLibrary = await listEntities('troubleshootingLibrary').catch(() => []);
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

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}



async function render() {
  buildTabs();
  document.getElementById('userBadge').textContent = `${state.user.email} (${state.profile.role})`;

  renderDashboard(document.getElementById('dashboard'), state, openTab);
  renderOperations(document.getElementById('operations'), state, {
    saveTask: async (id, payload) => {
      await upsertEntity('tasks', id, payload, state.user);
      await refreshData(); render();
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
      if (!canDelete(state.profile)) return;
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
      state.assetDraft = { ...(state.assetDraft || {}), saving: true, saveFeedback: '' };
      render();
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
        history: payload.historyNote ? [...(current.history || []), { at: new Date().toISOString(), note: payload.historyNote }] : (current.history || []),
        supportResourcesSuggestion: Array.isArray(draft.supportResources) && draft.supportResources.length ? draft.supportResources : (current.supportResourcesSuggestion || []),
        supportContactsSuggestion: Array.isArray(draft.supportContacts) && draft.supportContacts.length ? draft.supportContacts : (current.supportContactsSuggestion || []),
        notes: `${payload.notes || ''}`.trim() || `${current.notes || ''}`.trim() || (draft.notes ? `${draft.notes}`.trim() : '')
      };
      await upsertEntity('assets', finalId, entityPayload, state.user);
      state.assetDraft = { ...createEmptyAssetDraft(), saveFeedback: 'Asset saved — documentation search running.' };
      await refreshData();
      render();
      enrichAssetDocumentation(finalId, { trigger: 'post_save' })
        .then(async () => { await refreshData(); render(); })
        .catch(async () => { await refreshData(); render(); });
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
      await upsertEntity('assets', id, { ...current, enrichmentStatus: 'in_progress' }, state.user);
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
        enrichmentStatus: 'in_progress'
      }, state.user);
      await refreshData(); render();
      await enrichAssetDocumentation(id, {
        trigger: 'followup_answer',
        followupAnswer: trimmedAnswer
      });
      await refreshData(); render();
    },
    applyDocSuggestions: async (id) => {
      if (state.profile?.role !== 'admin') return;

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

      await upsertEntity('assets', id, { ...current, manualLinks: links, enrichmentStatus: 'docs_found', enrichmentFollowupQuestion: '' }, state.user);
      await refreshData(); render();
    },
    applyEnrichmentSuggestions: async (id, mode) => {
      if (state.profile?.role !== 'admin') return;
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
        if (strongManuals.length) patch.manualLinks = strongManuals;
      }
      if (mode === 'support' || mode === 'all') {
        const supportLinks = (Array.isArray(current.supportResourcesSuggestion) ? current.supportResourcesSuggestion : [])
          .map((s) => s?.url)
          .filter(Boolean)
          .slice(0, 3);
        if (supportLinks.length) patch.supportResourcesSuggestion = supportLinks.map((url) => ({ url }));
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
    editAsset: async (currentId, payload) => {
      if (state.profile?.role !== 'admin') return;
      const current = state.assets.find((a) => a.id === currentId) || {};
      const nextId = `${payload.id || currentId}`.trim() || currentId;
      await upsertEntity('assets', nextId, {
        ...current,
        ...payload,
        id: nextId,
        name: `${payload.name || current.name || ''}`.trim(),
        serialNumber: `${payload.serialNumber || current.serialNumber || ''}`.trim(),
        manufacturer: `${payload.manufacturer || draft.manufacturer || current.manufacturer || ''}`.trim(),
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
    deleteAsset: async (id) => { if (!canDelete(state.profile)) return; await deleteEntity('assets', id, state.user); await refreshData(); render(); }
  };
  renderAssets(document.getElementById('assets'), state, assetActions);
  renderCalendar(document.getElementById('calendar'), state);
  renderReports(document.getElementById('reports'), state);
  renderAdmin(document.getElementById('admin'), state, {
    saveUserRole: async (uid, role, enabled, extra = {}) => {
      const admins = state.users.filter((u) => u.role === 'admin' && u.enabled !== false);
      if (uid === state.user.uid && state.profile.role === 'admin' && role !== 'admin' && admins.length <= 1) return alert('Cannot self-demote the last enabled admin.');
      const existing = state.users.find((u) => u.id === uid) || {};
      await saveUserProfile(uid, { ...existing, role, enabled, ...extra }, state.user);
      await refreshData(); render();
    },
    previewImport: async () => previewLegacyImport(),
    runImport: async () => { await importLegacyData(state.user); await refreshData(); render(); },
    exportBackup: async () => downloadJson(`wow-backup-${Date.now()}.json`, await exportBackupJson()),
    loadRestorePayload: (text) => {
      try {
        const parsed = JSON.parse(text);
        const check = validateBackup(parsed);
        if (!check.ok) throw new Error(check.errors.join('\n'));
        state.restorePayload = parsed;
        document.getElementById('restorePreview').textContent = JSON.stringify(dryRunBackup(parsed), null, 2);
      } catch (err) {
        alert(`Invalid restore payload: ${err.message}`);
      }
    },
    runRestore: async () => {
      if (!state.restorePayload) return alert('No restore payload loaded.');
      await restoreBackup(state.restorePayload, state.user);
      await refreshData(); render();
    },
    saveAISettings: async (settings) => { await saveAppSettings(settings, state.user); await refreshData(); render(); },
    filterAudit: async (filters) => { state.auditLogs = await listAudit(filters); render(); }
  });

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
    authView.classList.remove('hide');
    appView.classList.add('hide');
    return;
  }
  state.user = { uid: user.uid, email: user.email, displayName: user.displayName };
  state.profile = await resolveProfile(user);
  if (state.profile.enabled === false) {
    await logout();
    authMessage.textContent = 'This account is disabled.';
    return;
  }
  authView.classList.add('hide');
  appView.classList.remove('hide');
  await refreshData();
  await render();
});
