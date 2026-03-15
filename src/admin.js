import { Roles, canChangeAISettings, canManageBackups, isAdmin } from './roles.js';

const aiBooleanFields = ['aiEnabled', 'aiAutoAttach', 'aiUseInternalKnowledge', 'aiUseWebSearch', 'aiAskFollowups', 'aiAllowManualRerun', 'aiSaveSuccessfulFixesToLibraryDefault', 'aiShortResponseMode', 'aiVerboseManagerMode', 'aiFeedbackCollectionEnabled', 'mobileConciseModeDefault'];
const aiNumericFields = ['aiMaxWebSources', 'aiConfidenceThreshold'];
const aiTextFields = ['aiModel', 'defaultTaskSeverity', 'taskIntakeRequiredFields'];

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

export function renderAdmin(el, state, actions) {
  if (!isAdmin(state.permissions)) {
    el.innerHTML = '<h2>Admin</h2><p class="tiny">Admin access required.</p>';
    return;
  }

  const workers = state.workers || [];
  const invites = (state.invites || []).filter((i) => i.status === 'pending');
  const locations = state.companyLocations || [];

  el.innerHTML = `
    <h2>Company Admin</h2>
    <p class="tiny">Manage your company profile, users, imports, and safe cleanup tools for ${state.company?.name || 'current workspace'}.</p>

    <section class="item">
      <h3>Company profile</h3>
      <div class="grid grid-2">
        <div><b>Name:</b> ${state.company?.name || '—'}</div>
        <div><b>Onboarding complete:</b> ${state.company?.onboardingCompleted ? 'Yes' : 'No'}</div>
        <div><b>Email:</b> ${state.company?.primaryEmail || '—'}</div>
        <div><b>Phone:</b> ${state.company?.primaryPhone || '—'}</div>
        <div><b>Timezone:</b> ${state.company?.timeZone || '—'}</div>
        <div><b>Locations:</b> ${locations.length}</div>
      </div>
    </section>

    <section class="item">
      <h3>Locations</h3>
      <div class="list">${locations.map((loc) => `<div class="item"><b>${loc.name}</b><div class="tiny">${loc.address || ''} ${loc.timeZone ? `• ${loc.timeZone}` : ''}</div></div>`).join('') || '<p class="tiny">No locations yet.</p>'}</div>
      <form id="addLocationForm" class="grid grid-2 mt">
        <input name="name" placeholder="Location name" required />
        <input name="address" placeholder="Address" />
        <input name="timeZone" placeholder="Timezone" />
        <input name="notes" placeholder="Notes" />
        <button class="primary" type="submit">Add location</button>
      </form>
    </section>

    <section class="item">
      <h3>Users & worker directory</h3>
      <table class="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Enabled</th><th>Available</th><th>Shift</th><th>Skills</th><th>Save</th></tr></thead><tbody>
      ${workers.map((u) => `<tr><td><input data-name="${u.id}" value="${u.displayName || ''}" placeholder="Full name" /></td><td><input data-email="${u.id}" value="${u.email || ''}" placeholder="email@example.com" /></td><td><select data-role="${u.id}">${Object.values(Roles).map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-enabled="${u.id}" ${u.enabled !== false ? 'checked' : ''} /></td>
      <td><input type="checkbox" data-available="${u.id}" ${u.available !== false ? 'checked' : ''} /></td>
      <td><input data-shift="${u.id}" value="${u.shiftStart || ''}" placeholder="09:00" /></td>
      <td><input data-skills="${u.id}" value="${(u.skills || u.specialties || []).join(', ')}" placeholder="pinball, redemption" /></td>
      <td><button data-save-worker="${u.id}">Save</button></td></tr>`).join('')}
      </tbody></table>
      <form id="workerForm" class="row mt">
        <input name="displayName" placeholder="Worker name" required />
        <input name="email" type="email" placeholder="worker email (optional)" />
        <select name="role">${Object.values(Roles).map((r) => `<option>${r}</option>`).join('')}</select>
        <button class="primary" type="submit">Add worker record</button>
      </form>

      <h4>Invites</h4>
      <form id="inviteForm" class="row">
        <input name="email" type="email" placeholder="Invite email" required />
        <select name="role">${Object.values(Roles).map((r) => `<option>${r}</option>`).join('')}</select>
        <button type="submit">Create invite</button>
      </form>
      <div class="list">${invites.map((i) => `<div class="item"><b>${i.email}</b> • ${i.role}<div class="tiny">Code: ${i.inviteCode}</div><button data-revoke-invite="${i.id}">Revoke</button></div>`).join('') || '<p class="tiny">No pending invites.</p>'}</div>
    </section>

    <section class="item">
      <h3>Imports</h3>
      <div class="row"><button id="downloadAssetsTemplate">Download Asset CSV Template</button><button id="downloadEmployeesTemplate">Download Employee CSV Template</button></div>
      <div class="grid grid-2 mt">
        <div>
          <h4>Import assets CSV</h4>
          <input id="assetCsvInput" type="file" accept=".csv,text/csv" />
          <button id="applyAssetCsv">Preview + apply assets</button>
        </div>
        <div>
          <h4>Import employees CSV</h4>
          <input id="employeeCsvInput" type="file" accept=".csv,text/csv" />
          <button id="applyEmployeeCsv">Preview + apply employees</button>
        </div>
      </div>
      <pre id="importPreview" class="tiny"></pre>
      <h4>Import history</h4>
      <div class="list">${(state.importHistory || []).slice(0, 20).map((h) => `<div class="item">${h.type} • ${h.createdBy || 'unknown'} <span class="tiny">(${h.rowCount || 0} rows)</span></div>`).join('') || '<p class="tiny">No imports yet.</p>'}</div>
    </section>

    <section class="item">
      <h3>Workspace tools</h3>
      <form id="aiSettingsForm" class="grid">
        ${aiBooleanFields.map((k) => `<label><input type="checkbox" name="${k}" ${state.settings[k] ? 'checked' : ''} ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /> ${k}</label>`).join('')}
        ${aiTextFields.map((k) => `<label>${k}<input name="${k}" value="${Array.isArray(state.settings[k]) ? state.settings[k].join(',') : (state.settings[k] || '')}" ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /></label>`).join('')}
        ${aiNumericFields.map((k) => `<label>${k}<input type="number" step="0.01" name="${k}" value="${state.settings[k] ?? ''}" ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /></label>`).join('')}
        <button ${canChangeAISettings(state.permissions) ? '' : 'disabled'}>Save settings</button>
      </form>
    </section>

    <section class="item">
      <h3 class="danger">Danger Zone</h3>
      <p class="tiny">These actions only affect the current company workspace. Reset clears company-scoped operational data and does not delete the company account itself. Type the confirmation phrase shown before running.</p>
      <input id="dangerPhrase" placeholder="Type: ${state.company?.name || 'CONFIRM'}" />
      <div class="row">
        <button id="exportBackup" ${canManageBackups(state.permissions) ? '' : 'disabled'}>Export workspace data</button>
        <button id="clearTasks">Clear tasks/operations</button>
        <button id="clearAssets">Clear assets</button>
        <button id="clearWorkers">Clear workers (except current owner)</button>
        <button id="resetWorkspace">Reset workspace data</button>
      </div>
    </section>`;

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
    const fd = new FormData(e.currentTarget);
    await actions.addLocation(Object.fromEntries(fd.entries()));
  });

  el.querySelector('#workerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await actions.createWorker(Object.fromEntries(fd.entries()));
  });

  el.querySelectorAll('[data-save-worker]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.saveWorker;
    await actions.saveWorker(id, {
      displayName: el.querySelector(`[data-name="${id}"]`)?.value?.trim(),
      email: el.querySelector(`[data-email="${id}"]`)?.value?.trim(),
      role: el.querySelector(`[data-role="${id}"]`)?.value,
      enabled: el.querySelector(`[data-enabled="${id}"]`)?.checked,
      available: el.querySelector(`[data-available="${id}"]`)?.checked,
      shiftStart: el.querySelector(`[data-shift="${id}"]`)?.value?.trim(),
      skills: `${el.querySelector(`[data-skills="${id}"]`)?.value || ''}`.split(',').map((v) => v.trim()).filter(Boolean)
    });
  }));

  el.querySelector('#inviteForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await actions.createInvite(Object.fromEntries(fd.entries()));
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
    const payload = {
      ...Object.fromEntries(aiBooleanFields.map((k) => [k, fd.get(k) === 'on'])),
      aiModel: fd.get('aiModel') || 'gpt-4.1-mini',
      aiMaxWebSources: Number(fd.get('aiMaxWebSources') || 3),
      aiConfidenceThreshold: Number(fd.get('aiConfidenceThreshold') || 0.45),
      defaultTaskSeverity: fd.get('defaultTaskSeverity') || 'medium',
      taskIntakeRequiredFields: (fd.get('taskIntakeRequiredFields') || 'assetId,description,reporter').split(',').map((v) => v.trim()).filter(Boolean)
    };
    actions.saveAISettings(payload);
  });
}
