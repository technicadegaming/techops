const PENDING_ROLE = 'pending';
const COMPLETE_STATE = 'complete';
const NEEDS_COMPANY_SETUP_STATE = 'needs_company_setup';

function normalizeString(value = '') {
  return `${value || ''}`.trim();
}

function normalizeRole(value = '') {
  return normalizeString(value).toLowerCase();
}

function isActiveMembership(member = {}) {
  return normalizeRole(member.status || 'active') === 'active';
}

function isPendingRole(role = '') {
  return normalizeRole(role) === PENDING_ROLE;
}

function getCompanyMembersForCompany(state = {}, companyId = '') {
  return (state.companyMembers || []).filter((member) => normalizeString(member.companyId) === companyId);
}

function deriveCurrentUserMembership(state = {}, companyId = '') {
  const activeMembership = state.activeMembership || null;
  if (normalizeString(activeMembership?.companyId) === companyId) return activeMembership;
  return getCompanyMembersForCompany(state, companyId).find((member) => member.userId === state.user?.uid && isActiveMembership(member)) || null;
}

function deriveNormalizedCompanyRole({ state = {}, currentUserMembership = null, activeMembers = [] } = {}) {
  const membershipRole = normalizeRole(currentUserMembership?.role);
  if (membershipRole && !isPendingRole(membershipRole)) return membershipRole;

  const profileRole = normalizeRole(state.profile?.role);
  if (profileRole && !isPendingRole(profileRole)) return profileRole;

  if (normalizeString(state.company?.createdBy) === normalizeString(state.user?.uid)) return 'owner';

  const firstNonPendingRole = activeMembers
    .filter((member) => member.userId === state.user?.uid)
    .map((member) => normalizeRole(member.role))
    .find((role) => role && !isPendingRole(role));
  return firstNonPendingRole || membershipRole || profileRole || PENDING_ROLE;
}

export function getAuthoritativeOnboardingState(state = {}) {
  const company = state.company || null;
  const companyId = normalizeString(company?.id);
  const locations = (state.companyLocations || []).filter((location) => normalizeString(location.companyId || companyId) === companyId);
  const activeMembers = getCompanyMembersForCompany(state, companyId).filter((member) => isActiveMembership(member));
  const currentUserMembership = deriveCurrentUserMembership(state, companyId);
  const normalizedRole = deriveNormalizedCompanyRole({ state, currentUserMembership, activeMembers });
  const hasCompany = !!companyId;
  const hasLocation = locations.length > 0;
  const hasMembership = activeMembers.length > 0;
  const currentUserLinked = !!currentUserMembership && normalizeString(currentUserMembership.companyId) === companyId;
  const hasResolvedRole = !!normalizeRole(normalizedRole) && !isPendingRole(normalizedRole);
  const complete = hasCompany && hasLocation && hasMembership && currentUserLinked && hasResolvedRole;

  return {
    complete,
    status: complete ? COMPLETE_STATE : (hasCompany ? 'in_progress' : NEEDS_COMPANY_SETUP_STATE),
    badgeLabel: complete ? 'Complete' : 'Pending',
    normalizedRole,
    companyId,
    company,
    locations,
    activeMembers,
    currentUserMembership,
    checks: {
      hasCompany,
      hasLocation,
      hasMembership,
      currentUserLinked,
      hasResolvedRole
    },
    legacy: {
      userOnboardingState: normalizeString(state.profile?.onboardingState),
      userRole: normalizeRole(state.profile?.role),
      companyOnboardingCompleted: company?.onboardingCompleted === true,
      companyOnboardingState: normalizeString(company?.onboardingState)
    }
  };
}

export function buildOnboardingRepairPlan(state = {}) {
  const resolved = getAuthoritativeOnboardingState(state);
  if (!resolved.complete) return { resolved, needsRepair: false, userPatch: null, companyPatch: null, membershipPatch: null };

  const userPatch = {};
  if (resolved.legacy.userOnboardingState !== COMPLETE_STATE) userPatch.onboardingState = COMPLETE_STATE;
  if (!resolved.legacy.userRole || isPendingRole(resolved.legacy.userRole)) userPatch.role = resolved.normalizedRole;

  const companyPatch = {};
  if (!resolved.legacy.companyOnboardingCompleted) companyPatch.onboardingCompleted = true;
  if (resolved.legacy.companyOnboardingState !== COMPLETE_STATE) companyPatch.onboardingState = COMPLETE_STATE;
  if (!resolved.company?.onboardingCompletedAt) companyPatch.onboardingCompletedAt = new Date().toISOString();

  const membershipPatch = {};
  if (resolved.currentUserMembership?.id && isPendingRole(resolved.currentUserMembership?.role) && !isPendingRole(resolved.normalizedRole)) {
    membershipPatch.role = resolved.normalizedRole;
  }

  return {
    resolved,
    needsRepair: !!(Object.keys(userPatch).length || Object.keys(companyPatch).length || Object.keys(membershipPatch).length),
    userPatch: Object.keys(userPatch).length ? userPatch : null,
    companyPatch: Object.keys(companyPatch).length ? companyPatch : null,
    membershipPatch: Object.keys(membershipPatch).length ? membershipPatch : null
  };
}
