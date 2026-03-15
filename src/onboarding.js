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

function renderTimeZoneOptions(selected) {
  return SUPPORTED_TIMEZONES.map((tz) => `<option value="${tz}" ${tz === selected ? 'selected' : ''}>${tz}</option>`).join('');
}

function normalizeFirstLocationPayload(formData, companyName, companyTimeZone) {
  const useHq = formData.get('useHqForFirstLocation') === 'on';
  const hqAddress = `${formData.get('address') || ''}`.trim();
  const hqTz = `${companyTimeZone || ''}`.trim() || getDefaultTimeZone();
  if (useHq) {
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

export function renderOnboarding(el, state, actions) {
  const selectedTimeZone = getDefaultTimeZone();
  el.innerHTML = `
    <h2>Welcome to WOW Technicade Operations</h2>
    <p class="tiny">Create your company workspace in under a minute, or join one with an invite code.</p>
    <div class="grid grid-2">
      <form id="createCompanyForm" class="item onboarding-form">
        <h3>Create company</h3>
        <label>Company name<input name="name" placeholder="Example: WOW Technicade" required /></label>
        <label>Contact email<input name="primaryEmail" type="email" placeholder="name@company.com" value="${state.user?.email || ''}" /></label>
        <label>Primary phone<input name="primaryPhone" placeholder="Example: (555) 555-5555" /></label>
        <p class="tiny" style="margin:0;">Company profile</p>
        <label>HQ address<input name="address" placeholder="Street, city, state" /></label>
        <label>Company timezone
          <select name="timeZone" required>${renderTimeZoneOptions(selectedTimeZone)}</select>
        </label>
        <div class="row onboarding-row">
          <label style="flex:1;">Estimated users<input name="estimatedUsers" type="number" min="0" placeholder="Example: 25" /></label>
          <label style="flex:1;">Estimated assets<input name="estimatedAssets" type="number" min="0" placeholder="Example: 150" /></label>
        </div>
        <fieldset class="onboarding-location-fieldset">
          <label class="row" style="align-items:center; gap:8px;">
            <input type="checkbox" name="useHqForFirstLocation" checked style="width:auto;" />
            <span>Use company HQ as first location</span>
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
        <button class="primary">Create company workspace</button>
      </form>
      <form id="joinCompanyForm" class="item onboarding-form">
        <h3>Join existing company</h3>
        <label>Invite code<input name="inviteCode" placeholder="Paste the code from your admin" required /></label>
        <button class="primary">Accept invite & join</button>
        <p class="tiny">Ask your admin for an invite code from Admin → Invites.</p>
      </form>
    </div>`;

  const locationToggle = el.querySelector('[name="useHqForFirstLocation"]');
  const firstLocationFields = el.querySelector('#firstLocationFields');
  const syncFirstLocationVisibility = () => {
    const useHq = locationToggle?.checked !== false;
    firstLocationFields?.classList.toggle('hide', useHq);
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
      address: fd.get('address'),
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
