import { formatActionError } from '../uiActions.js';

export function reportActionError(label, error, fallbackMessage) {
  console.error(`[${label}]`, error);
  alert(formatActionError(error, fallbackMessage));
}

export function requireActiveCompanyId(state, actionLabel = 'continue') {
  const companyId = `${state.company?.id || state.activeMembership?.companyId || state.memberships?.[0]?.companyId || ''}`.trim();
  if (!companyId) {
    throw new Error(`No active company context is available. Complete onboarding before trying to ${actionLabel}.`);
  }
  return companyId;
}

export function withRequiredCompanyId(state, payload = {}, actionLabel = 'continue') {
  return { ...payload, companyId: requireActiveCompanyId(state, actionLabel) };
}

export function createActionContext({ state, render, refreshData }) {
  return { state, render, refreshData };
}
