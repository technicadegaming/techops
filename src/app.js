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
import { analyzeTaskTroubleshooting, answerTaskFollowup, regenerateTaskTroubleshooting, saveTaskFixToTroubleshootingLibrary } from './aiAdapter.js';
import { buildCloseoutEvent, parseRouteState, pushRouteState } from './features/workflow.js';

const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const authMessage = document.getElementById('authMessage');

const sections = ['dashboard', 'operations', 'assets', 'calendar', 'reports', 'admin'];
const state = { user: null, profile: null, tasks: [], operations: [], assets: [], pmSchedules: [], manuals: [], notes: [], users: [], auditLogs: [], taskAiRuns: [], taskAiFollowups: [], troubleshootingLibrary: [], settings: {}, restorePayload: null, route: parseRouteState() };

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
  renderAssets(document.getElementById('assets'), state, {
    saveAsset: async (id, payload) => {
      const current = state.assets.find((a) => a.id === id) || {};
      await upsertEntity('assets', id, {
        ...current,
        ...payload,
        ownerWorkers: `${payload.ownerWorkers || ''}`.split(',').map((v) => v.trim()).filter(Boolean),
        manualLinks: `${payload.manualLinks || ''}`.split(',').map((v) => v.trim()).filter(Boolean),
        history: payload.historyNote ? [...(current.history || []), { at: new Date().toISOString(), note: payload.historyNote }] : (current.history || [])
      }, state.user);
      await refreshData(); render();
    },
    markDocsReviewed: async (id) => {
      const current = state.assets.find((a) => a.id === id) || {};
      await upsertEntity('assets', id, { ...current, docsLastReviewedAt: new Date().toISOString() }, state.user);
      await refreshData(); render();
    },
    deleteAsset: async (id) => { if (!canDelete(state.profile)) return; await deleteEntity('assets', id, state.user); await refreshData(); render(); }
  });
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
