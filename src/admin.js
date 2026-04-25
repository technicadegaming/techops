import { defaultAiSettings } from './data.js';
import { canChangeAISettings, canManageBackups, isAdmin } from './roles.js';
import { buildLocationOptions } from './features/locationContext.js';
import { renderWorkspaceReadinessCard } from './features/workspaceReadiness.js';
import { formatRelativeTime } from './features/notifications.js';
import { buildUsageSummary, getTrialDaysRemaining, isTrialExpired, normalizeBillingAddress } from './billing.js';
import { parseAssetCsv } from './features/assetIntake.js';
import { getAuthoritativeOnboardingState } from './features/onboardingStatus.js';

const WORKER_ROLE_OPTIONS = ['staff', 'lead', 'assistant_manager', 'manager', 'admin'];
const ACCESS_ROLE_OPTIONS = ['owner', 'admin', 'manager', 'staff', 'viewer'];
const BUSINESS_TYPE_OPTIONS = ['Service provider', 'Owner/operator', 'Franchise group', 'Manufacturer', 'Distributor', 'Facilities team', 'Multi-site enterprise', 'Other'];
const INDUSTRY_OPTIONS = ['Family entertainment', 'Arcade and attractions', 'Hospitality', 'Foodservice', 'Retail', 'Healthcare', 'Education', 'Facilities management', 'Manufacturing', 'Transportation', 'Other'];

const aiBooleanFields = ['aiEnabled', 'aiAutoAttach', 'aiUseInternalKnowledge', 'aiUseWebSearch', 'aiAskFollowups', 'aiAllowManualRerun', 'aiAllowStaffManualRerun', 'aiAllowStaffSaveFixesToLibrary', 'aiSaveSuccessfulFixesToLibraryDefault', 'aiShortResponseMode', 'aiVerboseManagerMode', 'aiFeedbackCollectionEnabled', 'mobileConciseModeDefault'];
const aiNumericFields = ['aiMaxWebSources', 'aiConfidenceThreshold'];

const AI_SETTINGS_SCHEMA = [
  { section: 'Enablement', fields: [{ key: 'aiEnabled', label: 'Enable Operations AI', help: 'Turns AI troubleshooting on for this company.' }, { key: 'aiAllowManualRerun', label: 'Allow manual rerun', help: 'Lead-or-higher can rerun AI from a task card.' }, { key: 'aiAllowStaffManualRerun', label: 'Allow staff to manually run/rerun AI', help: 'Operations tasks only. Does not grant admin, import, or manual-enrichment permissions.' }, { key: 'aiAllowStaffSaveFixesToLibrary', label: 'Allow staff to save fixes to library', help: 'Operations tasks only. Does not grant admin, import, or manual-enrichment permissions.' }] },
  { section: 'Troubleshooting behavior', fields: [{ key: 'aiAskFollowups', label: 'Ask follow-up questions', help: 'AI can pause to request missing context.' }, { key: 'aiSaveSuccessfulFixesToLibraryDefault', label: 'Default save successful fixes', help: 'When closing tasks, default to saving fixes in the troubleshooting library.' }, { key: 'aiFeedbackCollectionEnabled', label: 'Collect AI helpfulness feedback', help: 'Capture lightweight feedback from users.' }] },
  { section: 'Enrichment and source controls', fields: [{ key: 'aiUseInternalKnowledge', label: 'Use internal docs/library', help: 'Use company manuals and troubleshooting knowledge first.' }, { key: 'aiUseWebSearch', label: 'Allow web search', help: 'Enable external lookup for added context.' }, { key: 'aiMaxWebSources', label: 'Max web sources', type: 'number', help: 'Limit on external sources per run.' }, { key: 'aiConfidenceThreshold', label: 'Confidence threshold', type: 'number', help: 'Minimum confidence before stronger recommendations.' }] },
  { section: 'Response style and defaults', fields: [{ key: 'aiModel', label: 'Model', help: 'Model identifier used by the orchestrator.' }, { key: 'aiShortResponseMode', label: 'Short frontline responses', help: 'Keep frontline answers concise.' }, { key: 'aiVerboseManagerMode', label: 'Verbose manager responses', help: 'Allow longer and more detailed manager-facing answers.' }, { key: 'mobileConciseModeDefault', label: 'Mobile concise mode default', help: 'Compact wording by default on smaller screens.' }, { key: 'defaultTaskSeverity', label: 'Default task severity', help: 'Default severity pre-filled for new tasks.' }, { key: 'taskIntakeRequiredFields', label: 'Required intake fields', help: 'Comma-separated task fields required before AI runs.' }] }
];

