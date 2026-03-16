import { defaultAiSettings } from './data.js';
import { canChangeAISettings, canManageBackups, isAdmin } from './roles.js';
import { buildLocationOptions } from './features/locationContext.js';
import { renderWorkspaceReadinessCard } from './features/workspaceReadiness.js';

const WORKER_ROLE_OPTIONS = ['staff', 'lead', 'assistant_manager', 'manager', 'admin'];
const ACCESS_ROLE_OPTIONS = ['owner', 'admin', 'manager', 'staff', 'viewer'];

function getReadablePersonName(person = {}) {
  return person.fullName || person.displayName || person.email || person.userId || person.id || 'Unknown person';
}

function renderCompanyAddress(company = {}) {
  const street = `${company.hqStreet || ''}`.trim();
  const city = `${company.hqCity || ''}`.trim();
  const state = `${company.hqState || ''}`.trim();
  const zip = `${company.hqZip || ''}`.trim();
  const locality = [city, state].filter(Boolean).join(', ');
  return [street, locality, zip].filter(Boolean).join(' ').trim() || company.address || '-';
}

function formatRoleLabel(value = '') {
  return `${value || 'staff'}`.replace(/_/g, ' ');
}

function renderStatusChip(label, tone = 'muted') {
  return `<span class="state-chip ${tone}">${label}</span>`;
}

const aiBooleanFields = ['aiEnabled', 'aiAutoAttach', 'aiUseInternalKnowledge', 'aiUseWebSearch', 'aiAskFollowups', 'aiAllowManualRerun', 'aiSaveSuccessfulFixesToLibraryDefault', 'aiShortResponseMode', 'aiVerboseManagerMode', 'aiFeedbackCollectionEnabled', 'mobileConciseModeDefault'];
const aiNumericFields = ['aiMaxWebSources', 'aiConfidenceThreshold'];

const AI_SETTINGS_SCHEMA = [
  { section: 'Enablement', fields: [{ key: 'aiEnabled', label: 'Enable Operations AI', help: 'When enabled, new saved tasks can trigger AI automatically.' }, { key: 'aiAllowManualRerun', label: 'Allow manual rerun', help: 'Lead-or-higher can rerun AI from the task panel.' }] },
  { section: 'Sources', fields: [{ key: 'aiUseInternalKnowledge', label: 'Use internal knowledge', help: 'Use your saved docs and troubleshooting library.' }, { key: 'aiUseWebSearch', label: 'Use web search', help: 'Allow web lookup for additional context.' }, { key: 'aiMaxWebSources', label: 'Max web sources', type: 'number', help: 'Caps the number of web sources per run.' }] },
  { section: 'Response style', fields: [{ key: 'aiModel', label: 'Model', help: 'Underlying model used by AI orchestrator.' }, { key: 'aiShortResponseMode', label: 'Short frontline responses', help: 'Favor concise guidance by default.' }, { key: 'aiVerboseManagerMode', label: 'Verbose manager responses', help: 'Allow deeper manager-oriented detail.' }] },
  { section: 'Follow-up behavior', fields: [{ key: 'aiAskFollowups', label: 'Ask follow-up questions', help: 'AI can request missing context before final guidance.' }, { key: 'taskIntakeRequiredFields', label: 'Required intake fields', help: 'Comma-separated fields used for validation.' }] },
  { section: 'Troubleshooting library', fields: [{ key: 'aiSaveSuccessfulFixesToLibraryDefault', label: 'Default save fixes to library', help: 'Default closeout behavior for successful fixes.' }, { key: 'aiFeedbackCollectionEnabled', label: 'Collect AI helpfulness feedback', help: 'Track whether AI guidance helped.' }] },
  { section: 'Mobile defaults', fields: [{ key: 'mobileConciseModeDefault', label: 'Mobile concise mode default', help: 'Prefer compact wording on mobile layouts.' }, { key: 'defaultTaskSeverity', label: 'Default task severity', help: 'Pre-selected task severity for intake.' }, { key: 'aiConfidenceThreshold', label: 'Confidence threshold', type: 'number', help: 'Minimum confidence before stronger suggestions.' }] }
];

