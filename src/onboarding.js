import { renderWorkspaceReadinessCard } from './features/workspaceReadiness.js';

const SUPPORTED_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London'
];

function getDefaultTimeZone() {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return SUPPORTED_TIMEZONES.includes(resolved) ? resolved : 'UTC';
}

const TIMEZONE_LABELS = {
  UTC: 'Coordinated Universal Time (UTC)',
  'America/New_York': 'Eastern Time (ET) — EST/EDT',
  'America/Chicago': 'Central Time (CT) — CST/CDT',
  'America/Denver': 'Mountain Time (MT) — MST/MDT',
  'America/Los_Angeles': 'Pacific Time (PT) — PST/PDT',
  'America/Phoenix': 'Arizona Time — MST',
  'America/Anchorage': 'Alaska Time (AKT) — AKST/AKDT',
  'Pacific/Honolulu': 'Hawaii Time (HT) — HST',
  'Europe/London': 'UK Time — GMT/BST'
};

function renderTimeZoneOptions(selected) {
  return SUPPORTED_TIMEZONES.map((tz) => `<option value="${tz}" ${tz === selected ? 'selected' : ''}>${TIMEZONE_LABELS[tz] || tz}</option>`).join('');
}

function composeAddress({ street = '', city = '', state = '', zip = '' } = {}) {
  const cleanStreet = `${street || ''}`.trim();
  const cleanCity = `${city || ''}`.trim();
  const cleanState = `${state || ''}`.trim();
  const cleanZip = `${zip || ''}`.trim();
  const locality = [cleanCity, cleanState].filter(Boolean).join(', ');
  return [cleanStreet, locality, cleanZip].filter(Boolean).join(' ').trim();
}

function normalizeFirstLocationPayload(formData, companyName, companyTimeZone) {
  const useDifferentLocation = formData.get('useDifferentFirstLocation') === 'on';
  const hqStreet = `${formData.get('hqStreet') || ''}`.trim();
  const hqCity = `${formData.get('hqCity') || ''}`.trim();
  const hqState = `${formData.get('hqState') || ''}`.trim();
  const hqZip = `${formData.get('hqZip') || ''}`.trim();
  const hqAddress = composeAddress({ street: hqStreet, city: hqCity, state: hqState, zip: hqZip });
  const hqTz = `${companyTimeZone || ''}`.trim() || getDefaultTimeZone();
  if (!useDifferentLocation) {
    const fallbackName = `${companyName || ''}`.trim() ? `${companyName} HQ` : 'Company HQ';
    return {
      name: fallbackName,
      address: hqAddress,
      timeZone: hqTz,
      notes: 'Auto-created from company HQ during onboarding.'
    };
  }

  const nameInput = `${formData.get('firstLocationName') || ''}`.trim();
  const addressInput = `${formData.get('firstLocationAddress') || ''}`.trim();
  const timeZoneInput = `${formData.get('firstLocationTimeZone') || ''}`.trim();
  const notesInput = `${formData.get('firstLocationNotes') || ''}`.trim();
  const fallbackName = `${companyName || ''}`.trim() ? `${companyName} Main` : 'Main location';

  return {
    name: nameInput || fallbackName,
    address: addressInput || hqAddress,
    timeZone: timeZoneInput || hqTz,
    notes: notesInput
  };
}

