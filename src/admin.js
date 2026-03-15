import { defaultAiSettings } from './data.js';
import { Roles, canChangeAISettings, canManageBackups, isAdmin } from './roles.js';

const aiBooleanFields = ['aiEnabled', 'aiAutoAttach', 'aiUseInternalKnowledge', 'aiUseWebSearch', 'aiAskFollowups', 'aiAllowManualRerun', 'aiSaveSuccessfulFixesToLibraryDefault', 'aiShortResponseMode', 'aiVerboseManagerMode', 'aiFeedbackCollectionEnabled', 'mobileConciseModeDefault'];
const aiNumericFields = ['aiMaxWebSources', 'aiConfidenceThreshold'];
const aiTextFields = ['aiModel', 'defaultTaskSeverity', 'taskIntakeRequiredFields'];
const aiFieldMeta = {
  aiEnabled: { label: 'Enable AI troubleshooting', help: 'Allow the workspace to use AI-assisted troubleshooting tools.' },
  aiAutoAttach: { label: 'Auto-attach AI output', help: 'Attach successful AI troubleshooting notes to task records automatically.' },
  aiUseInternalKnowledge: { label: 'Use internal knowledge base', help: 'Search saved fixes and company knowledge before external sources.' },
  aiUseWebSearch: { label: 'Allow web search', help: 'Permit AI lookups against external web/manual sources when needed.' },
  aiAskFollowups: { label: 'Ask follow-up questions', help: 'Prompt for missing details when the first pass is weak.' },
  aiAllowManualRerun: { label: 'Allow manual reruns', help: 'Let managers rerun AI troubleshooting from the UI.' },
  aiSaveSuccessfulFixesToLibraryDefault: { label: 'Save successful fixes by default', help: 'Default new closeouts to add confirmed fixes into the troubleshooting library.' },
  aiShortResponseMode: { label: 'Short response mode', help: 'Prefer concise troubleshooting summaries for day-to-day use.' },
  aiVerboseManagerMode: { label: 'Verbose manager mode', help: 'Show more detailed reasoning for manager/admin review.' },
  aiFeedbackCollectionEnabled: { label: 'Collect AI feedback', help: 'Store AI feedback for future tuning.' },
  mobileConciseModeDefault: { label: 'Use concise mobile mode', help: 'Keep mobile AI responses tighter by default.' },
  aiModel: { label: 'AI model', help: 'Default model used for troubleshooting requests.' },
  defaultTaskSeverity: { label: 'Default task severity', help: 'Used when a task is created without an explicit severity.' },
  taskIntakeRequiredFields: { label: 'Required intake fields', help: 'Comma-separated fields that must be present for task intake.' },
  aiMaxWebSources: { label: 'Max web sources', help: 'Maximum number of external sources the AI should consider.' },
  aiConfidenceThreshold: { label: 'Confidence threshold', help: 'Minimum confidence before AI suggestions are treated as strong.' }
};

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
  const invites = (state.invites || []).filter((i) => i.status === 'pending' && i.companyId === state.company?.id);
  const locations = state.companyLocations || [];
  const hasLocations = locations.length > 0;
  const settings = { ...defaultAiSettings, ...(state.settings || {}) };
  const renderFieldHelp = (key) => aiFieldMeta[key]?.help ? `<div class="tiny">${aiFieldMeta[key].help}</div>` : '';

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
      <h3>Current locations</h3>
      <div class="list">${locations.map((loc) => `<div class="item"><b>${loc.name}</b><div class="tiny">${loc.address || ''} ${loc.timeZone ? `• ${loc.timeZone}` : ''}</div></div>`).join('') || '<p class="tiny">No locations yet.</p>'}</div>
      ${hasLocations ? `
        <details class="mt">
          <summary>Add another location</summary>
          <form id="addLocationForm" class="grid grid-2 mt">
            <label>Location name<input name="name" placeholder="Example: Dallas service hub" required /></label>
            <label>Address<input name="address" placeholder="Street, city, state" /></label>
            <label>Timezone<input name="timeZone" placeholder="Example: America/Chicago" /></label>
            <label>Notes<input name="notes" placeholder="Optional notes for this location" /></label>
            <button class="primary" type="submit">Add location</button>
          </form>
        </details>
      ` : `
        <div class="mt">
          <h4>Add your first location</h4>
          <form id="addLocationForm" class="grid grid-2">
            <label>Location name<input name="name" placeholder="Example: Main office" required /></label>
            <label>Address<input name="address" placeholder="Street, city, state" /></label>
            <label>Timezone<input name="timeZone" placeholder="Example: America/Chicago" /></label>
            <label>Notes<input name="notes" placeholder="Optional notes for this location" /></label>
            <button class="primary" type="submit">Add location</button>
          </form>
        </div>
      `}
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
      <form id="workerForm" class="grid grid-2 mt">
        <label>Worker name<input name="displayName" placeholder="Example: Alex Smith" required /></label>
        <label>Worker email<input name="email" type="email" placeholder="Optional" /></label>
        <label>Role<select name="role">${Object.values(Roles).map((r) => `<option>${r}</option>`).join('')}</select></label>
        <button class="primary" type="submit">Add worker record</button>
      </form>

      <h4>Invites</h4>
      <form id="inviteForm" class="grid grid-2">
        <label>Invite email<input name="email" type="email" placeholder="name@company.com" required /></label>
        <label>Role<select name="role">${Object.values(Roles).map((r) => `<option>${r}</option>`).join('')}</select></label>
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
        ${aiBooleanFields.map((k) => `<label><input type="checkbox" name="${k}" ${settings[k] ? 'checked' : ''} ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /> ${aiFieldMeta[k]?.label || k}${renderFieldHelp(k)}</label>`).join('')}
        ${aiTextFields.map((k) => `<label>${aiFieldMeta[k]?.label || k}${renderFieldHelp(k)}<input name="${k}" value="${Array.isArray(settings[k]) ? settings[k].join(',') : (settings[k] || '')}" placeholder="${k === 'taskIntakeRequiredFields' ? 'assetId, description, reporter' : ''}" ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /></label>`).join('')}
        ${aiNumericFields.map((k) => `<label>${aiFieldMeta[k]?.label || k}${renderFieldHelp(k)}<input type="number" step="0.01" name="${k}" value="${settings[k] ?? ''}" ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /></label>`).join('')}
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
