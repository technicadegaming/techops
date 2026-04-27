import { formatRelativeTime } from './features/notifications.js';

function chip(label, tone = 'muted') {
  return `<span class="state-chip ${tone}">${label}</span>`;
}

export function renderAccount(el, state, actions) {
  const profile = state.profile || {};
  const providers = Array.isArray(profile.authProviders) ? profile.authProviders : ['password'];
  const loginHistory = Array.isArray(profile.securityLoginHistory) ? profile.securityLoginHistory.slice(0, 8) : [];
  const isAdminUser = ['owner', 'admin', 'manager'].includes(`${state.permissions?.companyRole || ''}`) || state.permissions?.isAdmin;
  const mfaEnabled = !!profile.securityMfaEnrolled;
  const displayName = profile.fullName || state.user?.displayName || state.user?.email?.split('@')[0] || '-';
  const appearance = state.ui?.appearance || {};

  el.innerHTML = `
    <div class="page-shell page-narrow"><div class="page-header">
      <div>
        <h2 class="page-title">Account</h2>
        <p class="page-subtitle">Manage your profile, security, workspace access, and sign-in settings.</p>
      </div>
    </div>
    <div class="grid grid-2 settings-stack">
      <section class="item">
        <h3>Profile and account</h3>
        <div class="grid">
          <div><div class="tiny">Display name</div><b>${displayName}</b></div>
          <div><div class="tiny">Signed-in email</div><b>${state.user?.email || '-'}</b></div>
          <div class="state-chip-row">
            ${chip(profile.emailVerified ? 'email verified' : 'email not verified', profile.emailVerified ? 'good' : 'warn')}
            ${chip(providers.includes('google') ? 'google provider linked' : 'google provider not linked', providers.includes('google') ? 'good' : 'muted')}
            ${chip(providers.includes('password') ? 'password login enabled' : 'password login not enabled', providers.includes('password') ? 'info' : 'muted')}
          </div>
        </div>
      </section>

      <section class="item">
        <h3>Security guidance</h3>
        <div class="state-chip-row">
          ${chip(mfaEnabled ? 'MFA enrolled' : 'MFA not enrolled', mfaEnabled ? 'good' : 'warn')}
          ${chip(isAdminUser ? 'elevated access account' : 'standard access account', isAdminUser ? 'info' : 'muted')}
        </div>
        <div class="action-row mt">
          <button type="button" class="btn btn-secondary" data-account-resend-verify ${profile.emailVerified ? 'disabled' : ''}>Resend verification email</button>
          <button type="button" class="btn btn-secondary" data-account-refresh-verify>Refresh verification status</button>
          <button type="button" class="btn btn-secondary" data-account-reset-password>Password reset email</button>
        </div>
        <p class="tiny mt">MFA enrollment is currently managed in your Google/Firebase auth provider account settings.</p>
        ${isAdminUser ? '<div class="inline-state warn mt">Admin recommendation: require verified email + MFA before granting admin/owner level access.</div>' : ''}
      </section>

      <section class="item">
        <h3>Notification preferences</h3>
        <p class="tiny">Notification categories are managed in <b>Admin → AI & notifications</b>. Categories use business-friendly groups (operations, PM, people, AI/docs).</p>
        <p class="tiny">Notification categories will appear here as workspace notification settings are configured.</p>
      </section>

      <section class="item">
        <h3>Appearance / visibility</h3>
        <div class="tiny">Choose a readable theme for this account. Preferences are saved in this browser profile.</div>
        <div class="grid grid-2 mt">
          <label>Theme mode <span class="state-chip info">Optional</span>
            <select data-appearance-mode>
              <option value="light" ${appearance.mode === 'light' ? 'selected' : ''}>Light</option>
              <option value="dark" ${appearance.mode === 'dark' ? 'selected' : ''}>Dark</option>
              <option value="system" ${appearance.mode === 'system' || !appearance.mode ? 'selected' : ''}>System default</option>
            </select>
          </label>
          <label>Theme preset <span class="state-chip info">Optional</span>
            <select data-appearance-preset>
              <option value="scoot_default" ${appearance.preset === 'scoot_default' || !appearance.preset ? 'selected' : ''}>Scoot default</option>
              <option value="high_contrast" ${appearance.preset === 'high_contrast' ? 'selected' : ''}>High contrast</option>
              <option value="soft_blue" ${appearance.preset === 'soft_blue' ? 'selected' : ''}>Soft blue</option>
              <option value="warm_neutral" ${appearance.preset === 'warm_neutral' ? 'selected' : ''}>Warm neutral</option>
              <option value="green_operations" ${appearance.preset === 'green_operations' ? 'selected' : ''}>Green operations</option>
              <option value="company_brand" ${appearance.preset === 'company_brand' ? 'selected' : ''}>Company brand</option>
            </select>
          </label>
          <label>Text size <select data-appearance-text-size><option value="compact" ${appearance.textSize === 'compact' ? 'selected' : ''}>Compact</option><option value="comfortable" ${appearance.textSize === 'comfortable' || !appearance.textSize ? 'selected' : ''}>Comfortable</option><option value="large" ${appearance.textSize === 'large' ? 'selected' : ''}>Large</option></select></label>
          <label>Contrast <select data-appearance-contrast><option value="standard" ${appearance.contrast === 'standard' || !appearance.contrast ? 'selected' : ''}>Standard</option><option value="high" ${appearance.contrast === 'high' ? 'selected' : ''}>High</option></select></label>
          <label>Motion <select data-appearance-motion><option value="standard" ${appearance.motion === 'standard' || !appearance.motion ? 'selected' : ''}>Standard</option><option value="reduced" ${appearance.motion === 'reduced' ? 'selected' : ''}>Reduced</option></select></label>
        </div>
        <div class="grid grid-2 mt">
          <label>Primary color <input type="color" data-appearance-primary value="${appearance.customColors?.primary || '#0f172a'}" /></label>
          <label>Accent color <input type="color" data-appearance-accent value="${appearance.customColors?.accent || '#1d4ed8'}" /></label>
          <label>Background color <input type="color" data-appearance-background value="${appearance.customColors?.background || '#f4f6fb'}" /></label>
          <label>Text color <input type="color" data-appearance-text value="${appearance.customColors?.text || '#14202b'}" /></label>
        </div>
        <div class="action-row mt"><button type="button" class="btn btn-primary" data-save-appearance>Save appearance</button></div>
      </section>

      <section class="item">
        <h3>Recent account activity</h3>
        <div class="tiny">Recent sign-ins for this browser profile.</div>
        <div class="list mt">${loginHistory.map((entry) => `<div class="item tiny"><b>${(entry.method || 'password').toUpperCase()}</b> sign-in • ${formatRelativeTime(entry.at)}<div>Providers: ${(entry.providers || []).join(', ') || 'password'}</div></div>`).join('') || '<div class="inline-state info">No recent sign-in history yet.</div>'}</div>
      </section>
    </div>
    <p id="accountSecurityMessage" class="tiny mt" role="status" aria-live="polite"></p>
    </div>
  `;

  const messageEl = el.querySelector('#accountSecurityMessage');
  const writeMessage = (msg, tone = 'info') => {
    if (!messageEl) return;
    messageEl.textContent = msg;
    messageEl.style.color = tone === 'error' ? '#991b1b' : (tone === 'success' ? '#166534' : '');
  };

  el.querySelector('[data-account-resend-verify]')?.addEventListener('click', async () => {
    try {
      await actions.resendVerification?.();
      writeMessage('Verification email sent. Please check your inbox.', 'success');
    } catch (error) {
      writeMessage(error?.message || 'Unable to send verification email.', 'error');
    }
  });

  el.querySelector('[data-account-refresh-verify]')?.addEventListener('click', async () => {
    try {
      await actions.refreshVerification?.();
      writeMessage('Verification status refreshed.', 'success');
    } catch (error) {
      writeMessage(error?.message || 'Unable to refresh verification status.', 'error');
    }
  });

  el.querySelector('[data-save-appearance]')?.addEventListener('click', () => {
    const next = {
      ...(state.ui?.appearance || {}),
      mode: el.querySelector('[data-appearance-mode]')?.value || 'system',
      preset: el.querySelector('[data-appearance-preset]')?.value || 'scoot_default',
      textSize: el.querySelector('[data-appearance-text-size]')?.value || 'comfortable',
      contrast: el.querySelector('[data-appearance-contrast]')?.value || 'standard',
      motion: el.querySelector('[data-appearance-motion]')?.value || 'standard',
      customColors: {
        primary: el.querySelector('[data-appearance-primary]')?.value || '',
        accent: el.querySelector('[data-appearance-accent]')?.value || '',
        background: el.querySelector('[data-appearance-background]')?.value || '',
        text: el.querySelector('[data-appearance-text]')?.value || ''
      }
    };
    actions.updateAppearance?.(next);
    writeMessage('Appearance updated.', 'success');
  });

  el.querySelector('[data-account-reset-password]')?.addEventListener('click', async () => {
    try {
      await actions.sendPasswordReset?.();
      writeMessage('Password reset email sent.', 'success');
    } catch (error) {
      writeMessage(error?.message || 'Unable to send password reset email.', 'error');
    }
  });
}