const NOTIFICATION_PREF_CATEGORIES = [
  {
    id: 'operations',
    label: 'Operations and assignments',
    help: 'Task ownership, due-state changes, blockers, and closeout signals.',
    keys: ['task_assigned', 'task_overdue', 'blocked_work', 'unassigned_open_work', 'followup_required', 'task_ready_to_close', 'task_recently_closed']
  },
  {
    id: 'preventive',
    label: 'Preventive maintenance',
    help: 'Upcoming and overdue PM reminders.',
    keys: ['pm_due_soon', 'pm_overdue']
  },
  {
    id: 'people',
    label: 'Access and people',
    help: 'Invite lifecycle and acceptance events.',
    keys: ['invite_received', 'invite_accepted']
  },
  {
    id: 'ai',
    label: 'AI and documentation',
    help: 'AI guidance and document suggestion updates.',
    keys: ['ai_troubleshooting_ready', 'docs_suggestions_ready', 'doc_review_ready']
  }
];

const ADMIN_SECTIONS = [
  { id: 'company', label: 'Company settings' },
  { id: 'locations', label: 'Location settings' },
  { id: 'members', label: 'Members' },
  { id: 'billing', label: 'Billing & plan' },
  { id: 'workers', label: 'Workers' },
  { id: 'invites', label: 'Invites' },
  { id: 'audit', label: 'Audit log' },
  { id: 'imports', label: 'Imports' },
  { id: 'tools', label: 'AI & notifications' },
  { id: 'danger', label: 'Danger zone' }
];

function getReadablePersonName(person = {}) {
  return person.fullName || person.displayName || person.email || person.userId || person.id || 'Unknown person';
}

function getMemberDisplayLabel(member = {}) {
  const person = member.person || {};
  return person.fullName || person.displayName || member.displayName || member.fullName || member.email || member.userEmail || member.userIdentity || member.userId || member.id || 'Unknown member';
}

function renderCompanyAddress(company = {}) {
  const locality = [`${company.hqCity || ''}`.trim(), `${company.hqState || ''}`.trim()].filter(Boolean).join(', ');
  return [`${company.hqStreet || ''}`.trim(), locality, `${company.hqZip || ''}`.trim()].filter(Boolean).join(' ').trim() || company.address || '-';
}

function formatRoleLabel(value = '') { return `${value || 'staff'}`.replace(/_/g, ' '); }
function renderStatusChip(label, tone = 'muted') { return `<span class="state-chip ${tone}">${label}</span>`; }


function formatDateLabel(value) {
  if (!value) return 'Not set';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString();
}

function renderBillingStatusChip(company = {}) {
  const subscriptionStatus = `${company.subscriptionStatus || 'trialing'}`.trim();
  if (subscriptionStatus === 'active') return renderStatusChip('subscription active', 'good');
  if (subscriptionStatus === 'past_due') return renderStatusChip('payment past due', 'warn');
  if (subscriptionStatus === 'canceled') return renderStatusChip('subscription canceled', 'bad');
  return renderStatusChip('trialing', 'info');
}


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

function renderAuditLine(entry = {}) {
  const actor = entry.actorName || entry.userIdentity || 'Someone';
  const target = entry.targetLabel || entry.entityId || 'record';
  const action = `${entry.actionType || entry.action || 'updated'}`.replace(/_/g, ' ');
  return `${actor} ${action} ${target}`;
}

