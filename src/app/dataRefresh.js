import { countEntities, getAppSettings, listAudit, listEntities, setActiveCompanyContext } from '../data.js';
import { ensureBootstrapCompanyForLegacyUser, getCompany, listCompanyMembers, listMembershipsByUser } from '../company.js';
import { buildPermissionContext, isGlobalAdmin } from '../roles.js';
import { ACTIVE_MEMBERSHIP_STORAGE_KEY, syncSetupWizardState } from './state.js';

export function getStoredActiveMembershipId(userId) {
  if (!userId) return '';
  try { return localStorage.getItem(`${ACTIVE_MEMBERSHIP_STORAGE_KEY}:${userId}`) || ''; } catch { return ''; }
}

export function storeActiveMembershipId(userId, membershipId) {
  if (!userId) return;
  try {
    if (membershipId) localStorage.setItem(`${ACTIVE_MEMBERSHIP_STORAGE_KEY}:${userId}`, membershipId);
    else localStorage.removeItem(`${ACTIVE_MEMBERSHIP_STORAGE_KEY}:${userId}`);
  } catch {
    // Ignore local storage failures and keep in-memory fallback.
  }
}

export async function hydrateMembershipCompanies(state, memberships = state.memberships || []) {
  const companyEntries = await Promise.all((memberships || []).map(async (membership) => {
    const company = await getCompany(membership.companyId).catch(() => null);
    return [membership.id, company];
  }));
  state.membershipCompanies = Object.fromEntries(companyEntries);
}

function pickActiveMembership(state, memberships = state.memberships || []) {
  const currentMembershipId = `${state.activeMembership?.id || ''}`.trim();
  const storedMembershipId = getStoredActiveMembershipId(state.user?.uid);
  const list = Array.isArray(memberships) ? memberships : [];
  return list.find((membership) => membership.id === currentMembershipId)
    || list.find((membership) => membership.id === storedMembershipId)
    || (list.length === 1 ? list[0] : null)
    || list[0]
    || null;
}

async function ensureActiveCompanyHydrated(state, membership) {
  if (!membership?.companyId) return null;
  const cachedCompany = state.membershipCompanies?.[membership.id] || null;
  const existingCompanyMatchesMembership = `${state.company?.id || ''}`.trim() === `${membership.companyId || ''}`.trim();
  if (existingCompanyMatchesMembership && state.company) return state.company;
  if (cachedCompany) {
    state.company = cachedCompany;
    return cachedCompany;
  }

  const company = await getCompany(membership.companyId).catch((error) => {
    console.warn('[ensureActiveCompanyHydrated] Unable to load company document for active membership.', {
      membershipId: membership.id,
      companyId: membership.companyId,
      error
    });
    return null;
  });
  if (company) {
    state.membershipCompanies = { ...state.membershipCompanies, [membership.id]: company };
    state.company = company;
    return company;
  }
  return null;
}

export async function refreshData(state, options = {}) {
  state.tasks = await listEntities('tasks').catch(() => []);
  state.operations = await listEntities('operations').catch(() => []);
  state.assets = await listEntities('assets').catch(() => []);
  state.pmSchedules = await listEntities('pmSchedules').catch(() => []);
  state.manuals = await listEntities('manuals').catch(() => []);
  state.notes = await listEntities('notes').catch(() => []);
  state.users = await listEntities('users').catch(() => []);
  state.companyMembers = state.company?.id ? await listCompanyMembers(state.company.id).catch(() => []) : [];
  state.workers = await listEntities('workers').catch(() => []);
  state.invites = await listEntities('companyInvites').catch(() => []);
  state.companyLocations = await listEntities('companyLocations').catch(() => []);
  state.importHistory = await listEntities('importHistory').catch(() => []);
  state.settings = await getAppSettings().catch(() => ({}));
  state.auditLogs = await listAudit().catch(() => []);
  state.taskAiRuns = await listEntities('taskAiRuns').catch(() => []);
  state.taskAiFollowups = await listEntities('taskAiFollowups').catch(() => []);
  state.troubleshootingLibrary = await listEntities('troubleshootingLibrary').catch(() => []);
  state.notifications = await listEntities('notifications').catch(() => []);
  state.notificationPrefs = state.settings.notificationPrefs || { enabledTypes: [] };
  if (typeof options.syncNotifications === 'function') {
    await options.syncNotifications();
    state.notifications = await listEntities('notifications').catch(() => []);
  }
  syncSetupWizardState(state);
}

export async function setActiveMembership(state, nextMembership, options = {}) {
  const membershipId = typeof nextMembership === 'string' ? nextMembership : nextMembership?.id;
  const membership = (state.memberships || []).find((entry) => entry.id === membershipId)
    || (typeof nextMembership === 'object' ? nextMembership : null)
    || (state.memberships?.length === 1 ? state.memberships[0] : null);
  if (!membership) {
    state.activeMembership = null;
    state.company = null;
    state.permissions = buildPermissionContext({ profile: state.profile, membership: null });
    state.onboardingRequired = true;
    syncSetupWizardState(state);
    storeActiveMembershipId(state.user?.uid, '');
    setActiveCompanyContext(null);
    if (!options.skipRender && typeof options.render === 'function') options.render();
    return;
  }

  state.activeMembership = membership;
  state.permissions = buildPermissionContext({ profile: state.profile, membership });
  const company = await ensureActiveCompanyHydrated(state, membership);
  state.membershipCompanies = { ...state.membershipCompanies, [membership.id]: company };
  state.company = company || state.company || null;
  state.onboardingRequired = false;
  syncSetupWizardState(state);
  storeActiveMembershipId(state.user?.uid, membership.id);
  setActiveCompanyContext(company?.id || membership.companyId, { allowLegacy: isGlobalAdmin(state.permissions) });

  if (!company && membership.companyId) {
    console.info('[setActiveMembership] Active membership selected without hydrated company document; using membership companyId for scope.', {
      membershipId: membership.id,
      companyId: membership.companyId
    });
  }

  if (!options.skipRefresh && typeof options.refreshData === 'function') await options.refreshData();
  if (!options.skipRender && typeof options.render === 'function') options.render();
}

export async function bootstrapCompanyContext(state, options = {}) {
  setActiveCompanyContext(null);
  state.company = null;
  state.activeMembership = null;
  const memberships = await listMembershipsByUser(state.user.uid);
  state.memberships = memberships;
  const hasLegacyData = (await countEntities('assets').catch(() => 0)) + (await countEntities('tasks').catch(() => 0)) + (await countEntities('operations').catch(() => 0)) > 0;
  if (!memberships.length) {
    const adopted = await ensureBootstrapCompanyForLegacyUser(state.user, state.profile, hasLegacyData);
    if (adopted?.membership) state.memberships = [adopted.membership];
  }

  await hydrateMembershipCompanies(state, state.memberships);
  const activeMembership = pickActiveMembership(state, state.memberships);

  console.info('[bootstrapCompanyContext] Resolved membership bootstrap state.', {
    membershipCount: state.memberships.length,
    activeMembershipId: activeMembership?.id || 'none',
    activeMembershipCompanyId: activeMembership?.companyId || 'none',
    storedMembershipId: getStoredActiveMembershipId(state.user?.uid) || 'none'
  });

  await setActiveMembership(state, activeMembership, {
    ...options,
    skipRefresh: true,
    skipRender: true
  });
}
