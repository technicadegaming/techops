import { formatActionError } from '../uiActions.js';

export function reportActionError(label, error, fallbackMessage) {
  console.error(`[${label}]`, error);
  alert(formatActionError(error, fallbackMessage));
}

export function describeCompanyContext(state = {}) {
  const memberships = Array.isArray(state.memberships) ? state.memberships : [];
  const activeMembership = state.activeMembership || null;
  const fallbackMembership = memberships.length === 1 ? memberships[0] : memberships[0] || null;
  const resolvedMembership = activeMembership || fallbackMembership;
  const companyId = `${state.company?.id || resolvedMembership?.companyId || ''}`.trim();

  return {
    companyId,
    companyStateId: `${state.company?.id || ''}`.trim(),
    activeMembershipId: `${activeMembership?.id || ''}`.trim(),
    activeMembershipCompanyId: `${activeMembership?.companyId || ''}`.trim(),
    fallbackMembershipId: `${fallbackMembership?.id || ''}`.trim(),
    fallbackMembershipCompanyId: `${fallbackMembership?.companyId || ''}`.trim(),
    membershipCount: memberships.length
  };
}

export function requireActiveCompanyId(state, actionLabel = 'continue') {
  const context = describeCompanyContext(state);
  const companyId = `${context.companyId || ''}`.trim();
  if (!companyId) {
    console.warn('[requireActiveCompanyId] Missing company context.', {
      actionLabel,
      companyStateId: context.companyStateId || 'none',
      activeMembershipId: context.activeMembershipId || 'none',
      activeMembershipCompanyId: context.activeMembershipCompanyId || 'none',
      fallbackMembershipId: context.fallbackMembershipId || 'none',
      fallbackMembershipCompanyId: context.fallbackMembershipCompanyId || 'none',
      membershipCount: context.membershipCount
    });
    throw new Error(
      `No active company context is available. Complete onboarding before trying to ${actionLabel}. ` +
      `(company=${context.companyStateId || 'none'}, activeMembership=${context.activeMembershipId || 'none'}, ` +
      `activeMembershipCompany=${context.activeMembershipCompanyId || 'none'}, memberships=${context.membershipCount})`
    );
  }
  return companyId;
}

export function withRequiredCompanyId(state, payload = {}, actionLabel = 'continue') {
  return { ...payload, companyId: requireActiveCompanyId(state, actionLabel) };
}

export function createActionContext({ state, render, refreshData }) {
  return { state, render, refreshData };
}
