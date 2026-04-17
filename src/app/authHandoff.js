function isPermissionDenied(error) {
  const code = `${error?.code || ''}`.trim().toLowerCase();
  const message = `${error?.message || ''}`.trim().toLowerCase();
  return code.includes('permission-denied') || message.includes('missing or insufficient permissions');
}

export function canFallbackToOnboarding(error) {
  if (!isPermissionDenied(error)) return false;
  return `${error?.bootstrapStep || ''}`.trim() === 'membership_lookup';
}

export function buildOnboardingFallbackState(state = {}) {
  return {
    ...state,
    company: null,
    memberships: [],
    membershipCompanies: {},
    activeMembership: null,
    onboardingRequired: true
  };
}
