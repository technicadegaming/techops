import { renderWorkspaceReadinessCard } from './features/workspaceReadiness.js';
import { ASSET_CSV_TEMPLATE, ASSET_IMPORT_COLUMNS } from './features/assetIntake.js';

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

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC'
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
  const useDifferentLocation = `${formData.get('firstLocationName') || ''}`.trim() || `${formData.get('firstLocationAddress') || ''}`.trim();
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
  const inviteCodePrefill = `${state.onboardingUi?.inviteCodePrefill || ''}`.trim();
  el.innerHTML = `
    <h2>Welcome to Scoot Business</h2>
    <p class="tiny">Create your company workspace in under a minute, or join one with an invite code. New workspaces begin on a free trial; billing setup comes later in Admin.</p>
    ${onboardingMessage ? `<div class="tiny" style="margin:0 0 12px; padding:8px 10px; border-radius:8px; border:1px solid ${onboardingTone === 'error' ? '#fca5a5' : (onboardingTone === 'success' ? '#86efac' : '#d1d5db')}; background:${onboardingTone === 'error' ? '#fef2f2' : (onboardingTone === 'success' ? '#f0fdf4' : '#f9fafb')}; color:${onboardingTone === 'error' ? '#991b1b' : (onboardingTone === 'success' ? '#166534' : '#374151')};">${onboardingMessage}</div>` : ''}
    ${handoffStatus === 'working' ? '<div class="inline-state info mt">Finishing account handoff…</div>' : ''}
    <div class="grid grid-2">
      <form id="createCompanyForm" class="item onboarding-form">
        <h3>Create company</h3>
        <label>Company name<input name="name" placeholder="Scoot" required /></label>
        <label>Contact email<input name="primaryEmail" type="email" placeholder="name@company.com" value="${state.user?.email || ''}" /></label>
        <label>Primary phone<input name="primaryPhone" placeholder="Example: (555) 555-5555" /></label>
        <p class="tiny" style="margin:0;">Company profile</p>
        <label>HQ street<input name="hqStreet" placeholder="123 Main St" /></label>
        <label>HQ country
          <select name="hqCountry" id="hqCountrySelect">
            <option value="US" selected>United States</option>
            <option value="CA">Canada</option>
            <option value="GB">United Kingdom</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
        <div class="row onboarding-row">
          <label style="flex:1;">City<input name="hqCity" placeholder="Chicago" /></label>
          <label style="flex:1;" id="hqStateSelectWrap">State
            <select name="hqState">${US_STATES.map((stateCode) => `<option value="${stateCode}">${stateCode}</option>`).join('')}</select>
          </label>
          <label style="flex:1;" id="hqStateTextWrap" class="hide">State/Region
            <input name="hqRegion" placeholder="Province / region" />
          </label>
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
          <div class="tiny">Your first location is created from HQ by default. If needed, customize it now.</div>
          <details>
            <summary class="tiny"><b>Customize first location (optional)</b></summary>
          <div id="firstLocationFields">
            <label>First location name<input name="firstLocationName" placeholder="Example: Main Plant" /></label>
            <label>First location address<input name="firstLocationAddress" placeholder="Street, city, state" /></label>
            <label>First location timezone
              <select name="firstLocationTimeZone">${renderTimeZoneOptions(selectedTimeZone)}</select>
            </label>
            <label>First location notes (optional)<textarea name="firstLocationNotes" placeholder="Optional setup notes"></textarea></label>
          </div>
          </details>
        </fieldset>
        <button class="primary" ${pendingAction ? "disabled" : ""}>${pendingAction === "create_company" ? "Creating workspace..." : "Create company workspace"}</button>
      </form>
      <form id="joinCompanyForm" class="item onboarding-form">
        <h3>Join existing company</h3>
        <label>Invite code<input name="inviteCode" placeholder="Paste the code from your admin" value="${inviteCodePrefill}" required /></label>
        <button class="primary" ${pendingAction ? "disabled" : ""}>${pendingAction === "accept_invite" ? "Joining..." : "Accept invite & join"}</button>
        <p class="tiny">Use the same email as your invite, or Continue with Google from login. Ask your admin for an invite code from Admin → Invites.</p>
      </form>
    </div>`;

  const countrySelect = el.querySelector('#hqCountrySelect');
  const hqStateSelectWrap = el.querySelector('#hqStateSelectWrap');
  const hqStateTextWrap = el.querySelector('#hqStateTextWrap');
  const syncRegionInputs = () => {
    const isUS = `${countrySelect?.value || 'US'}`.trim().toUpperCase() === 'US';
    hqStateSelectWrap?.classList.toggle('hide', !isUS);
    hqStateTextWrap?.classList.toggle('hide', isUS);
  };
  countrySelect?.addEventListener('change', syncRegionInputs);
  syncRegionInputs();

  el.querySelector('#createCompanyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const companyName = `${fd.get('name') || ''}`.trim();
    const companyTimeZone = `${fd.get('timeZone') || ''}`.trim();
    const regionFallback = `${fd.get('hqRegion') || ''}`.trim();
    await actions.createCompany({
      name: companyName,
      primaryEmail: fd.get('primaryEmail'),
      primaryPhone: fd.get('primaryPhone'),
      hqStreet: fd.get('hqStreet'),
      hqCity: fd.get('hqCity'),
      hqState: fd.get('hqState') || regionFallback,
      hqCountry: fd.get('hqCountry') || 'US',
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
      <div class="tiny">Step ${step} of 6 • Focused workspace setup</div>
      <div class="kpi-line mt"><span>1. Confirm company</span><span>2. Confirm HQ location</span><span>3. Team setup</span><span>4. Add assets</span><span>5. AI setup</span><span>6. Review and launch</span></div>
    </div>

    <form id="wizardForm" class="item mt grid">
      <div data-step="1" class="${step === 1 ? '' : 'hide'}">
        <h3>Company basics (confirm)</h3>
        <div class="tiny">Captured during company creation. Adjust only if needed.</div>
        <label>Company name<input name="companyName" value="${state.company?.name || ''}" required /></label>
        <label>Contact email<input name="primaryEmail" type="email" value="${state.company?.primaryEmail || state.user?.email || ''}" /></label>
        <label>Primary phone<input name="primaryPhone" value="${state.company?.primaryPhone || ''}" /></label>
        <label>Timezone<select name="timeZone">${renderTimeZoneOptions(state.company?.timeZone || getDefaultTimeZone())}</select></label>
      </div>

      <div data-step="2" class="${step === 2 ? '' : 'hide'}">
        <h3>First location (confirm)</h3>
        <div class="tiny">Defaulted from HQ to reduce first-time setup friction.</div>
        <label>Name<input name="locationName" value="${currentLocation.name || ''}" required /></label>
        <label>Address<input name="locationAddress" value="${currentLocation.address || state.company?.address || ''}" /></label>
        <label>Timezone<select name="locationTimeZone">${renderTimeZoneOptions(currentLocation.timeZone || state.company?.timeZone || getDefaultTimeZone())}</select></label>
      </div>

      <div data-step="3" class="${step === 3 ? '' : 'hide'}">
        <h3>Team setup</h3>
        <div class="tiny">Members = signed-in users. Staff records = assignable technicians. Invites = optional next step.</div>
        <label>Your admin display name<input name="ownerWorkerDisplayName" value="${workerDefaultName}" /></label>
        <label>Add another staff member name (optional)<input name="newWorkerName" placeholder="Example: Alex Smith" /></label>
        <label>Add another staff member email (optional)<input name="newWorkerEmail" type="email" placeholder="alex@company.com" /></label>
        <label>Invite email (optional)<input name="inviteEmail" type="email" placeholder="person@company.com" /></label>
        <label>Invite role<select name="inviteRole"><option value="staff">Staff</option><option value="lead">Lead</option><option value="assistant_manager">Assistant manager</option><option value="manager">Manager</option><option value="admin">Admin</option></select></label>
      </div>

      <div data-step="4" class="${step === 4 ? '' : 'hide'}">
        <h3>Asset readiness</h3>
        <div class="tiny">Operations works best once assets exist. Paste a list of titles to run the same manual-first research flow used in Assets, or add a single asset for one-off setup. You can still skip for now.</div>
        <div class="inline-state info mt">Template v2: source-of-truth intake fields (${ASSET_IMPORT_COLUMNS.slice(0, 10).map((column) => `<code>${column}</code>`).join(', ')}) plus optional manual-search hints.</div>
        ${(state.assetUi?.onboardingValidationErrors || []).length ? `<div class="inline-state error mt"><b>Import issues to fix:</b><ul>${(state.assetUi.onboardingValidationErrors || []).slice(0, 6).map((error) => `<li>${error}</li>`).join('')}</ul></div>` : ''}
        <details>
          <summary class="tiny">CSV template and guidance</summary>
          <div class="tiny" style="margin:8px 0;">Use UTF-8 CSV with a header row. Fill the first 10 intake columns first; optional hint columns help research (<code>manualHintUrl</code>, <code>manualSourceHintUrl</code>, <code>supportHintUrl</code>, aliases, vendor/distributor). Durable manual fields are system-managed after enrichment and should not be hand-entered. Older templates are still accepted, but manual/support result columns are treated only as hints.</div>
          <textarea readonly rows="5">${ASSET_CSV_TEMPLATE}</textarea>
          <a download="assets-template.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent(ASSET_CSV_TEMPLATE)}">Download template</a>
        </details>
        <label>First asset name (optional)<input name="assetName" placeholder="Example: Ticket Kiosk 01" /></label>
        <label>Manufacturer (optional)<input name="assetManufacturer" placeholder="Example: Betson" /></label>
        <label>Asset ID (optional)<input name="assetId" placeholder="Example: kiosk-01" /></label>
        <label>Location name<input name="assetLocation" value="${currentLocation.name || ''}" /></label>
        <label>Upload assets CSV (optional)<input name="assetCsvFile" type="file" accept=".csv,text/csv" /></label>
        <label>Or paste CSV rows (optional)<textarea name="assetCsvText" rows="4" placeholder="asset name,manufacturer,location\nTicket Kiosk 03,Betson,Main Floor"></textarea></label>
        <label>Paste machine/game titles (optional)
          <textarea name="assetBulkList" placeholder="Quick Drop, Jurassic Park, Virtual Rabbids, Air FX
Or one title per line"></textarea>
        </label>
        <div class="tiny">After you continue, Scoot Business will research the pasted titles and open the Assets review grid so you can review manuals, source pages, and support links before import.</div>
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
    const formData = new FormData(event.currentTarget);
    const payload = Object.fromEntries(formData.entries());
    if ((state.setupWizard?.step || 1) === 4) {
      const csvFile = formData.get('assetCsvFile');
      if (csvFile && typeof csvFile.text === 'function' && csvFile.size > 0) {
        payload.assetCsvText = `${payload.assetCsvText || ''}`.trim() || await csvFile.text();
      }
    }
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