export function renderAdmin(el, state, actions) {
  if (!isAdmin(state.permissions)) {
    el.innerHTML = '<h2>Admin</h2><p class="tiny">Admin access required.</p>';
    return;
  }

  const activeSection = state.adminSection || 'company';
  const workers = state.workers || [];
  const invites = (state.invites || []).filter((invite) => invite.status === 'pending' && invite.companyId === state.company?.id);
  const members = (state.companyMembers || []).map((membership) => ({ ...membership, person: state.directoryUsers?.find((user) => user.id === membership.userId), isCurrentUser: membership.userId === state.user?.uid }));
  const locations = state.companyLocations || [];
  const locationOptions = buildLocationOptions(state).filter((option) => option.id);
  const settings = { ...defaultAiSettings, ...(state.settings || {}) };
  const selectedNotificationPrefs = new Set((state.settings?.notificationPrefs?.enabledTypes || []));
  const adminUi = state.adminUi || {};
  const workerEmailSet = new Set(workers.map((worker) => `${worker.email || ''}`.trim().toLowerCase()).filter(Boolean));
  const linkedCount = members.filter((member) => workerEmailSet.has(`${member.email || ''}`.trim().toLowerCase())).length;
  const auditCategory = adminUi.auditCategory || 'all';
  const categoryOptions = [
    { id: 'all', label: 'All activity' },
    { id: 'people_access', label: 'People / access' },
    { id: 'assets_docs', label: 'Assets / docs' },
    { id: 'operations_tasks', label: 'Operations / tasks' },
    { id: 'settings', label: 'Settings' }
  ];
  const auditEntries = (state.auditLogs || []).filter((entry) => auditCategory === 'all' || entry.category === auditCategory).slice(0, 80);
  const onboarding = state.onboarding || getAuthoritativeOnboardingState(state);
  const importProgress = adminUi.importProgress || null;
  const importConfig = adminUi.importConfig || {};
  const bootstrapModeActive = importProgress?.isRunning
    ? importProgress?.bootstrapMode === true
    : importConfig.bootstrapAttachManualsFromCsvHints === true;
  const progressPercent = importProgress?.totalRows ? Math.round((Math.min(importProgress.completedRows || 0, importProgress.totalRows) / importProgress.totalRows) * 100) : 0;
  const importProgressMarkup = importProgress?.totalRows
    ? `<div class="item mt"><div class="row space tiny"><b>Import progress</b><span>${progressPercent}%</span></div><progress max="${importProgress.totalRows}" value="${Math.min(importProgress.completedRows || 0, importProgress.totalRows)}" style="width:100%;"></progress><div class="tiny mt">${importProgress.bootstrapMode ? 'Mode: direct CSV bootstrap' : 'Mode: standard enrichment queue'} · Total rows ${importProgress.totalRows} · Imported assets ${importProgress.importedAssets || 0} · Direct manuals attached ${importProgress.directManualsAttached || 0} · Direct attach failed ${importProgress.directManualAttachFailed || 0} · No direct manual URL ${importProgress.noDirectManualUrl || 0} · Completed rows ${importProgress.completedRows || 0}</div></div>`
    : '';

  const locationManagerChoices = members.map((member) => `<option value="${getReadablePersonName(member.person || member)}">${getReadablePersonName(member.person || member)}</option>`).join('');

  el.innerHTML = `
    <h2>Company Admin Settings</h2>
    <p class="tiny">Manage company profile, locations, people access, AI behavior, and notification policies in one place.</p>
    ${adminUi.message ? `<div class="inline-state ${adminUi.tone === 'error' ? 'error' : (adminUi.tone === 'success' ? 'success' : 'info')}">${adminUi.message}</div>` : ''}
    ${renderWorkspaceReadinessCard(state, { compact: true })}
    ${renderSectionTabs(activeSection)}

    <section class="item ${activeSection === 'company' ? '' : 'hide'}" data-admin-section="company">
      <h3>Company settings</h3>
      <p class="tiny">Workspace identity, contact details, and business profile.</p>
      <div class="kpi-line"><span>Onboarding: ${onboarding.badgeLabel}</span><span>Locations: ${locations.length || 1}</span><span>Members: ${members.length}</span></div>
      <form id="companySettingsForm" class="grid settings-stack mt">
        <fieldset class="onboarding-location-fieldset"><legend><b>Identity</b></legend>
          <div class="grid grid-2">
            <label>Company name<input name="name" value="${state.company?.name || ''}" required /></label>
            <label>Logo URL (optional)<input name="logoUrl" value="${state.company?.logoUrl || ''}" placeholder="https://..." /></label>
            <label>Business type
              <select name="businessType">${BUSINESS_TYPE_OPTIONS.map((option) => `<option value="${option}" ${option === (state.company?.businessType || '') ? 'selected' : ''}>${option}</option>`).join('')}</select>
            </label>
            <label>Industry
              <select name="industry">${INDUSTRY_OPTIONS.map((option) => `<option value="${option}" ${option === (state.company?.industry || '') ? 'selected' : ''}>${option}</option>`).join('')}</select>
            </label>
          </div>
        </fieldset>
        <fieldset class="onboarding-location-fieldset"><legend><b>Contact and timezone</b></legend>
          <div class="grid grid-2">
            <label>Contact email<input name="primaryEmail" type="email" value="${state.company?.primaryEmail || ''}" /></label>
            <label>Contact phone<input name="primaryPhone" value="${state.company?.primaryPhone || ''}" /></label>
            <label>Company timezone<input name="timeZone" value="${state.company?.timeZone || 'UTC'}" placeholder="America/Chicago" /></label>
          </div>
        </fieldset>
        <fieldset class="onboarding-location-fieldset"><legend><b>HQ address</b></legend>
          <div class="grid grid-2">
            <label>Street<input name="hqStreet" value="${state.company?.hqStreet || ''}" /></label>
            <label>City<input name="hqCity" value="${state.company?.hqCity || ''}" /></label>
            <label>State/Province<input name="hqState" value="${state.company?.hqState || ''}" /></label>
            <label>Postal code<input name="hqZip" value="${state.company?.hqZip || ''}" /></label>
          </div>
          <div class="tiny mt">Current formatted HQ address: ${renderCompanyAddress(state.company)}</div>
        </fieldset>
        <div class="row"><button class="primary" type="submit">Save company settings</button></div>
      </form>
    </section>



    <section class="item ${activeSection === 'billing' ? '' : 'hide'}" data-admin-section="billing">
      <h3>Billing and plan</h3>
      <p class="tiny">Subscription and billing contacts are kept separate from HQ/location operations data.</p>
      ${(() => {
        const billingAddress = normalizeBillingAddress(state.company?.billingAddress || {});
        const usageSummary = buildUsageSummary({
          members,
          workers,
          locations,
          assets: state.assets || [],
          seatLimit: state.company?.seatLimit
        });
        const trialDaysRemaining = getTrialDaysRemaining(state.company?.trialEndsAt);
        const trialExpired = isTrialExpired(state.company?.trialEndsAt) || `${state.company?.trialStatus || ''}`.trim() === 'expired';
        const seatLimit = Number.isFinite(Number(state.company?.seatLimit)) && Number(state.company?.seatLimit) > 0 ? Number(state.company.seatLimit) : null;
        const trialWarning = trialExpired
          ? '<div class="inline-state warn mt">Trial has ended. Access remains available in this soft-gating phase; please choose a paid plan soon.</div>'
          : (trialDaysRemaining !== null && trialDaysRemaining <= 7
            ? `<div class="inline-state warn mt">Trial ends in <b>${Math.max(trialDaysRemaining, 0)} day${Math.max(trialDaysRemaining, 0) === 1 ? '' : 's'}</b>. Billing checkout is coming soon.</div>`
            : '<div class="inline-state info mt">Trial mode is active while billing checkout is being finalized. You can still set plan, contacts, and renewal readiness now.</div>');
        return `<div class="grid grid-2 settings-stack">
          <div class="item">
            <h4 style="margin:0 0 8px;">Subscription summary</h4>
            <div class="state-chip-row">${renderStatusChip(`plan: ${state.company?.planKey || 'starter_trial'}`, 'muted')}${renderBillingStatusChip(state.company || {})}${renderStatusChip(`trial: ${state.company?.trialStatus || 'active'}`, trialExpired ? 'bad' : 'info')}</div>
            <div class="tiny mt">Trial ends: <b>${formatDateLabel(state.company?.trialEndsAt)}</b></div>
            <div class="tiny">Seat usage: <b>${usageSummary.seatsUsed}</b>${seatLimit ? ` / <b>${seatLimit}</b>` : ' (no limit set yet)'}</div>
            <div class="tiny">Usage snapshot: members ${usageSummary.members}, workers ${usageSummary.workers}, locations ${usageSummary.locations}, assets ${usageSummary.assets}.</div>
            ${trialWarning}
            <div class="tiny mt">Checkout/customer portal rollout status:</div>
            <div class="row mt"><button type="button" disabled>Start checkout (staged rollout)</button><button type="button" disabled>Open billing portal (staged rollout)</button></div>
          </div>
          <div class="item">
            <h4 style="margin:0 0 8px;">Billing contact details</h4>
            <form id="billingSettingsForm" class="grid mt">
              <label>Plan key
                <select name="planKey">
                  <option value="starter_trial" ${(state.company?.planKey || 'starter_trial') === 'starter_trial' ? 'selected' : ''}>Starter trial</option>
                  <option value="starter" ${state.company?.planKey === 'starter' ? 'selected' : ''}>Starter</option>
                  <option value="growth" ${state.company?.planKey === 'growth' ? 'selected' : ''}>Growth</option>
                  <option value="enterprise" ${state.company?.planKey === 'enterprise' ? 'selected' : ''}>Enterprise</option>
                </select>
              </label>
              <div class="grid grid-2">
                <label>Subscription status<select name="subscriptionStatus"><option value="trialing" ${(state.company?.subscriptionStatus || 'trialing') === 'trialing' ? 'selected' : ''}>trialing</option><option value="active" ${state.company?.subscriptionStatus === 'active' ? 'selected' : ''}>active</option><option value="past_due" ${state.company?.subscriptionStatus === 'past_due' ? 'selected' : ''}>past_due</option><option value="canceled" ${state.company?.subscriptionStatus === 'canceled' ? 'selected' : ''}>canceled</option></select></label>
                <label>Trial status<select name="trialStatus"><option value="active" ${(state.company?.trialStatus || 'active') === 'active' ? 'selected' : ''}>active</option><option value="expired" ${state.company?.trialStatus === 'expired' ? 'selected' : ''}>expired</option><option value="converted" ${state.company?.trialStatus === 'converted' ? 'selected' : ''}>converted</option></select></label>
                <label>Trial end date<input type="date" name="trialEndsAt" value="${(state.company?.trialEndsAt || '').slice(0, 10)}" /></label>
                <label>Default trial length (days)<input type="number" min="1" max="120" name="trialLengthDays" value="${Number(state.company?.trialLengthDays || 0) || ''}" placeholder="Config default" /></label>
                <label>Seat limit<input type="number" min="1" name="seatLimit" value="${seatLimit || ''}" placeholder="Optional" /></label>
              </div>
              <label>Billing email<input name="billingEmail" type="email" value="${state.company?.billingEmail || state.company?.primaryEmail || ''}" /></label>
              <label>Billing contact name<input name="billingContactName" value="${state.company?.billingContactName || ''}" /></label>
              <fieldset class="onboarding-location-fieldset"><legend><b>Billing address (separate from HQ)</b></legend>
                <div class="grid grid-2">
                  <label>Address line 1<input name="billingAddressLine1" value="${billingAddress.line1}" /></label>
                  <label>Address line 2<input name="billingAddressLine2" value="${billingAddress.line2}" /></label>
                  <label>City<input name="billingAddressCity" value="${billingAddress.city}" /></label>
                  <label>State/Province<input name="billingAddressState" value="${billingAddress.state}" /></label>
                  <label>Postal code<input name="billingAddressPostalCode" value="${billingAddress.postalCode}" /></label>
                  <label>Country<input name="billingAddressCountry" value="${billingAddress.country}" /></label>
                </div>
              </fieldset>
              <button type="submit">Save billing and plan settings</button>
            </form>
          </div>
        </div>`;
      })()}
    </section>

    <section class="item ${activeSection === 'locations' ? '' : 'hide'}" data-admin-section="locations">
      <h3>Location settings</h3>
      <p class="tiny">View location profile cards at a glance, then expand a location to edit details.</p>
      <div class="list">${locations.map((location) => `
        <div class="item">
          <div class="row space"><b>${location.name}</b><div class="state-chip-row">${renderStatusChip(location.status || 'active', (location.status || 'active') === 'active' ? 'good' : 'warn')}${location.managerName ? renderStatusChip(`manager: ${location.managerName}`, 'info') : ''}</div></div>
          <div class="tiny">${location.address || 'No address provided'} ${location.timeZone ? `| ${location.timeZone}` : ''}</div>
          <div class="tiny">${location.notes || 'No operating notes yet.'}</div>
          <details class="mt"><summary><b>Edit location</b></summary>
            <form data-location-form="${location.id}" class="grid grid-2 mt">
              <label>Location name<input name="name" value="${location.name || ''}" required /></label>
              <label>Timezone<input name="timeZone" value="${location.timeZone || state.company?.timeZone || 'UTC'}" /></label>
              <label>Address<input name="address" value="${location.address || ''}" /></label>
              <label>Manager<input name="managerName" value="${location.managerName || ''}" list="locationManagerList" placeholder="Assign manager name" /></label>
              <label>Status<select name="status"><option value="active" ${(location.status || 'active') === 'active' ? 'selected' : ''}>active</option><option value="limited" ${(location.status || 'active') === 'limited' ? 'selected' : ''}>limited</option><option value="inactive" ${(location.status || 'active') === 'inactive' ? 'selected' : ''}>inactive</option></select></label>
              <label style="grid-column:1/-1;">Operating notes<textarea name="notes">${location.notes || ''}</textarea></label>
              <button type="submit">Save location settings</button>
            </form>
          </details>
        </div>`).join('') || '<div class="inline-state info">No additional locations yet. Add one when teams/assets operate outside HQ.</div>'}</div>
      <datalist id="locationManagerList">${locationManagerChoices}</datalist>
      <details class="mt"><summary><b>Add location</b></summary>
        <form id="addLocationForm" class="grid grid-2 mt">
          <label>Location name<input name="name" required /></label><label>Address<input name="address" /></label>
          <label>Timezone<input name="timeZone" placeholder="America/Chicago" /></label><label>Manager<input name="managerName" list="locationManagerList" /></label>
          <label style="grid-column:1/-1;">Notes<input name="notes" placeholder="Teams, operating hours, routing notes..." /></label>
          <button class="primary" type="submit">Save location</button>
        </form>
      </details>
    </section>

    <section class="item ${activeSection === 'members' ? '' : 'hide'}" data-admin-section="members"><h3>Members</h3><p class="tiny">Signed-in users with workspace access.</p><div class="kpi-line"><span>Members: ${members.length}</span><span>Pending invites: ${invites.length}</span><span>Linked to worker records: ${linkedCount}</span></div><div class="list mt">${members.map((member) => {
    const normalizedEmail = `${member.email || ''}`.trim().toLowerCase();
    const chips = [renderStatusChip(formatRoleLabel(member.role || 'staff'), member.role === 'owner' ? 'bad' : 'muted')];
    chips.push(renderStatusChip(member.enabled ? 'active' : 'inactive', member.enabled ? 'good' : 'warn'));
    chips.push(renderStatusChip(workerEmailSet.has(normalizedEmail) ? 'linked worker' : 'unlinked worker', workerEmailSet.has(normalizedEmail) ? 'good' : 'warn'));
    if (member.isCurrentUser) chips.push(renderStatusChip('you', 'info'));
    return `<div class="item"><div class="row space"><b>${getMemberDisplayLabel(member)}</b><div class="state-chip-row">${chips.join('')}</div></div><div class="tiny">${member.email || member.person?.email || member.userEmail || '-'}</div><details class="mt"><summary>Edit role/access</summary><form data-member-form="${member.id}" class="grid grid-2 mt"><label>Role<select name="role" ${member.role === 'owner' ? 'disabled' : ''}>${ACCESS_ROLE_OPTIONS.map((role) => `<option value="${role}" ${role === (member.role || 'staff') ? 'selected' : ''}>${formatRoleLabel(role)}</option>`).join('')}</select></label><label>Status<select name="status"><option value="active" ${member.status !== 'inactive' ? 'selected' : ''}>active</option><option value="inactive" ${member.status === 'inactive' ? 'selected' : ''}>inactive</option></select></label><div class="tiny" style="grid-column:1/-1;">Use inactive for temporary access removal.</div><button type="submit" ${member.role === 'owner' ? 'disabled' : ''}>Save member access</button></form></details></div>`;
  }).join('') || '<div class="inline-state info">No member records yet.</div>'}</div></section>

    <section class="item ${activeSection === 'workers' ? '' : 'hide'}" data-admin-section="workers"><h3>Workers</h3><p class="tiny">Directory records for assignments.</p><details><summary><b>Add worker record</b></summary><form id="workerForm" class="grid grid-2 mt"><label>Display name<input name="displayName" required /></label><label>Email (optional)<input name="email" type="email" /></label><label>Role<select name="role">${WORKER_ROLE_OPTIONS.map((role) => `<option value="${role}">${formatRoleLabel(role)}</option>`).join('')}</select></label><label>Default location<select name="defaultLocationId"><option value="">No default</option>${locationOptions.map((option) => `<option value="${option.id}">${option.label}</option>`).join('')}</select></label><label>Location label<input name="locationName" /></label><label>Skills (comma separated)<input name="skills" /></label><label>Send invite?<select name="sendInvite"><option value="no">No</option><option value="yes">Yes</option></select></label><button class="primary" type="submit">Create worker</button></form></details><div class="list mt">${workers.map((worker) => `<div class="item"><div class="row space"><b>${worker.displayName || worker.id}</b><div class="state-chip-row">${renderStatusChip(formatRoleLabel(worker.role || 'staff'))}${renderStatusChip(worker.enabled ? 'enabled' : 'disabled', worker.enabled ? 'good' : 'warn')}</div></div><div class="tiny">${worker.email || 'No email'} ${worker.locationName ? `| ${worker.locationName}` : ''}</div><details class="mt"><summary>Edit worker</summary><form data-worker-form="${worker.id}" class="grid grid-2 mt"><label>Display name<input name="displayName" value="${worker.displayName || ''}" /></label><label>Email<input name="email" type="email" value="${worker.email || ''}" /></label><label>Role<select name="role">${WORKER_ROLE_OPTIONS.map((role) => `<option value="${role}" ${role === (worker.role || 'staff') ? 'selected' : ''}>${formatRoleLabel(role)}</option>`).join('')}</select></label><label>Location label<input name="locationName" value="${worker.locationName || ''}" /></label><button type="submit">Save worker updates</button></form></details></div>`).join('') || '<div class="inline-state info">No workers yet.</div>'}</div></section>

    <section class="item ${activeSection === 'invites' ? '' : 'hide'}" data-admin-section="invites"><h3>Invites</h3><p class="tiny">Pending access grants.</p><details><summary><b>Invite member</b></summary><form id="inviteForm" class="row mt"><input name="email" type="email" placeholder="person@company.com" required /><select name="role"><option value="viewer">viewer</option><option value="staff">staff</option><option value="manager">manager</option><option value="admin">admin</option></select><button class="primary" type="submit">Create invite</button></form></details><div class="list mt">${invites.map((invite) => `<div class="item"><div class="row space"><b>${invite.email}</b><div class="state-chip-row">${renderStatusChip('invited', 'info')}${renderStatusChip(formatRoleLabel(invite.role || 'staff'), 'muted')}</div></div><div class="tiny">Invite code: ${invite.inviteCode || 'n/a'}</div><button data-revoke-invite="${invite.id}" class="mt">Revoke invite</button></div>`).join('') || '<div class="inline-state info">No pending invites.</div>'}</div></section>

    <section class="item ${activeSection === 'audit' ? '' : 'hide'}" data-admin-section="audit"><h3>Audit log</h3><p class="tiny">Company activity history.</p><div class="row mt">${categoryOptions.map((option) => `<button type="button" data-audit-filter="${option.id}" class="filter-chip ${auditCategory === option.id ? 'active' : ''}">${option.label}</button>`).join('')}</div><div class="list mt">${auditEntries.map((entry) => `<div class="item tiny"><div class="row space"><b>${renderAuditLine(entry)}</b>${renderStatusChip(formatRelativeTime(entry.timestamp), 'muted')}</div><div>${entry.summary || ''}</div></div>`).join('') || '<div class="inline-state info">No audit entries in this view yet.</div>'}</div></section>

    <section class="item ${activeSection === 'imports' ? '' : 'hide'}" data-admin-section="imports"><h3>Workspace tools</h3><p class="tiny">Import templates, operational exports, and backup bundle tools for this company workspace.</p><div class="item" style="margin-top:8px;"><b>Import templates</b><div class="row mt"><button id="downloadAssetsTemplate" type="button">Download assets CSV template</button><button id="downloadEmployeesTemplate" type="button">Download workers CSV template</button></div></div><div class="grid grid-2 mt"><label>Assets CSV<input id="assetCsvInput" type="file" accept=".csv" /></label><button id="applyAssetCsv" type="button">Import assets</button><label>Workers CSV<input id="employeeCsvInput" type="file" accept=".csv" /></label><button id="applyEmployeeCsv" type="button">Import workers</button></div><label class="tiny mt" style="display:block;"><input id="bootstrapAttachManualsFromCsvHints" type="checkbox" ${bootstrapModeActive ? 'checked' : ''} ${importProgress?.isRunning ? 'disabled' : ''} /> Directly attach CSV manuals (one-time bootstrap mode, admin-only)${importProgress?.isRunning ? ' — mode locked while import is running' : ''}</label>${adminUi.importSummary ? `<div class="tiny mt">${adminUi.importSummary}</div>` : '<div class="tiny mt">Choose a CSV to preview rows before import.</div>'}${importProgressMarkup}<pre id="importPreview" class="tiny">${adminUi.importPreview || ''}</pre><div class="item mt"><b>CSV exports (company-scoped)</b><div class="tiny">Readable exports for operations and admin records. These files exclude invite tokens and other secrets.</div><div class="grid grid-2 mt"><button id="exportAssetsCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export assets CSV</button><button id="exportTasksCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export tasks CSV</button><button id="exportAuditCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export audit log CSV</button><button id="exportLocationsCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export locations CSV</button><button id="exportWorkersCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export workers CSV</button><button id="exportMembersCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export members CSV</button><button id="exportInvitesCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export invites CSV</button></div></div><div class="item mt"><b>Backup bundle</b><div class="tiny">Download one JSON bundle containing core company records for portability and backup confidence.</div><div class="row mt"><button id="exportCompanyBundle" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export company backup (JSON)</button></div></div></section>
    <section class="item ${activeSection === 'tools' ? '' : 'hide'}" data-admin-section="tools">
      <h3>AI and notification settings</h3>
      <div class="grid grid-2 settings-stack">
        <div class="item">
          <h4 style="margin:0 0 8px;">AI settings</h4>
          <div class="tiny">Effective state: AI is <b>${settings.aiEnabled ? 'enabled' : 'disabled'}</b> for this company.</div>
          <div class="tiny">Troubleshooting follow-ups are <b>${settings.aiAskFollowups ? 'on' : 'off'}</b>. Web lookup is <b>${settings.aiUseWebSearch ? 'on' : 'off'}</b> with max <b>${settings.aiMaxWebSources}</b> sources.</div>
          <form id="aiSettingsForm" class="grid mt">
            ${AI_SETTINGS_SCHEMA.map((group) => `<fieldset class="onboarding-location-fieldset"><legend><b>${group.section}</b></legend>${group.fields.map((field) => {
    const isNumber = field.type === 'number' || aiNumericFields.includes(field.key);
    const isBoolean = aiBooleanFields.includes(field.key);
    const value = Array.isArray(settings[field.key]) ? settings[field.key].join(',') : (settings[field.key] ?? '');
    return isBoolean
      ? `<label><input type="checkbox" name="${field.key}" ${settings[field.key] ? 'checked' : ''} ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /> ${field.label}<div class="tiny">${field.help}</div></label>`
      : `<label>${field.label}<input name="${field.key}" ${isNumber ? 'type="number" step="0.01"' : ''} value="${value}" ${canChangeAISettings(state.permissions) ? '' : 'disabled'} /><div class="tiny">${field.help}</div></label>`;
  }).join('')}</fieldset>`).join('')}
            <button ${canChangeAISettings(state.permissions) ? '' : 'disabled'}>Save AI settings</button>
          </form>
        </div>

        <div class="item">
          <h4 style="margin:0 0 8px;">Notification preferences</h4>
          <div class="tiny">Choose understandable categories instead of raw internal event names. This is a lightweight first-pass preference model.</div>
          <form id="notificationPrefsForm" class="grid mt">
            ${NOTIFICATION_PREF_CATEGORIES.map((group) => `<fieldset class="onboarding-location-fieldset"><legend><b>${group.label}</b></legend><div class="tiny">${group.help}</div><div class="grid mt">${group.keys.map((key) => `<label><input type="checkbox" name="notificationType" value="${key}" ${selectedNotificationPrefs.size === 0 || selectedNotificationPrefs.has(key) ? 'checked' : ''} /> ${key.replace(/_/g, ' ')}</label>`).join('')}</div></fieldset>`).join('')}
            <button type="submit">Save notification preferences</button>
          </form>
        </div>
      </div>
    </section>

    <section class="item ${activeSection === 'danger' ? '' : 'hide'}" data-admin-section="danger"><h3 class="danger">Danger Zone</h3><p class="tiny">Destructive workspace actions are isolated here. Type the company name to confirm.</p><input id="dangerPhrase" placeholder="Type: ${state.company?.name || 'CONFIRM'}" /><div class="row mt"><button id="clearTasks" type="button">Clear tasks/operations</button><button id="clearAssets" type="button">Clear assets</button><button id="clearWorkers" type="button">Clear workers</button><button id="resetWorkspace" type="button">Reset workspace data</button></div></section>`;

  el.querySelectorAll('[data-admin-tab]').forEach((button) => button.addEventListener('click', () => actions.setAdminSection(button.dataset.adminTab)));
  el.querySelectorAll('[data-audit-filter]').forEach((button) => button.addEventListener('click', () => actions.setAuditFilter(button.dataset.auditFilter)));
  const requiredPhrase = state.company?.name || 'CONFIRM';
  const confirmDanger = () => {
    const phrase = `${el.querySelector('#dangerPhrase')?.value || ''}`.trim();
    if (phrase !== requiredPhrase) {
      alert(`Confirmation phrase mismatch. Type exactly: ${requiredPhrase}`);
      return false;
    }
    return true;
  };

  el.querySelector('#companySettingsForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await actions.updateCompanyProfile(Object.fromEntries(new FormData(event.currentTarget).entries()));
  });

  el.querySelector('#billingSettingsForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await actions.updateCompanyBilling(Object.fromEntries(new FormData(event.currentTarget).entries()));
  });
  el.querySelector('#addLocationForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await actions.addLocation(Object.fromEntries(new FormData(event.currentTarget).entries()));
  });
  el.querySelectorAll('[data-location-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await actions.updateLocation(form.dataset.locationForm, Object.fromEntries(new FormData(event.currentTarget).entries()));
    });
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
  el.querySelector('#exportAssetsCsv')?.addEventListener('click', () => actions.exportAssetsCsv());
  el.querySelector('#exportTasksCsv')?.addEventListener('click', () => actions.exportTasksCsv());
  el.querySelector('#exportAuditCsv')?.addEventListener('click', () => actions.exportAuditCsv());
  el.querySelector('#exportLocationsCsv')?.addEventListener('click', () => actions.exportLocationsCsv());
  el.querySelector('#exportWorkersCsv')?.addEventListener('click', () => actions.exportWorkersCsv());
  el.querySelector('#exportMembersCsv')?.addEventListener('click', () => actions.exportMembersCsv());
  el.querySelector('#exportInvitesCsv')?.addEventListener('click', () => actions.exportInvitesCsv());
  el.querySelector('#exportCompanyBundle')?.addEventListener('click', () => actions.exportCompanyBundle());

  el.querySelector('#applyAssetCsv')?.addEventListener('click', async () => {
    const file = el.querySelector('#assetCsvInput')?.files?.[0];
    if (!file) return actions.setImportFeedback({ tone: 'error', summary: 'Select an assets CSV before importing.', preview: '' });
    const rows = parseAssetCsv(await file.text()).rows;
    const bootstrapAttachManualsFromCsvHints = el.querySelector('#bootstrapAttachManualsFromCsvHints')?.checked === true;
    actions.setImportConfig({ bootstrapAttachManualsFromCsvHints });
    actions.setImportFeedback({ tone: rows.length ? 'info' : 'error', summary: rows.length ? `Previewing ${Math.min(rows.length, 10)} of ${rows.length} asset rows.` : 'Assets CSV did not contain any data rows.', preview: JSON.stringify(rows.slice(0, 10), null, 2) });
    await actions.importAssets(rows, { bootstrapAttachManualsFromCsvHints });
  });
  el.querySelector('#applyEmployeeCsv')?.addEventListener('click', async () => {
    const file = el.querySelector('#employeeCsvInput')?.files?.[0];
    if (!file) return actions.setImportFeedback({ tone: 'error', summary: 'Select a workers CSV before importing.', preview: '' });
    const rows = parseCsv(await file.text());
    actions.setImportFeedback({ tone: rows.length ? 'info' : 'error', summary: rows.length ? `Previewing ${Math.min(rows.length, 10)} of ${rows.length} worker rows.` : 'Workers CSV did not contain any data rows.', preview: JSON.stringify(rows.slice(0, 10), null, 2) });
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