function renderInitialOnboarding(el, state, actions) {
  const selectedTimeZone = getDefaultTimeZone();
  const onboardingMessage = state.onboardingUi?.message || '';
  const onboardingTone = state.onboardingUi?.tone || 'info';
  const pendingAction = state.onboardingUi?.pendingAction || '';
  const handoffStatus = state.onboardingUi?.handoffStatus || 'idle';
  el.innerHTML = `
    <h2>Welcome to WOW Technicade Operations</h2>
    <p class="tiny">Create your company workspace in under a minute, or join one with an invite code.</p>
    ${onboardingMessage ? `<div class="tiny" style="margin:0 0 12px; padding:8px 10px; border-radius:8px; border:1px solid ${onboardingTone === 'error' ? '#fca5a5' : (onboardingTone === 'success' ? '#86efac' : '#d1d5db')}; background:${onboardingTone === 'error' ? '#fef2f2' : (onboardingTone === 'success' ? '#f0fdf4' : '#f9fafb')}; color:${onboardingTone === 'error' ? '#991b1b' : (onboardingTone === 'success' ? '#166534' : '#374151')};">${onboardingMessage}</div>` : ''}
    ${handoffStatus === 'working' ? '<div class="inline-state info mt">Finishing account handoff…</div>' : ''}
    <div class="grid grid-2">
      <form id="createCompanyForm" class="item onboarding-form">
        <h3>Create company</h3>
        <label>Company name<input name="name" placeholder="Example: WOW Technicade" required /></label>
        <label>Contact email<input name="primaryEmail" type="email" placeholder="name@company.com" value="${state.user?.email || ''}" /></label>
        <label>Primary phone<input name="primaryPhone" placeholder="Example: (555) 555-5555" /></label>
        <p class="tiny" style="margin:0;">Company profile</p>
        <label>HQ street<input name="hqStreet" placeholder="123 Main St" /></label>
        <div class="row onboarding-row">
          <label style="flex:1;">City<input name="hqCity" placeholder="Chicago" /></label>
          <label style="flex:1;">State<input name="hqState" placeholder="IL" /></label>
          <label style="flex:1;">ZIP<input name="hqZip" placeholder="60601" inputmode="numeric" /></label>
        </div>
        <label>Company timezone
          <select name="timeZone" required>${renderTimeZoneOptions(selectedTimeZone)}</select>
        </label>
        <div class="row onboarding-row">
          <label style="flex:1;">Estimated users<input name="estimatedUsers" type="number" min="0" placeholder="Example: 25" /></label>
          <label style="flex:1;">Estimated assets<input name="estimatedAssets" type="number" min="0" placeholder="Example: 150" /></label>
        </div>
        <fieldset class="onboarding-location-fieldset">
          <label class="row" style="align-items:center; gap:8px;">
            <input type="checkbox" name="useDifferentFirstLocation" style="width:auto;" />
            <span>My first location is different from HQ</span>
          </label>
          <div id="firstLocationFields" class="hide">
            <label>First location name<input name="firstLocationName" placeholder="Example: Main Plant" /></label>
            <label>First location address<input name="firstLocationAddress" placeholder="Street, city, state" /></label>
            <label>First location timezone
              <select name="firstLocationTimeZone">${renderTimeZoneOptions(selectedTimeZone)}</select>
            </label>
            <label>First location notes (optional)<textarea name="firstLocationNotes" placeholder="Optional setup notes"></textarea></label>
          </div>
        </fieldset>
        <button class="primary" ${pendingAction ? "disabled" : ""}>${pendingAction === "create_company" ? "Creating workspace..." : "Create company workspace"}</button>
      </form>
      <form id="joinCompanyForm" class="item onboarding-form">
        <h3>Join existing company</h3>
        <label>Invite code<input name="inviteCode" placeholder="Paste the code from your admin" required /></label>
        <button class="primary" ${pendingAction ? "disabled" : ""}>${pendingAction === "accept_invite" ? "Joining..." : "Accept invite & join"}</button>
        <p class="tiny">Ask your admin for an invite code from Admin → Invites.</p>
      </form>
    </div>`;

  const locationToggle = el.querySelector('[name="useDifferentFirstLocation"]');
  const firstLocationFields = el.querySelector('#firstLocationFields');
  const syncFirstLocationVisibility = () => {
    const useDifferentLocation = locationToggle?.checked === true;
    firstLocationFields?.classList.toggle('hide', !useDifferentLocation);
  };
  locationToggle?.addEventListener('change', syncFirstLocationVisibility);
  syncFirstLocationVisibility();

  el.querySelector('#createCompanyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const companyName = `${fd.get('name') || ''}`.trim();
    const companyTimeZone = `${fd.get('timeZone') || ''}`.trim();
    await actions.createCompany({
      name: companyName,
      primaryEmail: fd.get('primaryEmail'),
      primaryPhone: fd.get('primaryPhone'),
      hqStreet: fd.get('hqStreet'),
      hqCity: fd.get('hqCity'),
      hqState: fd.get('hqState'),
      hqZip: fd.get('hqZip'),
      timeZone: companyTimeZone,
      estimatedUsers: fd.get('estimatedUsers'),
      estimatedAssets: fd.get('estimatedAssets'),
      firstLocation: normalizeFirstLocationPayload(fd, companyName, companyTimeZone)
    });
  });

  el.querySelector('#joinCompanyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await actions.acceptInvite(`${fd.get('inviteCode') || ''}`.trim());
  });
}

