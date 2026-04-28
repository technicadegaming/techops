import { defaultAiSettings } from './data.js';
import { canChangeAISettings, canManageBackups, isAdmin, isManager } from './roles.js';
import { renderWorkspaceReadinessCard } from './features/workspaceReadiness.js';
import { formatRelativeTime } from './features/notifications.js';
import { buildUsageSummary, getTrialDaysRemaining, isTrialExpired, normalizeBillingAddress } from './billing.js';
import { parseAssetCsv } from './features/assetIntake.js';
import { getAuthoritativeOnboardingState } from './features/onboardingStatus.js';

const ACCESS_ROLE_OPTIONS = ['owner', 'admin', 'manager', 'lead', 'staff', 'viewer'];
const BUSINESS_TYPE_OPTIONS = ['Service provider', 'Owner/operator', 'Franchise group', 'Manufacturer', 'Distributor', 'Facilities team', 'Multi-site enterprise', 'Other'];
const INDUSTRY_OPTIONS = ['Family entertainment', 'Arcade and attractions', 'Hospitality', 'Foodservice', 'Retail', 'Healthcare', 'Education', 'Facilities management', 'Manufacturing', 'Transportation', 'Other'];

const aiBooleanFields = ['aiEnabled', 'aiAutoAttach', 'aiUseInternalKnowledge', 'aiUseWebSearch', 'operationsWebResearchEnabled', 'aiAskFollowups', 'aiAllowManualRerun', 'aiAllowStaffManualRerun', 'aiAllowStaffSaveFixesToLibrary', 'aiSaveSuccessfulFixesToLibraryDefault', 'aiShortResponseMode', 'aiVerboseManagerMode', 'aiFeedbackCollectionEnabled', 'mobileConciseModeDefault'];
const aiNumericFields = ['aiMaxWebSources', 'aiConfidenceThreshold'];

const AI_SETTINGS_SCHEMA = [
  { section: 'Enablement', fields: [{ key: 'aiEnabled', label: 'Enable Operations AI', help: 'Turns AI troubleshooting on for this company.' }, { key: 'aiAllowManualRerun', label: 'Allow manual rerun', help: 'Lead-or-higher can rerun AI from a task card.' }, { key: 'aiAllowStaffManualRerun', label: 'Allow staff to manually run/rerun AI', help: 'Operations tasks only. Does not grant admin, import, or manual-enrichment permissions.' }, { key: 'aiAllowStaffSaveFixesToLibrary', label: 'Allow staff to save fixes to library', help: 'Operations tasks only. Does not grant admin, import, or manual-enrichment permissions.' }] },
  { section: 'Troubleshooting behavior', fields: [{ key: 'aiAskFollowups', label: 'Ask follow-up questions', help: 'AI can pause to request missing context.' }, { key: 'aiSaveSuccessfulFixesToLibraryDefault', label: 'Default save successful fixes', help: 'When closing tasks, default to saving fixes in the troubleshooting library.' }, { key: 'aiFeedbackCollectionEnabled', label: 'Collect AI helpfulness feedback', help: 'Capture lightweight feedback from users.' }] },
  { section: 'Enrichment and source controls', fields: [{ key: 'aiUseInternalKnowledge', label: 'Use internal docs/library', help: 'Use company manuals and troubleshooting knowledge first.' }, { key: 'aiUseWebSearch', label: 'Allow web search', help: 'Enable external lookup for added context.' }, { key: 'operationsWebResearchEnabled', label: 'Operations web research enabled', help: 'Alias setting for targeted operations research fallback.' }, { key: 'aiMaxWebSources', label: 'Max web sources', type: 'number', help: 'Limit on external sources per run.' }, { key: 'aiConfidenceThreshold', label: 'Confidence threshold', type: 'number', help: 'Minimum confidence before stronger recommendations.' }] },
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
  { id: 'company', label: 'Company' },
  { id: 'locations', label: 'Locations' },
  { id: 'people', label: 'People' },
  { id: 'billing', label: 'Billing' },
  { id: 'audit', label: 'Audit' },
  { id: 'imports', label: 'Bulk import' },
  { id: 'tools', label: 'AI & Notifications' },
  { id: 'danger', label: 'Danger Zone' }
];

function getReadablePersonName(person = {}) {
  return person.fullName || person.displayName || person.email || person.userId || person.id || 'Unknown person';
}