const NOTIFICATION_PREF_OPTIONS = [
  'task_assigned', 'task_overdue', 'pm_due_soon', 'pm_overdue', 'invite_received', 'invite_accepted',
  'ai_troubleshooting_ready', 'docs_suggestions_ready', 'doc_review_ready', 'followup_required', 'task_ready_to_close',
  'task_recently_closed', 'blocked_work', 'unassigned_open_work'
];

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
  const headers = lines[0].split(',').map((value) => value.trim());
  return lines.slice(1).map((line, index) => {
    const values = line.split(',').map((value) => value.trim());
    const row = { __row: index + 2 };
    headers.forEach((header, valueIndex) => { row[header] = values[valueIndex] || ''; });
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
  const invites = (state.invites || []).filter((invite) => invite.status === 'pending' && invite.companyId === state.company?.id);
  const members = (state.companyMembers || []).map((membership) => {
    const profile = (state.users || []).find((user) => user.id === membership.userId) || {};
    return {
      ...membership,
      displayName: getReadablePersonName(profile),
      email: profile.email || profile.emailLower || '',
      enabled: profile.enabled !== false,
      isCurrentUser: membership.userId === state.user?.uid
    };
  });
  const locations = state.companyLocations || [];
  const locationOptions = buildLocationOptions(state).filter((option) => option.id);
  const settings = { ...defaultAiSettings, ...(state.settings || {}) };
  const selectedNotificationPrefs = new Set((state.settings?.notificationPrefs?.enabledTypes || []));
  const adminUi = state.adminUi || {};
  const workerEmailSet = new Set(workers.map((worker) => `${worker.email || ''}`.trim().toLowerCase()).filter(Boolean));
  const memberEmailSet = new Set(members.map((member) => `${member.email || ''}`.trim().toLowerCase()).filter(Boolean));
  const inviteEmailSet = new Set(invites.map((invite) => `${invite.email || ''}`.trim().toLowerCase()).filter(Boolean));
  const linkedCount = members.filter((member) => workerEmailSet.has(`${member.email || ''}`.trim().toLowerCase())).length;

  el.innerHTML = `
    <h2>Company Admin</h2>
    <p class="tiny">Organize company setup, people access, and worker directory records without mixing concerns.</p>
    ${adminUi.message ? `<div class="inline-state ${adminUi.tone === 'error' ? 'error' : (adminUi.tone === 'success' ? 'success' : 'info')}">${adminUi.message}</div>` : ''}
    ${renderWorkspaceReadinessCard(state, { compact: true })}
    ${renderSectionTabs(activeSection)}

    <section class="item ${activeSection === 'company' ? '' : 'hide'}" data-admin-section="company">
      <h3>Company</h3>
      <p class="tiny">Core workspace identity and setup state.</p>
      <div class="grid grid-2">
        <div><b>Name:</b> ${state.company?.name || '-'}</div>
        <div><b>Onboarding complete:</b> ${state.company?.onboardingCompleted ? 'Yes' : 'No'}</div>
        <div><b>Email:</b> ${state.company?.primaryEmail || '-'}</div>
        <div><b>Phone:</b> ${state.company?.primaryPhone || '-'}</div>
        <div><b>HQ address:</b> ${renderCompanyAddress(state.company)}</div>
        <div><b>Timezone:</b> ${state.company?.timeZone || '-'}</div>
      </div>
      <div class="tiny mt">Owner note: the company creator already has owner-level admin access.</div>
    </section>

    <section class="item ${activeSection === 'locations' ? '' : 'hide'}" data-admin-section="locations">
      <h3>Locations</h3>
      <p class="tiny">Where assets and work are scoped. Keep this list clean and easy to scan.</p>
      <div class="list">${locations.map((location) => `<div class="item"><div class="row space"><b>${location.name}</b>${renderStatusChip('active', 'good')}</div><div class="tiny">${location.address || 'No address'} ${location.timeZone ? `| ${location.timeZone}` : ''}</div><div class="tiny">${location.notes || 'Used for asset/task filters and assignments.'}</div></div>`).join('') || '<div class="inline-state info">No additional locations yet. Add one when teams or assets operate outside HQ.</div>'}</div>
      <details class="mt"><summary><b>Add location</b></summary>
        <form id="addLocationForm" class="grid grid-2 mt">
          <label>Location name<input name="name" required /></label>
          <label>Address<input name="address" /></label>
          <label>Timezone<input name="timeZone" placeholder="America/Chicago" /></label>
          <label>Notes<input name="notes" placeholder="What teams or assets belong here?" /></label>
          <button class="primary" type="submit">Save location</button>
        </form>
      </details>
    </section>

    <section class="item ${activeSection === 'members' ? '' : 'hide'}" data-admin-section="members">
      <h3>Members</h3>
      <p class="tiny">Signed-in users with workspace access. Use this to manage role/access and verify who can log in.</p>
      <div class="kpi-line"><span>Members: ${members.length}</span><span>Pending invites: ${invites.length}</span><span>Linked to worker records: ${linkedCount}</span></div>
      <div class="list mt">${members.map((member) => {
    const normalizedEmail = `${member.email || ''}`.trim().toLowerCase();
    const chips = [renderStatusChip(formatRoleLabel(member.role || 'staff'), member.role === 'owner' ? 'bad' : 'muted')];
    chips.push(renderStatusChip(member.enabled ? 'active' : 'inactive', member.enabled ? 'good' : 'warn'));
    chips.push(renderStatusChip(workerEmailSet.has(normalizedEmail) ? 'linked worker' : 'unlinked worker', workerEmailSet.has(normalizedEmail) ? 'good' : 'warn'));
    if (member.isCurrentUser) chips.push(renderStatusChip('you', 'info'));
    return `<div class="item"><div class="row space"><b>${member.displayName || member.userId}</b><div class="state-chip-row">${chips.join('')}</div></div><div class="tiny">${member.email || '-'} ${member.userId ? `| ${member.userId}` : ''}</div><details class="mt"><summary>Edit role/access</summary><form data-member-form="${member.id}" class="grid grid-2 mt"><label>Role<select name="role" ${member.role === 'owner' ? 'disabled' : ''}>${ACCESS_ROLE_OPTIONS.map((role) => `<option value="${role}" ${role === (member.role || 'staff') ? 'selected' : ''}>${formatRoleLabel(role)}</option>`).join('')}</select></label><label>Status<select name="status"><option value="active" ${member.status !== 'inactive' ? 'selected' : ''}>active</option><option value="inactive" ${member.status === 'inactive' ? 'selected' : ''}>inactive</option></select></label><div class="tiny" style="grid-column:1/-1;">Use inactive for temporary access removal. Owner role cannot be changed here.</div><button type="submit" ${member.role === 'owner' ? 'disabled' : ''}>Save member access</button></form></details></div>`;
  }).join('') || '<div class="inline-state info">No active members yet. Send an invite to grant workspace access.</div>'}</div>
    </section>

    <section class="item ${activeSection === 'workers' ? '' : 'hide'}" data-admin-section="workers">
      <h3>Workers</h3>
      <p class="tiny">Assignable people records for jobs, schedules, and operations. Workers can exist without login access.</p>
      <details><summary><b>Add worker</b></summary>
        <form id="workerForm" class="grid grid-2 mt">
          <label>Name<input name="displayName" required /></label>
          <label>Email<input name="email" type="email" placeholder="Optional login email" /></label>
          <label>Role<select name="role">${WORKER_ROLE_OPTIONS.map((role) => `<option value="${role}">${formatRoleLabel(role)}</option>`).join('')}</select></label>
          <label>Skills<input name="skills" placeholder="Electrical, Mechanical" /></label>
          <label>Default location
            <select name="defaultLocationId"><option value="">No default location</option>${locationOptions.map((option) => `<option value="${option.id}">${option.name}</option>`).join('')}</select>
          </label>
          <label>Location label<input name="locationName" list="workerLocationNames" placeholder="Visible location label" /></label>
          <label>Invite access<select name="sendInvite"><option value="no">Do not send invite</option><option value="yes">Create invite code now</option></select></label>
          <div class="tiny" style="grid-column:1/-1;">This creates a worker record. Invite only when this person should also become a Member.</div>
          <button class="primary">Save worker</button>
        </form>
      </details>
      <datalist id="workerLocationNames">${locationOptions.map((option) => `<option value="${option.name}"></option>`).join('')}</datalist>
      <div class="list mt">${workers.map((worker) => {
    const normalizedEmail = `${worker.email || ''}`.trim().toLowerCase();
    const isLinked = normalizedEmail && memberEmailSet.has(normalizedEmail);
    const chips = [
      renderStatusChip(formatRoleLabel(worker.role || 'staff'), 'muted'),
      renderStatusChip(worker.enabled === false ? 'inactive' : 'active', worker.enabled === false ? 'warn' : 'good'),
      renderStatusChip(isLinked ? 'linked member' : 'unlinked', isLinked ? 'good' : 'warn')
    ];
    if (normalizedEmail && inviteEmailSet.has(normalizedEmail)) chips.push(renderStatusChip('invited', 'info'));
    if (!normalizedEmail) chips.push(renderStatusChip('no login email', 'muted'));
    return `<div class="item"><div class="row space"><b>${worker.displayName || worker.id}</b><div class="state-chip-row">${chips.join('')}</div></div><div class="tiny">${worker.email || 'No login email'} | ${worker.locationName || 'No location set'}</div><details class="mt"><summary>Edit worker</summary><form data-worker-form="${worker.id}" class="grid grid-2 mt"><label>Name<input name="displayName" value="${worker.displayName || ''}" /></label><label>Email<input name="email" type="email" value="${worker.email || ''}" /></label><label>Role<select name="role">${WORKER_ROLE_OPTIONS.map((role) => `<option value="${role}" ${role === (worker.role || 'staff') ? 'selected' : ''}>${formatRoleLabel(role)}</option>`).join('')}</select></label><label>Location label<input name="locationName" value="${worker.locationName || ''}" /></label><button type="submit">Save worker updates</button></form></details></div>`;
  }).join('') || '<div class="inline-state info">No workers yet. Add staff records for assignment even if they do not need login access.</div>'}</div>
    </section>

    <section class="item ${activeSection === 'invites' ? '' : 'hide'}" data-admin-section="invites">
      <h3>Invites</h3>
      <p class="tiny">Pending access grants. Invites become Members only when accepted.</p>
      <details><summary><b>Invite member</b></summary>
        <form id="inviteForm" class="row mt">
          <input name="email" type="email" placeholder="person@company.com" required />
          <select name="role"><option value="viewer">viewer</option><option value="staff">staff</option><option value="manager">manager</option><option value="admin">admin</option></select>
          <button class="primary" type="submit">Create invite</button>
        </form>
      </details>
      <div class="list mt">${invites.map((invite) => {
    const normalizedEmail = `${invite.email || ''}`.trim().toLowerCase();
    const chips = [renderStatusChip('invited', 'info'), renderStatusChip(formatRoleLabel(invite.role || 'staff'), 'muted')];
    chips.push(renderStatusChip(workerEmailSet.has(normalizedEmail) ? 'worker exists' : 'no worker yet', workerEmailSet.has(normalizedEmail) ? 'good' : 'warn'));
    return `<div class="item"><div class="row space"><b>${invite.email}</b><div class="state-chip-row">${chips.join('')}</div></div><div class="tiny">Invite code: ${invite.inviteCode || 'n/a'}</div><button data-revoke-invite="${invite.id}" class="mt">Revoke invite</button></div>`;
  }).join('') || '<div class="inline-state info">No pending invites. Add an invite when someone needs workspace sign-in access.</div>'}</div>
    </section>

    <section class="item ${activeSection === 'imports' ? '' : 'hide'}" data-admin-section="imports">
      <h3>Workspace tools</h3>
      <div class="row"><button id="downloadAssetsTemplate" type="button">Download assets CSV template</button><button id="downloadEmployeesTemplate" type="button">Download workers CSV template</button></div>
      <div class="grid grid-2 mt"><label>Assets CSV<input id="assetCsvInput" type="file" accept=".csv" /></label><button id="applyAssetCsv" type="button">Import assets</button><label>Workers CSV<input id="employeeCsvInput" type="file" accept=".csv" /></label><button id="applyEmployeeCsv" type="button">Import workers</button></div>
      ${adminUi.importSummary ? `<div class="tiny mt">${adminUi.importSummary}</div>` : '<div class="tiny mt">Choose a CSV to preview rows before import.</div>'}
      <pre id="importPreview" class="tiny">${adminUi.importPreview || ''}</pre>
    </section>

    <section class="item ${activeSection === 'tools' ? '' : 'hide'}" data-admin-section="tools">
      <h3>AI settings</h3>
      <div class="tiny">Effective state: AI is <b>${settings.aiEnabled ? 'enabled' : 'disabled'}</b> for this company.</div>
      <form id="aiSettingsForm" class="grid">
        ${AI_SETTINGS_SCHEMA.map((group) => `<fieldset class="onboarding-location-fieldset"><legend><b>${group.section}</b></legend>${group.fields.map((field) => {
    const isNumber = field.type === 'number' || aiNumericFields.includes(field.key);
    const isBoolean = aiBooleanFields.includes(field.key);
    const value = Array.isArray(settings[field.key]) ? settings[field.key].join(',') : (settings[field.key] ?? '');
    return isBoolean
      ? `<label><input type="checkbox" name="${field.key}" ${settings[field.key] ? 'checked' : ''} ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /> ${field.label}<div class="tiny">${field.help}</div></label>`
      : `<label>${field.label}<input name="${field.key}" ${isNumber ? 'type="number" step="0.01"' : ''} value="${value}" ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /><div class="tiny">${field.help}</div></label>`;
  }).join('')}</fieldset>`).join('')}
        <button ${canChangeAISettings(state.permissions) ? '' : 'disabled'}>Save settings</button>
      </form>
      <details class="mt"><summary><b>Notification preferences (scaffold)</b></summary>
        <form id="notificationPrefsForm" class="grid mt">
          <div class="tiny">Enable the in-app event categories that should generate notifications for this company/user context.</div>
          <div class="grid grid-2">${NOTIFICATION_PREF_OPTIONS.map((key) => `<label><input type="checkbox" name="notificationType" value="${key}" ${selectedNotificationPrefs.size === 0 || selectedNotificationPrefs.has(key) ? 'checked' : ''} /> ${key.replace(/_/g, ' ')}</label>`).join('')}</div>
          <button type="submit">Save notification preferences</button>
        </form>
      </details>
    </section>

    <section class="item ${activeSection === 'danger' ? '' : 'hide'}" data-admin-section="danger">
      <h3 class="danger">Danger Zone</h3>
      <p class="tiny">Destructive workspace actions are isolated here. Type the company name to confirm.</p>
      <input id="dangerPhrase" placeholder="Type: ${state.company?.name || 'CONFIRM'}" />
      <div class="row mt"><button id="exportBackup" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export workspace data</button><button id="clearTasks" type="button">Clear tasks/operations</button><button id="clearAssets" type="button">Clear assets</button><button id="clearWorkers" type="button">Clear workers</button><button id="resetWorkspace" type="button">Reset workspace data</button></div>
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

  el.querySelector('#addLocationForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await actions.addLocation(Object.fromEntries(new FormData(event.currentTarget).entries()));
  });
  el.querySelector('#workerForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await actions.createWorker(Object.fromEntries(new FormData(event.currentTarget).entries()));
  });
  el.querySelector('#inviteForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await actions.createInvite(Object.fromEntries(new FormData(event.currentTarget).entries()));
  });
  el.querySelectorAll('[data-worker-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await actions.saveWorker(form.dataset.workerForm, Object.fromEntries(new FormData(event.currentTarget).entries()));
    });
  });
  el.querySelectorAll('[data-member-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await actions.saveMemberAccess(form.dataset.memberForm, Object.fromEntries(new FormData(event.currentTarget).entries()));
    });
  });

  el.querySelectorAll('[data-revoke-invite]').forEach((button) => button.addEventListener('click', () => actions.revokeInvite(button.dataset.revokeInvite)));
  el.querySelector('#downloadAssetsTemplate')?.addEventListener('click', () => actions.downloadAssetTemplate());
  el.querySelector('#downloadEmployeesTemplate')?.addEventListener('click', () => actions.downloadEmployeeTemplate());

  el.querySelector('#applyAssetCsv')?.addEventListener('click', async () => {
    const file = el.querySelector('#assetCsvInput')?.files?.[0];
    if (!file) {
      actions.setImportFeedback({ tone: 'error', summary: 'Select an assets CSV before importing.', preview: '' });
      return;
    }
    const rows = parseCsv(await file.text());
    actions.setImportFeedback({
      tone: rows.length ? 'info' : 'error',
      summary: rows.length ? `Previewing ${Math.min(rows.length, 10)} of ${rows.length} asset rows.` : 'Assets CSV did not contain any data rows.',
      preview: JSON.stringify(rows.slice(0, 10), null, 2)
    });
    await actions.importAssets(rows);
  });
  el.querySelector('#applyEmployeeCsv')?.addEventListener('click', async () => {
    const file = el.querySelector('#employeeCsvInput')?.files?.[0];
    if (!file) {
      actions.setImportFeedback({ tone: 'error', summary: 'Select a workers CSV before importing.', preview: '' });
      return;
    }
    const rows = parseCsv(await file.text());
    actions.setImportFeedback({
      tone: rows.length ? 'info' : 'error',
      summary: rows.length ? `Previewing ${Math.min(rows.length, 10)} of ${rows.length} worker rows.` : 'Workers CSV did not contain any data rows.',
      preview: JSON.stringify(rows.slice(0, 10), null, 2)
    });
    await actions.importEmployees(rows);
  });

  el.querySelector('#exportBackup')?.addEventListener('click', () => actions.exportBackup());
  el.querySelector('#clearTasks')?.addEventListener('click', () => confirmDanger() && actions.clearTasks());
  el.querySelector('#clearAssets')?.addEventListener('click', () => confirmDanger() && actions.clearAssets());
  el.querySelector('#clearWorkers')?.addEventListener('click', () => confirmDanger() && actions.clearWorkers());
  el.querySelector('#resetWorkspace')?.addEventListener('click', () => confirmDanger() && actions.resetWorkspace());


  el.querySelector('#notificationPrefsForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const enabledTypes = fd.getAll('notificationType').map((value) => `${value || ''}`.trim()).filter(Boolean);
    actions.saveNotificationPrefs(enabledTypes);
  });

  el.querySelector('#aiSettingsForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    actions.saveAISettings({
      ...Object.fromEntries(aiBooleanFields.map((key) => [key, fd.get(key) === 'on'])),
      aiModel: fd.get('aiModel') || 'gpt-4.1-mini',
      aiMaxWebSources: Number(fd.get('aiMaxWebSources') || 3),
      aiConfidenceThreshold: Number(fd.get('aiConfidenceThreshold') || 0.45),
      defaultTaskSeverity: fd.get('defaultTaskSeverity') || 'medium',
      taskIntakeRequiredFields: (fd.get('taskIntakeRequiredFields') || 'assetId,description,reporter').split(',').map((value) => value.trim()).filter(Boolean)
    });
  });
}
