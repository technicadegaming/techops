import { persistAppearancePreference } from './theme.js';
import { renderAccount } from '../account.js';

export function createAccountController({
  state,
  render,
  resendVerificationEmail,
  refreshAuthUser,
  syncSecuritySnapshot,
  sendForgotPasswordEmail,
  persistAppearancePreference: persistAppearanceState,
  withGlobalBusy
}) {
  const safeWithGlobalBusy = typeof withGlobalBusy === 'function' ? withGlobalBusy : async (_t,_d,fn) => fn();

  async function syncAccountSecurityProfile(user) {
    state.profile = await syncSecuritySnapshot(
      user || { uid: state.user?.uid, email: state.user?.email },
      state.profile || {}
    );
    return state.profile;
  }

  function createActions() {
    return {
      resendVerification: async () => safeWithGlobalBusy('Saving changes…', 'This can take a few seconds. Please do not refresh.', async () => {
        await resendVerificationEmail();
        const refreshed = await refreshAuthUser();
        await syncAccountSecurityProfile(refreshed);
        render();
      }),
      refreshVerification: async () => safeWithGlobalBusy('Saving changes…', 'This can take a few seconds. Please do not refresh.', async () => {
        const refreshed = await refreshAuthUser();
        if (!refreshed) throw new Error('No authenticated user found.');
        await syncAccountSecurityProfile(refreshed);
        render();
      }),
      sendPasswordReset: async () => {
        await sendForgotPasswordEmail(state.user?.email || '');
      },
      updateAppearance: (next) => {
        state.ui = { ...(state.ui || {}), appearance: next };
        if (typeof persistAppearanceState === 'function') persistAppearanceState(next);
        persistAppearancePreference(next);
        render();
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