function renderCompanyAddress(company = {}) {
  const locality = [`${company.hqCity || ''}`.trim(), `${company.hqState || ''}`.trim()].filter(Boolean).join(', ');
  return [`${company.hqStreet || ''}`.trim(), locality, `${company.hqZip || ''}`.trim()].filter(Boolean).join(' ').trim() || company.address || '-';
}

function formatRoleLabel(value = '') { return `${value || 'staff'}`.replace(/_/g, ' '); }
function renderStatusChip(label, tone = 'muted') { return `<span class="state-chip ${tone}">${label}</span>`; }
function shortenStoragePath(path = '') {
  const clean = `${path || ''}`.trim();
  if (!clean) return '—';
  if (clean.length <= 58) return clean;
  return `…${clean.slice(-55)}`;
}
function getRepairOutcomeLabel(action = '', runStatus = 'idle') {
  if (runStatus === 'failed') return { label: 'Extraction failed', tone: 'bad' };
  if (['reextracted', 'materialized'].includes(action)) return { label: 'Extracted', tone: 'good' };
  if (action === 'already_has_chunks') return { label: 'Already has text', tone: 'good' };
  if (action === 'no_manual_storage_path') return { label: 'Missing file', tone: 'warn' };
  if (action === 'extraction_failed') return { label: 'Failed', tone: 'bad' };
  if (action === 'would_reextract') return { label: 'Needs re-extraction', tone: 'warn' };
  if (action === 'would_materialize') return { label: 'Needs extraction', tone: 'warn' };
  return { label: 'Skipped', tone: 'muted' };
}
function getRepairStatusChip(row = {}) {
  const extractionStatus = `${row.extractionStatus || row.newExtractionStatus || ''}`.trim();
  if (extractionStatus === 'completed') return { label: 'Extracted', tone: 'good' };
  if (extractionStatus === 'already_has_chunks') return { label: 'Already has text', tone: 'good' };
  if (extractionStatus === 'no_text_extracted') return { label: 'No readable text', tone: 'warn' };
  if (extractionStatus === 'unsupported_file_type') return { label: 'Unsupported file', tone: 'warn' };
  if (extractionStatus === 'storage_object_missing') return { label: 'Missing file', tone: 'warn' };
  if (extractionStatus === 'storage_download_failed') return { label: 'Download failed', tone: 'bad' };
  if (extractionStatus === 'pdf_parse_failed') return { label: 'Parse failed', tone: 'bad' };
  if (extractionStatus === 'skipped') return { label: 'Skipped', tone: 'muted' };
  return getRepairOutcomeLabel(row.action, row.runStatus);
}


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
  return `<div class="tabs">${ADMIN_SECTIONS.map((section) => `<button type="button" class="tab ${section.id === 'danger' ? 'danger-tab' : ''} ${section.id === activeSection ? 'active' : ''}" data-admin-tab="${section.id}">${section.label}</button>`).join('')}</div>`;
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

  const activeSection = ['members', 'workers', 'invites'].includes(state.adminSection) ? 'people' : (state.adminSection || 'company');
  const workers = state.workers || [];
  const companyInvites = (state.invites || []).filter((invite) => invite.companyId === state.company?.id);
  const pendingInvites = companyInvites.filter((invite) => invite.status === 'pending');
  const members = (state.companyMembers || []).map((membership) => ({ ...membership, person: state.directoryUsers?.find((user) => user.id === membership.userId), isCurrentUser: membership.userId === state.user?.uid }));
  const locations = state.companyLocations || [];
  const settings = { ...defaultAiSettings, ...(state.settings || {}) };
  const selectedNotificationPrefs = new Set((state.settings?.notificationPrefs?.enabledTypes || []));
  const adminUi = state.adminUi || {};
  const workerEmailSet = new Set(workers.map((worker) => `${worker.email || ''}`.trim().toLowerCase()).filter(Boolean));
  const linkedCount = members.filter((member) => workerEmailSet.has(`${member.email || ''}`.trim().toLowerCase())).length;
  const workerByEmail = new Map(workers.map((worker) => [`${worker.email || ''}`.trim().toLowerCase(), worker]).filter(([email]) => email));
  const workerByUserId = new Map(workers.map((worker) => [`${worker.userId || worker.linkedUserId || ''}`.trim(), worker]).filter(([userId]) => userId));
  const inviteByEmail = new Map(companyInvites.map((invite) => [`${invite.email || ''}`.trim().toLowerCase(), invite]).filter(([email]) => email));
  const peopleRows = members.map((member) => {
    const person = member.person || {};
    const email = `${person.email || member.email || member.userEmail || member.userIdentity || ''}`.trim().toLowerCase();
    const worker = workerByUserId.get(`${member.userId || ''}`.trim()) || workerByEmail.get(email) || null;
    const pendingInvite = inviteByEmail.get(email) || null;
    const displayName = person.fullName || person.displayName || member.displayName || member.fullName || email || member.userId || member.id;
    return {
      id: member.id,
      membershipId: member.id,
      userId: member.userId,
      displayName,
      email,
      role: member.role || 'staff',
      status: member.status || 'active',
      createdAt: member.createdAt || person.createdAt || '',
      acceptedAt: member.acceptedAt || pendingInvite?.acceptedAt || '',
      lastLoginAt: person.lastLoginAt || '',
      worker,
      invite: pendingInvite
    };
  });
  companyInvites.forEach((invite) => {
    const email = `${invite.email || ''}`.trim().toLowerCase();
    if (!email) return;
    const existing = peopleRows.find((row) => row.email === email);
    if (existing) {
      if (!existing.invite || (existing.invite?.status !== 'pending' && invite.status === 'pending')) existing.invite = invite;
      return;
    }
    peopleRows.push({
      id: `invite-${invite.id}`,
      membershipId: '',
      userId: '',
      displayName: invite.displayName || email,
      email,
      role: invite.role || 'staff',
      status: 'invited',
      createdAt: invite.createdAt || '',
      acceptedAt: invite.acceptedAt || '',
      lastLoginAt: '',
      worker: workerByEmail.get(email) || null,
      invite
    });
  });
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
  const readinessDismissed = !!state.settings?.workspaceReadinessDismissedAt;
  const importProgress = adminUi.importProgress || null;
  const importConfig = adminUi.importConfig || {};
  const bootstrapModeActive = importProgress?.isRunning
    ? importProgress?.bootstrapMode === true
    : importConfig.bootstrapAttachManualsFromCsvHints === true;
  const progressPercent = importProgress?.totalRows ? Math.round((Math.min(importProgress.completedRows || 0, importProgress.totalRows) / importProgress.totalRows) * 100) : 0;
  const canRunManualRepair = isManager(state.permissions) && typeof actions.checkManualTextExtraction === 'function';
  const manualRepairRows = adminUi.manualRepairRows || [];
  const manualRepairSelected = new Set(adminUi.manualRepairSelectedAssetIds || []);
  const repairableRows = manualRepairRows.filter((row) => ['would_materialize', 'would_reextract'].includes(`${row?.action || ''}`));
  const manualRepairBusy = ['running', 'repairing'].includes(`${adminUi.manualRepairScanStatus || ''}`) || adminUi?.manualRepairProgress?.running === true;
  const repairProgress = adminUi.manualRepairProgress || null;
  const repairSummary = adminUi.manualRepairSummary || {};
  const importProgressMarkup = importProgress?.totalRows
    ? `<div class="item mt"><div class="row space tiny"><b>Import progress</b><span>${progressPercent}%</span></div><progress max="${importProgress.totalRows}" value="${Math.min(importProgress.completedRows || 0, importProgress.totalRows)}" style="width:100%;"></progress><div class="tiny mt">${importProgress.bootstrapMode ? 'Mode: direct CSV bootstrap (admin import mode)' : 'Mode: standard documentation lookup queue'} · Total rows ${importProgress.totalRows} · Imported assets ${importProgress.importedAssets || 0} · Direct manuals attached ${importProgress.directManualsAttached || 0} · Direct attach failed ${importProgress.directManualAttachFailed || 0} · No direct manual URL ${importProgress.noDirectManualUrl || 0} · Completed rows ${importProgress.completedRows || 0}</div></div>`
    : '';
  const readinessBusy = `${adminUi.readinessAction || ''}`.trim();

  const locationManagerChoices = members.map((member) => `<option value="${getReadablePersonName(member.person || member)}">${getReadablePersonName(member.person || member)}</option>`).join('');

  el.innerHTML = `
    <div class="page-shell page-narrow"><div class="page-header">
      <div>
        <h2 class="page-title">Admin</h2>
        <p class="page-subtitle">Manage company settings, people, imports, AI behavior, and workspace controls.</p>
      </div>
    </div>
    ${adminUi.message ? `<div class="inline-state ${adminUi.tone === 'error' ? 'error' : (adminUi.tone === 'success' ? 'success' : 'info')}" role="status" aria-live="polite">${adminUi.message}</div>` : ''}
    ${readinessDismissed
      ? `<div class="tiny mt app-brand-dismissed"><span>Workspace readiness dismissed.</span><button type="button" class="btn btn-ghost btn-small" data-show-readiness="1" ${readinessBusy === 'show' ? 'disabled' : ''}>${readinessBusy === 'show' ? 'Showing workspace readiness…' : 'Show workspace readiness'}</button></div>`
      : renderWorkspaceReadinessCard(state, { compact: true, dismissible: true, busy: readinessBusy === 'dismiss' })}
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
            <label>Upload logo file (optional)<input name="logoFile" type="file" accept="image/*" /></label>
            <div class="tiny">Current logo source: ${state.company?.logoStoragePath || state.company?.logoUrl || 'none'}</div>
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
        <div class="row"><button class="primary" type="submit" ${adminUi.companySettingsBusy ? 'disabled' : ''}>${adminUi.companySettingsBusy ? 'Saving company settings…' : 'Save company settings'}</button></div>
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

    <section class="item ${activeSection === 'people' ? '' : 'hide'}" data-admin-section="people"><h3>People</h3><p class="tiny">App access controls who can sign in. Worker profile controls who can be assigned to tasks. A person can be both.</p><div class="kpi-line"><span>People: ${peopleRows.length}</span><span>Pending invites: ${pendingInvites.length}</span><span>Linked worker profiles: ${linkedCount}</span></div><details><summary><b>Invite person</b></summary><form id="inviteForm" class="grid grid-2 mt"><label>Name<input name="name" placeholder="Full name" /></label><label>Email<input name="email" type="email" placeholder="person@company.com" required /></label><label>App role<select name="role">${ACCESS_ROLE_OPTIONS.map((role) => `<option value="${role}">${formatRoleLabel(role)}</option>`).join('')}</select></label><label><input name="createWorkerProfile" type="checkbox" /> Create worker profile</label><label>Worker title (optional)<input name="workerTitle" placeholder="Technician" /></label><label>Worker notes (optional)<input name="workerNotes" placeholder="Shift, certification, etc." /></label><button class="primary" type="submit">Create invite</button></form></details><div class="list mt">${peopleRows.map((person) => {
    const invite = person.invite || null;
    const inviteCode = `${invite?.inviteCode || ''}`.trim();
    const roleChip = renderStatusChip(formatRoleLabel(person.role || 'staff'), 'muted');
    const accessStatus = invite && invite.status === 'pending' ? 'invited' : (person.status || 'active');
    const statusTone = accessStatus === 'active' ? 'good' : (accessStatus === 'invited' ? 'info' : 'warn');
    const workerLabel = person.worker ? 'assignable worker' : 'not a worker';
    const resetStatus = state.adminUi?.passwordResetByEmail?.[`${person.email || ''}`.trim().toLowerCase()] || '';
    const resetLabel = resetStatus === 'loading' ? 'Sending reset…' : 'Send password reset email';
    return `<div class="item"><div class="row space"><b>${person.displayName || person.email || person.userId || person.id}</b><div class="state-chip-row">${roleChip}${renderStatusChip(accessStatus, statusTone)}${renderStatusChip(workerLabel, person.worker ? 'good' : 'muted')}</div></div><div class="tiny">${person.email || 'No email on file'} ${person.userId ? `| UID: ${person.userId}` : ''}</div><div class="tiny">Created: ${person.createdAt || '—'} · Accepted: ${person.acceptedAt || '—'} · Last login: ${person.lastLoginAt || '—'}</div>${invite ? `<div class="tiny mt">Invite: ${(invite.status || 'pending').replace(/_/g, ' ')}${inviteCode ? ` · code <code>${inviteCode}</code> <button type="button" class="btn btn-ghost btn-small" data-copy-invite-code="${inviteCode}">Copy code</button>` : ''} <button type="button" class="btn btn-ghost btn-small" data-copy-invite-link="${inviteCode}">Copy invite text</button>${invite.status === 'pending' ? ` <button data-revoke-invite="${invite.id}" class="btn btn-ghost btn-small">Revoke</button>` : ''}</div>` : ''}<div class="row mt">${person.membershipId ? `<form data-member-form="${person.membershipId}" class="row"><select name="role">${ACCESS_ROLE_OPTIONS.map((role) => `<option value="${role}" ${role === (person.role || 'staff') ? 'selected' : ''}>${formatRoleLabel(role)}</option>`).join('')}</select><select name="status"><option value="active" ${(person.status || 'active') === 'active' ? 'selected' : ''}>active</option><option value="inactive" ${(person.status || 'active') === 'inactive' ? 'selected' : ''}>inactive</option></select><button type="submit">Save access</button></form>` : ''}${person.email ? `<button type="button" class="btn btn-ghost" data-send-password-reset="${person.email}" ${resetStatus === 'loading' ? 'disabled' : ''}>${resetLabel}</button>` : ''}</div></div>`;
  }).join('') || '<div class="inline-state info">No people yet.</div>'}</div></section>

    <section class="item ${activeSection === 'audit' ? '' : 'hide'}" data-admin-section="audit"><h3>Audit log</h3><p class="tiny">Company activity history.</p><div class="row mt">${categoryOptions.map((option) => `<button type="button" data-audit-filter="${option.id}" class="filter-chip ${auditCategory === option.id ? 'active' : ''}">${option.label}</button>`).join('')}</div><div class="list mt">${auditEntries.map((entry) => `<div class="item tiny"><div class="row space"><b>${renderAuditLine(entry)}</b>${renderStatusChip(formatRelativeTime(entry.timestamp), 'muted')}</div><div>${entry.summary || ''}</div></div>`).join('') || '<div class="inline-state info">No audit entries in this view yet.</div>'}</div></section>

    <section class="item ${activeSection === 'imports' ? '' : 'hide'}" data-admin-section="imports"><h3>Bulk import</h3><p class="tiny">CSV import tooling lives here so Assets stays focused on manual asset creation.</p><div class="item" style="margin-top:8px;"><b>Import templates</b><div class="row mt"><button id="downloadAssetsTemplate" type="button">Download assets CSV template</button><button id="downloadEmployeesTemplate" type="button">Download workers CSV template</button></div></div><div class="grid grid-2 mt"><label>Assets CSV<input id="assetCsvInput" type="file" accept=".csv" /></label><button id="applyAssetCsv" type="button">Import assets</button><label>Workers CSV<input id="employeeCsvInput" type="file" accept=".csv" /></label><button id="applyEmployeeCsv" type="button">Import workers</button></div><label class="tiny mt" style="display:block;"><input id="bootstrapAttachManualsFromCsvHints" type="checkbox" ${bootstrapModeActive ? 'checked' : ''} ${importProgress?.isRunning ? 'disabled' : ''} /> Directly attach CSV manuals (admin import mode, advanced)${importProgress?.isRunning ? ' — mode locked while import is running' : ''}</label>${adminUi.importSummary ? `<div class="tiny mt">${adminUi.importSummary}</div>` : '<div class="tiny mt">Choose a CSV to preview rows before import.</div>'}${importProgressMarkup}<pre id="importPreview" class="tiny">${adminUi.importPreview || ''}</pre><div class="item mt"><b>CSV exports (company-scoped)</b><div class="tiny">Readable exports for operations and admin records. These files exclude invite tokens and other secrets.</div><div class="grid grid-2 mt"><button id="exportAssetsCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export assets CSV</button><button id="exportTasksCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export tasks CSV</button><button id="exportAuditCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export audit log CSV</button><button id="exportLocationsCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export locations CSV</button><button id="exportWorkersCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export workers CSV</button><button id="exportMembersCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export members CSV</button><button id="exportInvitesCsv" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export invites CSV</button></div></div><div class="item mt"><b>Backup bundle</b><div class="tiny">Download one JSON bundle containing core company records for portability and backup confidence.</div><div class="row mt"><button id="exportCompanyBundle" ${canManageBackups(state.permissions) ? '' : 'disabled'} type="button">Export company backup (JSON)</button></div></div></section>
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
      ${canRunManualRepair ? `<div class="item mt">
        <h4 style="margin:0 0 8px;">Manual text extraction repair</h4>
        <p class="tiny">Find assets with attached manuals that do not yet have extracted manual text. Extracted manual text helps Operations AI read error codes, troubleshooting tables, and service steps from manuals.</p>
        <p class="tiny">This does not change the attached manual. It only creates or refreshes searchable manual text chunks for AI troubleshooting.</p>
        <p class="tiny">Assets with image-only/scanned PDFs may need OCR support. They are shown as No readable text, not repaired.</p>
        <div class="row mt">
          <button type="button" data-manual-repair-check ${manualRepairBusy ? 'disabled' : ''}>Check assets needing text extraction</button>
          <button type="button" data-manual-repair-run class="primary" ${(manualRepairBusy || !manualRepairSelected.size) ? 'disabled' : ''}>Re-extract selected</button>
          <button type="button" data-manual-repair-select-all ${(manualRepairBusy || !repairableRows.length) ? 'disabled' : ''}>Select all</button>
          <button type="button" data-manual-repair-clear ${manualRepairBusy ? 'disabled' : ''}>Clear selection</button>
          ${manualRepairRows.length ? `<button type="button" data-manual-repair-run-all ${(manualRepairBusy || !repairableRows.length) ? 'disabled' : ''}>Re-extract all needing repair</button>` : ''}
          ${manualRepairRows.length ? `<button type="button" data-manual-repair-csv ${manualRepairBusy ? 'disabled' : ''}>Download repair results CSV</button>` : ''}
        </div>
        ${adminUi.manualRepairScanStatus === 'running' ? '<div class="inline-state info mt">Checking attached manuals…</div>' : ''}
        ${repairProgress?.running ? `<div class="inline-state info mt">Repairing ${repairProgress.completed || 0} of ${repairProgress.total || 0}…</div>` : ''}
        ${adminUi.manualRepairMessage ? `<div class="tiny mt">${adminUi.manualRepairMessage}</div>` : ''}
        ${adminUi.manualRepairError ? `<div class="inline-state error mt">${adminUi.manualRepairError}</div>` : ''}
        ${manualRepairRows.length ? `<div class="tiny mt">Need extraction: ${repairSummary.needExtraction || 0} · Repaired: ${repairSummary.repaired || 0} · Already had text: ${repairSummary.alreadyHadText || 0} · No readable text: ${repairSummary.noReadableText || 0} · Unsupported file: ${repairSummary.unsupportedFile || 0} · Missing file: ${repairSummary.missingFile || 0} · Failed: ${repairSummary.failed || 0}</div>` : ''}
        ${manualRepairRows.length ? `<div class="list mt">${manualRepairRows.map((row) => {
    const status = getRepairStatusChip(row);
    return `<div class="item">
              <div class="row space">
                <label class="row" style="gap:8px;">
                  <input type="checkbox" data-manual-repair-select="${row.assetId}" ${manualRepairSelected.has(row.assetId) ? 'checked' : ''} ${manualRepairBusy ? 'disabled' : ''} />
                  <b>${row.assetName || row.assetId}</b>
                </label>
                ${renderStatusChip(status.label, status.tone)}
              </div>
              <div class="tiny">Location: ${row.locationName || '—'} · Manual status: ${`${row.manualStatus || 'unknown'}`.replace(/_/g, ' ')} · Current extraction status: ${`${row.currentExtractionStatus || 'unknown'}`.replace(/_/g, ' ')} · Current chunk count: ${Number(row.currentChunkCount || 0)}</div>
              <div class="tiny">Reason: ${(row.extractionReason || row.reason || 'n/a').replace(/_/g, ' ')} · Chunks: ${Number(row.newChunkCount || row.currentChunkCount || 0)} · Engine: ${row.extractionEngine || 'none'}</div>
              <div class="tiny">Latest manual id: ${row.latestManualId || row.manualId || '—'} · Storage path: ${shortenStoragePath(row.storagePath)}${row.extractionError ? ` · ${row.extractionError}` : ''}</div>
              <details class="mt">
                <summary>Raw details</summary>
                <div class="tiny">action: ${row.action || ''}</div>
                <div class="tiny">reason: ${row.reason || ''}</div>
                <div class="tiny">extractionStatus: ${row.extractionStatus || row.newExtractionStatus || ''}</div>
                <div class="tiny">extractionReason: ${row.extractionReason || ''}</div>
                <div class="tiny">extractionError: ${row.extractionError || row.runMessage || ''}</div>
                <div class="tiny">manualId: ${row.manualId || ''}</div>
                <div class="tiny">storagePath: ${row.storagePath || ''}</div>
                <div class="tiny">extractionEngine: ${row.extractionEngine || ''}</div>
                <div class="tiny">prior/new status: ${row.priorExtractionStatus || ''} → ${row.newExtractionStatus || ''}</div>
                <div class="tiny">prior/new chunk count: ${Number(row.priorChunkCount || 0)} → ${Number(row.newChunkCount || 0)}</div>
              </details>
            </div>`;
  }).join('')}</div>` : ''}
      </div>` : ''}
    </section>

    <section class="item ${activeSection === 'danger' ? '' : 'hide'}" data-admin-section="danger"><h3 class="danger">Danger Zone</h3><p class="tiny">Destructive workspace actions are isolated here. Type the company name to confirm.</p><input id="dangerPhrase" placeholder="Type: ${state.company?.name || 'CONFIRM'}" /><div class="row mt"><button id="clearTasks" type="button">Clear tasks/operations</button><button id="clearAssets" type="button">Clear assets</button><button id="clearWorkers" type="button">Clear workers</button><button id="resetWorkspace" type="button">Reset workspace data</button></div></section></div>`;

  el.querySelectorAll('[data-admin-tab]').forEach((button) => button.addEventListener('click', () => actions.setAdminSection(button.dataset.adminTab)));
  el.querySelectorAll('[data-audit-filter]').forEach((button) => button.addEventListener('click', () => actions.setAuditFilter(button.dataset.auditFilter)));
  el.querySelector('[data-dismiss-readiness]')?.addEventListener('click', () => actions.dismissReadinessCard?.());
  el.querySelector('[data-show-readiness]')?.addEventListener('click', () => actions.showReadinessCard?.());
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
    const formData = new FormData(event.currentTarget);
    const payload = Object.fromEntries(formData.entries());
    payload.logoFile = formData.get('logoFile');
    if (!(payload.logoFile instanceof File) || !payload.logoFile.size) delete payload.logoFile;
    await actions.updateCompanyProfile(payload);
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
  el.querySelectorAll('[data-copy-invite-code]').forEach((button) => button.addEventListener('click', async () => {
    const code = `${button.dataset.copyInviteCode || ''}`.trim();
    if (!code) return;
    await actions.copyInviteCode?.(code);
  }));

  el.querySelectorAll('[data-copy-invite-link]').forEach((button) => button.addEventListener('click', async () => {
    const code = `${button.dataset.copyInviteLink || ''}`.trim();
    if (!code) return;
    const inviteText = `Invite code: ${code} | Open ${window.location.origin}/?invite=${encodeURIComponent(code)} and sign in with your invited email.`;
    await actions.copyInviteCode?.(inviteText);
  }));
  el.querySelectorAll('[data-send-password-reset]').forEach((button) => button.addEventListener('click', async () => {
    await actions.sendPersonPasswordReset?.(button.dataset.sendPasswordReset);
  }));
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
  el.querySelector('[data-manual-repair-check]')?.addEventListener('click', () => actions.checkManualTextExtraction({ limit: 100 }));
  el.querySelector('[data-manual-repair-run]')?.addEventListener('click', () => actions.runManualRepairForSelection());
  el.querySelector('[data-manual-repair-select-all]')?.addEventListener('click', () => actions.selectAllManualRepairRows());
  el.querySelector('[data-manual-repair-clear]')?.addEventListener('click', () => actions.clearManualRepairSelection());
  el.querySelector('[data-manual-repair-run-all]')?.addEventListener('click', () => {
    const repairableIds = (state.adminUi?.manualRepairRows || []).filter((row) => ['would_materialize', 'would_reextract'].includes(`${row?.action || ''}`)).map((row) => row.assetId).filter(Boolean);
    if (!repairableIds.length) return;
    if (!window.confirm(`This will extract manual text for ${repairableIds.length} assets. Continue?`)) return;
    actions.runManualRepairForSelection({ assetIds: repairableIds });
  });
  el.querySelector('[data-manual-repair-csv]')?.addEventListener('click', () => actions.downloadManualRepairResultsCsv());
  el.querySelectorAll('[data-manual-repair-select]').forEach((input) => input.addEventListener('change', (event) => {
    actions.toggleManualRepairSelection(input.dataset.manualRepairSelect, event.currentTarget?.checked === true);
  }));
}
