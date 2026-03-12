import { Roles, canChangeAISettings, canManageBackups, canManageUsers, isAdmin } from './roles.js';

export function renderAdmin(el, state, actions) {
  if (!isAdmin(state.profile)) {
    el.innerHTML = '<h2>Admin</h2><p class="tiny">Admin access required.</p>';
    return;
  }
  el.innerHTML = `
    <h2>Admin Controls</h2>
    <div class="grid grid-2">
      <section class="item">
        <h3>User management</h3>
        <table class="table"><thead><tr><th>Email</th><th>Role</th><th>Enabled</th><th>Save</th></tr></thead><tbody>
        ${state.users.map((u) => `<tr><td>${u.email || u.id}</td><td>
          <select data-role="${u.id}" ${canManageUsers(state.profile) ? '' : 'disabled'}>${Object.values(Roles).map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
        </td><td><input type="checkbox" data-enabled="${u.id}" ${u.enabled !== false ? 'checked' : ''} ${canManageUsers(state.profile) ? '' : 'disabled'} /></td>
        <td><button data-save-user="${u.id}">Save</button></td></tr>`).join('')}
        </tbody></table>
      </section>

      <section class="item">
        <h3>Backup / restore</h3>
        <button id="exportBackup" ${canManageBackups(state.profile) ? '' : 'disabled'}>Export JSON</button>
        <input id="restoreInput" type="file" accept="application/json" ${canManageBackups(state.profile) ? '' : 'disabled'} />
        <pre id="restorePreview" class="tiny"></pre>
        <button id="restoreBtn" ${canManageBackups(state.profile) ? '' : 'disabled'}>Run restore</button>
      </section>

      <section class="item">
        <h3>Migration</h3>
        <button id="previewImport">Preview browser data</button>
        <button id="runImport">Import browser data</button>
        <pre id="importPreview" class="tiny"></pre>
      </section>

      <section class="item">
        <h3>AI settings scaffold</h3>
        <form id="aiSettingsForm" class="grid">
          ${['aiEnabled','aiAutoAttach','aiUseInternalKnowledge','aiUseWebSearch','aiAskFollowups'].map((k) => `<label><input type="checkbox" name="${k}" ${state.settings[k] ? 'checked' : ''} ${canChangeAISettings(state.profile) ? '' : 'disabled'} /> ${k}</label>`).join('')}
          <button ${canChangeAISettings(state.profile) ? '' : 'disabled'}>Save AI settings</button>
        </form>
      </section>
    </div>

    <section class="item">
      <h3>Audit logs</h3>
      <div class="row">
        <input id="auditUser" placeholder="Filter by user UID" />
        <input id="auditType" placeholder="Filter by entity type" />
        <select id="auditAction"><option value="">All actions</option><option>create</option><option>update</option><option>delete</option></select>
        <button id="runAuditFilter">Filter</button>
      </div>
      <div class="list">${state.auditLogs.slice(0, 150).map((l) => `<div class="item"><b>${l.action}</b> ${l.entityType}/${l.entityId} by ${l.userIdentity || l.userUid} <div class="tiny">${l.summary || ''}</div></div>`).join('')}</div>
    </section>`;

  el.querySelectorAll('[data-save-user]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.saveUser;
    const role = el.querySelector(`[data-role="${id}"]`).value;
    const enabled = el.querySelector(`[data-enabled="${id}"]`).checked;
    await actions.saveUserRole(id, role, enabled);
  }));

  el.querySelector('#previewImport')?.addEventListener('click', async () => {
    el.querySelector('#importPreview').textContent = JSON.stringify(await actions.previewImport(), null, 2);
  });
  el.querySelector('#runImport')?.addEventListener('click', () => actions.runImport());
  el.querySelector('#exportBackup')?.addEventListener('click', () => actions.exportBackup());

  const restoreInput = el.querySelector('#restoreInput');
  restoreInput?.addEventListener('change', async () => {
    const file = restoreInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    actions.loadRestorePayload(text);
  });
  el.querySelector('#restoreBtn')?.addEventListener('click', () => actions.runRestore());

  el.querySelector('#aiSettingsForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = Object.fromEntries(['aiEnabled','aiAutoAttach','aiUseInternalKnowledge','aiUseWebSearch','aiAskFollowups'].map((k) => [k, fd.get(k) === 'on']));
    actions.saveAISettings(payload);
  });

  el.querySelector('#runAuditFilter')?.addEventListener('click', () => actions.filterAudit({
    userUid: el.querySelector('#auditUser').value.trim(),
    entityType: el.querySelector('#auditType').value.trim(),
    action: el.querySelector('#auditAction').value
  }));
}
