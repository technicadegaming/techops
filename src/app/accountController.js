import { renderAccount } from '../account.js';

export function createAccountController({
  state,
  render,
  resendVerificationEmail,
  refreshAuthUser,
  syncSecuritySnapshot,
  sendForgotPasswordEmail
}) {
  async function syncAccountSecurityProfile(user) {
    state.profile = await syncSecuritySnapshot(
      user || { uid: state.user?.uid, email: state.user?.email },
      state.profile || {}
    );
    return state.profile;
  }

  function createActions() {
    return {
      resendVerification: async () => {
        await resendVerificationEmail();
        const refreshed = await refreshAuthUser();
        await syncAccountSecurityProfile(refreshed);
        render();
      },
      refreshVerification: async () => {
        const refreshed = await refreshAuthUser();
        if (!refreshed) throw new Error('No authenticated user found.');
        await syncAccountSecurityProfile(refreshed);
        render();
      },
      sendPasswordReset: async () => {
        await sendForgotPasswordEmail(state.user?.email || '');
      }
    };
  }

  return {
    createActions,
    renderAccountSection(element) {
      renderAccount(element, state, createActions());
    }
  };
}
