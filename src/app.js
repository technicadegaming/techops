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

const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const authMessage = document.getElementById('authMessage');

const sections = ['dashboard', 'operations', 'assets', 'calendar', 'reports', 'admin'];
const state = { user: null, profile: null, tasks: [], operations: [], assets: [], pmSchedules: [], manuals: [], notes: [], users: [], auditLogs: [], settings: {}, restorePayload: null };

function tabVisible(tab) {
  if (tab === 'admin') return state.profile?.role === 'admin';
  return true;
}

function buildTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = sections.filter(tabVisible).map((id) => `<button class="tab ${id === 'dashboard' ? 'active' : ''}" data-tab="${id}">${id}</button>`).join('');
  tabs.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
}

function openTab(name, anchorId = null) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === name));
  if (anchorId) setTimeout(() => document.getElementById(`task-${anchorId}`)?.scrollIntoView({ behavior: 'smooth' }), 100);
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
      if (payload.status === 'completed' && payload.assetId) {
        const asset = state.assets.find((a) => a.id === payload.assetId);
        await upsertEntity('assets', payload.assetId, {
          ...(asset || {}),
          history: [...(asset?.history || []), { at: new Date().toISOString(), note: `Task ${id} completed` }]
        }, state.user);
      }
      await refreshData(); render();
    },
    deleteTask: async (id) => {
      if (!canDelete(state.profile)) return;
      await deleteEntity('tasks', id, state.user); await refreshData(); render();
    }
  });
  renderAssets(document.getElementById('assets'), state, {
    saveAsset: async (id, payload) => { await upsertEntity('assets', id, { ...payload, history: payload.historyNote ? [{ at: new Date().toISOString(), note: payload.historyNote }] : [] }, state.user); await refreshData(); render(); },
    deleteAsset: async (id) => { if (!canDelete(state.profile)) return; await deleteEntity('assets', id, state.user); await refreshData(); render(); }
  });
  renderCalendar(document.getElementById('calendar'), state);
  renderReports(document.getElementById('reports'), state);
  renderAdmin(document.getElementById('admin'), state, {
    saveUserRole: async (uid, role, enabled) => {
      const admins = state.users.filter((u) => u.role === 'admin' && u.enabled !== false);
      if (uid === state.user.uid && state.profile.role === 'admin' && role !== 'admin' && admins.length <= 1) return alert('Cannot self-demote the last enabled admin.');
      const existing = state.users.find((u) => u.id === uid) || {};
      await saveUserProfile(uid, { ...existing, role, enabled }, state.user);
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
}

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
