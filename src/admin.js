import { defaultAiSettings } from './data.js';
import { canChangeAISettings, canManageBackups, isAdmin } from './roles.js';

const aiBooleanFields = ['aiEnabled', 'aiAutoAttach', 'aiUseInternalKnowledge', 'aiUseWebSearch', 'aiAskFollowups', 'aiAllowManualRerun', 'aiSaveSuccessfulFixesToLibraryDefault', 'aiShortResponseMode', 'aiVerboseManagerMode', 'aiFeedbackCollectionEnabled', 'mobileConciseModeDefault'];
const aiNumericFields = ['aiMaxWebSources', 'aiConfidenceThreshold'];
const aiTextFields = ['aiModel', 'defaultTaskSeverity', 'taskIntakeRequiredFields'];

const ADMIN_SECTIONS = [
  { id: 'company', label: 'Company' },
  { id: 'locations', label: 'Locations' },
  { id: 'members', label: 'Members' },
  { id: 'workers', label: 'Workers' },
  { id: 'invites', label: 'Invites' },
  { id: 'imports', label: 'Imports' },
  { id: 'tools', label: 'AI settings / Workspace tools' },
  { id: 'danger', label: 'Danger zone' }
];

function parseCsv(text = '') {
  const lines = `${text}`.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((v) => v.trim());
  return lines.slice(1).map((line, idx) => {
    const values = line.split(',').map((v) => v.trim());
    const row = { __row: idx + 2 };
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
}

function renderSectionTabs(activeSection) {
  return `<div class="tabs">${ADMIN_SECTIONS.map((section) => `<button type="button" class="tab ${section.id === activeSection ? 'active' : ''}" data-admin-tab="${section.id}">${section.label}</button>`).join('')}</div>`;
}

export function renderAdmin(el, state, actions) {
  if (!isAdmin(state.permissions)) {
    el.innerHTML = '<h2>Admin</h2><p class="tiny">Admin access required.</p>';
    return;
  }

  const activeSection = state.adminSection || 'company';
  const workers = state.workers || [];
  const invites = (state.invites || []).filter((i) => i.status === 'pending' && i.companyId === state.company?.id);
  const members = (state.users || []).filter((u) => !u.companyId || u.companyId === state.company?.id);
  const locations = state.companyLocations || [];
  const settings = { ...defaultAiSettings, ...(state.settings || {}) };

  el.innerHTML = `
    <h2>Company Admin</h2>
    <p class="tiny">Structured workspace controls for ${state.company?.name || 'current workspace'}.</p>
    ${renderSectionTabs(activeSection)}

    <section class="item ${activeSection === 'company' ? '' : 'hide'}" data-admin-section="company">
      <h3>Company profile</h3>
      <div class="grid grid-2">
        <div><b>Name:</b> ${state.company?.name || '—'}</div>
        <div><b>Onboarding complete:</b> ${state.company?.onboardingCompleted ? 'Yes' : 'No'}</div>
        <div><b>Email:</b> ${state.company?.primaryEmail || '—'}</div>
        <div><b>Phone:</b> ${state.company?.primaryPhone || '—'}</div>
        <div><b>Timezone:</b> ${state.company?.timeZone || '—'}</div>
      </div>
    </section>

    <section class="item ${activeSection === 'locations' ? '' : 'hide'}" data-admin-section="locations">
      <h3>Locations</h3>
      <div class="list">${locations.map((loc) => `<div class="item"><b>${loc.name}</b><div class="tiny">${loc.address || 'No address'} ${loc.timeZone ? `• ${loc.timeZone}` : ''}</div></div>`).join('') || '<p class="tiny">No locations yet. Add one now.</p>'}</div>
      <form id="addLocationForm" class="grid grid-2 mt">
        <label>Location name<input name="name" required /></label>
        <label>Address<input name="address" /></label>
        <label>Timezone<input name="timeZone" placeholder="America/Chicago" /></label>
        <label>Notes<input name="notes" /></label>
        <button class="primary" type="submit">Add location</button>
      </form>
    </section>

    <section class="item ${activeSection === 'members' ? '' : 'hide'}" data-admin-section="members">
      <h3>Members</h3>
      <p class="tiny">Members are signed-in users with workspace access.</p>
      ${members.length ? `<table class="table"><thead><tr><th>User</th><th>Email</th><th>Role</th></tr></thead><tbody>${members.map((u) => `<tr><td>${u.displayName || u.email || u.id}</td><td>${u.email || '—'}</td><td>${u.role || 'staff'}</td></tr>`).join('')}</tbody></table>` : '<p class="tiny">No active members found yet.</p>'}
    </section>

    <section class="item ${activeSection === 'workers' ? '' : 'hide'}" data-admin-section="workers">
      <h3>Workers</h3>
      <p class="tiny">Workers are personnel records and may not have login access.</p>
      <form id="workerForm" class="grid grid-2">
        <label>Name<input name="displayName" required /></label>
        <label>Email<input name="email" type="email" /></label>
        <label>Role<input name="role" placeholder="staff" /></label>
        <label>Skills<input name="skills" placeholder="Electrical, Mechanical" /></label>
        <button class="primary">Add worker</button>
      </form>
      <div class="list mt">${workers.map((w) => `<div class="item"><b>${w.displayName || w.id}</b><div class="tiny">${w.email || 'No login email'} • ${w.role || 'staff'}</div></div>`).join('') || '<p class="tiny">No workers yet.</p>'}</div>
    </section>

    <section class="item ${activeSection === 'invites' ? '' : 'hide'}" data-admin-section="invites">
      <h3>Invites</h3>
      <p class="tiny">Invites are pending access grants not yet accepted.</p>
      <form id="inviteForm" class="row">
        <input name="email" type="email" placeholder="person@company.com" required />
        <select name="role"><option value="staff">staff</option><option value="manager">manager</option><option value="admin">admin</option></select>
        <button class="primary" type="submit">Create invite</button>
      </form>
      <div class="list mt">${invites.map((i) => `<div class="item"><b>${i.email}</b><div class="tiny">Role: ${i.role || 'staff'} • Code: ${i.inviteCode || 'n/a'}</div><button data-revoke-invite="${i.id}">Revoke</button></div>`).join('') || '<p class="tiny">No pending invites.</p>'}</div>
    </section>

    <section class="item ${activeSection === 'imports' ? '' : 'hide'}" data-admin-section="imports">
      <h3>Imports</h3>
      <div class="row">
        <button id="downloadAssetsTemplate" type="button">Download assets CSV template</button>
        <button id="downloadEmployeesTemplate" type="button">Download workers CSV template</button>
      </div>
      <div class="grid grid-2 mt">
        <label>Assets CSV<input id="assetCsvInput" type="file" accept=".csv" /></label>
        <button id="applyAssetCsv" type="button">Import assets</button>
        <label>Workers CSV<input id="employeeCsvInput" type="file" accept=".csv" /></label>
        <button id="applyEmployeeCsv" type="button">Import workers</button>
      </div>
      <pre id="importPreview" class="tiny"></pre>
    </section>

    <section class="item ${activeSection === 'tools' ? '' : 'hide'}" data-admin-section="tools">
      <h3>AI settings / Workspace tools</h3>
      <form id="aiSettingsForm" class="grid">
        ${aiBooleanFields.map((k) => `<label><input type="checkbox" name="${k}" ${settings[k] ? 'checked' : ''} ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /> ${k}</label>`).join('')}
        ${aiTextFields.map((k) => `<label>${k}<input name="${k}" value="${Array.isArray(settings[k]) ? settings[k].join(',') : (settings[k] || '')}" ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /></label>`).join('')}
        ${aiNumericFields.map((k) => `<label>${k}<input type="number" step="0.01" name="${k}" value="${settings[k] ?? ''}" ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /></label>`).join('')}
        <button ${canChangeAISettings(state.permissions) ? '' : 'disabled'}>Save settings</button>
      </form>
    </section>

    <section class="item ${activeSection === 'danger' ? '' : 'hide'}" data-admin-section="danger">
      <h3 class="danger">Danger Zone</h3>
      <p class="tiny">Destructive workspace actions are isolated here. Type the company name to confirm.</p>
      <input id="dangerPhrase" placeholder="Type: ${state.company?.name || 'CONFIRM'}" />
      <div class="row mt">
        <button id="exportBackup" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export workspace data</button>
        <button id="clearTasks" type="button">Clear tasks/operations</button>
        <button id="clearAssets" type="button">Clear assets</button>
        <button id="clearWorkers" type="button">Clear workers</button>
        <button id="resetWorkspace" type="button">Reset workspace data</button>
      </div>
    </section>`;

  el.querySelectorAll('[data-admin-tab]').forEach((button) => {
    button.addEventListener('click', () => actions.setAdminSection(button.dataset.adminTab));
  });

  const requiredPhrase = state.company?.name || 'CONFIRM';
  const confirmDanger = () => {
    const phrase = `${el.querySelector('#dangerPhrase')?.value || ''}`.trim();
    if (phrase !== requiredPhrase) {
      alert(`Confirmation phrase mismatch. Type exactly: ${requiredPhrase}`);
      return false;
    }
    return true;
  };

  el.querySelector('#addLocationForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await actions.addLocation(Object.fromEntries(new FormData(e.currentTarget).entries()));
  });

  el.querySelector('#workerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await actions.createWorker(Object.fromEntries(new FormData(e.currentTarget).entries()));
  });

  el.querySelector('#inviteForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await actions.createInvite(Object.fromEntries(new FormData(e.currentTarget).entries()));
  });

  el.querySelectorAll('[data-revoke-invite]').forEach((b) => b.addEventListener('click', () => actions.revokeInvite(b.dataset.revokeInvite)));
  el.querySelector('#downloadAssetsTemplate')?.addEventListener('click', () => actions.downloadAssetTemplate());
  el.querySelector('#downloadEmployeesTemplate')?.addEventListener('click', () => actions.downloadEmployeeTemplate());

  el.querySelector('#applyAssetCsv')?.addEventListener('click', async () => {
    const file = el.querySelector('#assetCsvInput')?.files?.[0];
    if (!file) return;
    const rows = parseCsv(await file.text());
    el.querySelector('#importPreview').textContent = JSON.stringify(rows.slice(0, 10), null, 2);
    await actions.importAssets(rows);
  });

  el.querySelector('#applyEmployeeCsv')?.addEventListener('click', async () => {
    const file = el.querySelector('#employeeCsvInput')?.files?.[0];
    if (!file) return;
    const rows = parseCsv(await file.text());
    el.querySelector('#importPreview').textContent = JSON.stringify(rows.slice(0, 10), null, 2);
    await actions.importEmployees(rows);
  });

  el.querySelector('#exportBackup')?.addEventListener('click', () => actions.exportBackup());
  el.querySelector('#clearTasks')?.addEventListener('click', () => confirmDanger() && actions.clearTasks());
  el.querySelector('#clearAssets')?.addEventListener('click', () => confirmDanger() && actions.clearAssets());
  el.querySelector('#clearWorkers')?.addEventListener('click', () => confirmDanger() && actions.clearWorkers());
  el.querySelector('#resetWorkspace')?.addEventListener('click', () => confirmDanger() && actions.resetWorkspace());

  el.querySelector('#aiSettingsForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    actions.saveAISettings({
      ...Object.fromEntries(aiBooleanFields.map((k) => [k, fd.get(k) === 'on'])),
      aiModel: fd.get('aiModel') || 'gpt-4.1-mini',
      aiMaxWebSources: Number(fd.get('aiMaxWebSources') || 3),
      aiConfidenceThreshold: Number(fd.get('aiConfidenceThreshold') || 0.45),
      defaultTaskSeverity: fd.get('defaultTaskSeverity') || 'medium',
      taskIntakeRequiredFields: (fd.get('taskIntakeRequiredFields') || 'assetId,description,reporter').split(',').map((v) => v.trim()).filter(Boolean)
    });
  });
}
