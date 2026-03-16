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
  el.innerHTML = `
    <h2>Account & security</h2>
    <div class="grid grid-2">
      <section class="item">
        <h3>Sign-in status</h3>
        <div class="tiny">Signed-in email</div>
        <div><b>${state.user?.email || '-'}</b></div>
        <div class="state-chip-row mt">
          ${chip(profile.emailVerified ? 'email verified' : 'email not verified', profile.emailVerified ? 'good' : 'warn')}
          ${providers.includes('google') ? chip('google enabled', 'good') : chip('google not linked', 'muted')}
          ${chip(mfaEnabled ? 'MFA enrolled' : 'MFA not enrolled', mfaEnabled ? 'good' : 'warn')}
        </div>
        <div class="action-row mt">
          <button type="button" data-account-resend-verify ${profile.emailVerified ? 'disabled' : ''}>Resend verification email</button>
          <button type="button" data-account-refresh-verify>Refresh verification status</button>
          <button type="button" data-account-reset-password>Password reset email</button>
        </div>
        <p class="tiny mt">For owners/admins: MFA enrollment should be completed in your Google/Firebase auth account settings until in-app enrollment is added.</p>
      </section>
      <section class="item">
        <h3>Security visibility</h3>
        <div class="tiny">Recent account activity in this browser profile.</div>
        <div class="list mt">${loginHistory.map((entry) => `<div class="item tiny"><b>${(entry.method || 'password').toUpperCase()}</b> sign-in • ${formatRelativeTime(entry.at)}<div>Providers: ${(entry.providers || []).join(', ') || 'password'}</div></div>`).join('') || '<div class="inline-state info">No recent sign-in history yet.</div>'}</div>
        ${isAdminUser ? '<div class="inline-state warn mt">Admin/owner recommendation: require verified email and MFA enrollment for elevated access.</div>' : ''}
      </section>
    </div>
    <p id="accountSecurityMessage" class="tiny mt"></p>
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

  el.querySelector('[data-account-reset-password]')?.addEventListener('click', async () => {
    try {
      await actions.sendPasswordReset?.();
      writeMessage('Password reset email sent.', 'success');
    } catch (error) {
      writeMessage(error?.message || 'Unable to send password reset email.', 'error');
    }
  });
}
