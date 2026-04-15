import { formatActionError } from '../uiActions.js';
import { setActiveCompanyContext } from '../data.js';
import { syncPendingInviteCode } from './boot.js';

import { evaluatePassword, buildRegisterPasswordHelpText } from './authController.helpers.js';

export function createAuthController({
  state,
  authMessage,
  login,
  register,
  loginWithGoogle,
  sendForgotPasswordEmail,
  documentRef = document
}) {
  const loginForm = documentRef.getElementById('loginForm');
  const registerForm = documentRef.getElementById('registerForm');
  const googleLoginBtn = documentRef.getElementById('googleLoginBtn');
  const googleRegisterBtn = documentRef.getElementById('googleRegisterBtn');
  const forgotPasswordBtn = documentRef.getElementById('forgotPasswordBtn');
  const authInviteCodeInput = documentRef.getElementById('authInviteCode');
  const registerPasswordInput = registerForm?.querySelector('[name="password"]');
  const registerConfirmInput = registerForm?.querySelector('[name="confirmPassword"]');
  const registerPasswordHelp = documentRef.getElementById('registerPasswordHelp');

  function setAuthMessage(message = '') {
    if (authMessage) authMessage.textContent = message;
  }

  function syncRegisterPasswordHelp() {
    const password = `${registerPasswordInput?.value || ''}`;
    const confirmPassword = `${registerConfirmInput?.value || ''}`;
    if (registerPasswordHelp) registerPasswordHelp.textContent = buildRegisterPasswordHelpText(password, confirmPassword);
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    syncPendingInviteCode(state, documentRef);
    try {
      await login(fd.get('email'), fd.get('password'));
    } catch (error) {
      setAuthMessage(error.message);
    }
  }

  async function handleRegisterSubmit(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const fullName = `${fd.get('fullName') || ''}`.trim();
    const password = `${fd.get('password') || ''}`;
    const confirmPassword = `${fd.get('confirmPassword') || ''}`;
    const passwordState = evaluatePassword(password);
    if (!fullName) {
      setAuthMessage('Full name is required.');
      return;
    }
    if (password !== confirmPassword) {
      setAuthMessage('Passwords do not match.');
      return;
    }
    if (!passwordState.ok) {
      setAuthMessage(`Password must include ${passwordState.message}.`);
      return;
    }
    try {
      syncPendingInviteCode(state, documentRef);
      setActiveCompanyContext(null);
      await register(fd.get('email'), password, { fullName });
      setAuthMessage('Account created. Handing off to workspace setup...');
    } catch (error) {
      setAuthMessage(error.message);
    }
  }

  async function handleGoogleAuth() {
    syncPendingInviteCode(state, documentRef);
    try {
      await loginWithGoogle();
      setAuthMessage('Google sign-in successful. Finishing setup...');
    } catch (error) {
      setAuthMessage(formatActionError(error, 'Google sign-in failed.'));
    }
  }

  async function handleForgotPassword() {
    const email = `${loginForm?.querySelector('[name="email"]')?.value || ''}`.trim();
    try {
      await sendForgotPasswordEmail(email);
      setAuthMessage('Password reset email sent. Check your inbox.');
    } catch (error) {
      setAuthMessage(formatActionError(error, 'Unable to start password reset.'));
    }
  }

  function bindAuthUi() {
    loginForm?.addEventListener('submit', handleLoginSubmit);
    registerForm?.addEventListener('submit', handleRegisterSubmit);
    googleLoginBtn?.addEventListener('click', handleGoogleAuth);
    googleRegisterBtn?.addEventListener('click', handleGoogleAuth);
    forgotPasswordBtn?.addEventListener('click', handleForgotPassword);
    authInviteCodeInput?.addEventListener('input', () => syncPendingInviteCode(state, documentRef));
    registerPasswordInput?.addEventListener('input', syncRegisterPasswordHelp);
    registerConfirmInput?.addEventListener('input', syncRegisterPasswordHelp);
  }

  return {
    bindAuthUi,
    setAuthMessage
  };
}