function renderSetupWizard(el, state, actions) {
  const step = state.setupWizard?.step || 1;
  const msg = state.setupWizard?.message || '';
  const tone = state.setupWizard?.tone || 'info';
  const workerDefaultName = state.user?.displayName || state.user?.email?.split('@')[0] || '';
  const currentLocation = (state.companyLocations || [])[0] || {};

  el.innerHTML = `
    <h2>Setup wizard</h2>
    <p class="tiny">Finish a few steps so your workspace is ready for daily operations.</p>
    ${renderWorkspaceReadinessCard(state, { compact: true, dismissible: true })}
    ${msg ? `<div class="inline-state ${tone} mt">${msg}</div>` : ''}
    <div class="item mt">
      <div class="tiny">Step ${step} of 6 • Guided workspace setup</div>
      <div class="kpi-line mt"><span>1. Company basics</span><span>2. First location</span><span>3. Team setup</span><span>4. Add assets</span><span>5. AI setup</span><span>6. Review and launch</span></div>
    </div>

    <form id="wizardForm" class="item mt grid">
      <div data-step="1" class="${step === 1 ? '' : 'hide'}">
        <h3>Company basics</h3>
        <label>Company name<input name="companyName" value="${state.company?.name || ''}" required /></label>
        <label>Contact email<input name="primaryEmail" type="email" value="${state.company?.primaryEmail || state.user?.email || ''}" /></label>
        <label>Primary phone<input name="primaryPhone" value="${state.company?.primaryPhone || ''}" /></label>
        <label>Timezone<select name="timeZone">${renderTimeZoneOptions(state.company?.timeZone || getDefaultTimeZone())}</select></label>
      </div>

      <div data-step="2" class="${step === 2 ? '' : 'hide'}">
        <h3>First location</h3>
        <label>Name<input name="locationName" value="${currentLocation.name || ''}" required /></label>
        <label>Address<input name="locationAddress" value="${currentLocation.address || state.company?.address || ''}" /></label>
        <label>Timezone<select name="locationTimeZone">${renderTimeZoneOptions(currentLocation.timeZone || state.company?.timeZone || getDefaultTimeZone())}</select></label>
      </div>

      <div data-step="3" class="${step === 3 ? '' : 'hide'}">
        <h3>Team setup</h3>
        <div class="tiny">Members = signed-in users. Staff records = assignable technicians. Invites = optional next step.</div>
        <label>Owner team member name<input name="ownerWorkerDisplayName" value="${workerDefaultName}" /></label>
        <label>Add first assignable staff name (optional)<input name="newWorkerName" placeholder="Example: Alex Smith" /></label>
        <label>Add first assignable staff email (optional)<input name="newWorkerEmail" type="email" placeholder="alex@company.com" /></label>
        <label>Invite email (optional)<input name="inviteEmail" type="email" placeholder="person@company.com" /></label>
        <label>Invite role<select name="inviteRole"><option value="staff">Staff</option><option value="lead">Lead</option><option value="assistant_manager">Assistant manager</option><option value="manager">Manager</option><option value="admin">Admin</option></select></label>
      </div>

      <div data-step="4" class="${step === 4 ? '' : 'hide'}">
        <h3>Add assets</h3>
        <div class="tiny">Add assets now (manual, CSV, or paste list). You can skip and continue later.</div>
        <details><summary class="tiny">CSV template</summary><pre class="tiny">name,manufacturer,locationName\nTicket Kiosk 01,Betson,Main Floor\nRedemption Game 02,Raw Thrills,Arcade Zone</pre></details>
        <label>First asset name (optional)<input name="assetName" placeholder="Example: Ticket Kiosk 01" /></label>
        <label>Asset ID (optional)<input name="assetId" placeholder="Example: kiosk-01" /></label>
        <label>Location name<input name="assetLocation" value="${currentLocation.name || ''}" /></label>
        <label>Paste asset list (optional, one per line)<textarea name="assetBulkList" placeholder="Ticket Kiosk 02
Air Hockey 01"></textarea></label>
      </div>

      <div data-step="5" class="${step === 5 ? '' : 'hide'}">
        <h3>AI setup</h3>
        <div class="tiny">AI runs after task save (not before). Manual troubleshooting runs require Lead or higher.</div>
        <label><input type="radio" name="aiEnabled" value="yes" ${state.settings?.aiEnabled ? 'checked' : ''} /> Enable AI troubleshooting for this company</label>
        <label><input type="radio" name="aiEnabled" value="no" ${state.settings?.aiEnabled ? '' : 'checked'} /> Keep AI disabled for now</label>
      </div>

      <div data-step="6" class="${step === 6 ? '' : 'hide'}">
        <h3>Review and launch</h3>
        ${renderWorkspaceReadinessCard(state, { compact: true, title: 'Launch checklist', dismissible: true })}
        <div class="tiny mt">You can launch now and continue optional steps anytime in Admin.</div>
      </div>

      <div class="row mt">
        <button type="button" data-wizard-back ${step <= 1 ? 'disabled' : ''}>Back</button>
        ${step < 6 ? '<button type="button" data-wizard-skip>Skip for now</button>' : ''}
        <button class="primary">${step < 6 ? 'Save and continue' : 'Launch workspace'}</button>
      </div>
    </form>`;

  el.querySelector('[data-wizard-back]')?.addEventListener('click', () => actions.setSetupStep(Math.max(1, step - 1)));
  el.querySelector('[data-wizard-skip]')?.addEventListener('click', () => actions.skipSetupStep(step));
  el.querySelector('[data-dismiss-readiness]')?.addEventListener('click', () => actions.dismissReadiness?.());
  el.querySelector('#wizardForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    await actions.submitSetupStep(step, payload);
  });
}

export function renderOnboarding(el, state, actions) {
  if (state.setupWizard?.active) {
    renderSetupWizard(el, state, actions);
    return;
  }
  renderInitialOnboarding(el, state, actions);
}
