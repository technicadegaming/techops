import { getAppSettings, listAudit, listEntities, setActiveCompanyContext } from '../data.js';
import { getCompany, listCompanyMembers, listMembershipsByUser } from '../company.js';
import { buildPermissionContext, isGlobalAdmin } from '../roles.js';
import { getWorkspaceReadiness } from '../features/workspaceReadiness.js';
import { ACTIVE_MEMBERSHIP_STORAGE_KEY } from './state.js';

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

export async function hydrateMembershipCompanies(state) {
  const membershipCompanies = {};
  for (const membership of state.memberships || []) {
    if (!membership?.companyId) continue;
    membershipCompanies[membership.companyId] = await getCompany(membership.companyId).catch(() => null);
  }
  state.membershipCompanies = membershipCompanies;
}

export async function refreshData(state) {
  state.tasks = await listEntities('tasks');
  state.operations = await listEntities('operations');
  state.assets = await listEntities('assets');
  state.pmSchedules = await listEntities('pmSchedules');
  state.manuals = await listEntities('manuals');
  state.notes = await listEntities('notes');
  state.users = await listEntities('users');
  state.workers = await listEntities('workers');
  state.invites = await listEntities('companyInvites');
  state.companyLocations = await listEntities('companyLocations');
  state.importHistory = await listEntities('importHistory');
  state.taskAiRuns = await listEntities('taskAiRuns');
  state.taskAiFollowups = await listEntities('taskAiFollowups');
  state.troubleshootingLibrary = await listEntities('troubleshootingLibrary');
  state.notifications = await listEntities('notifications');
  state.companyMembers = state.company?.id ? await listCompanyMembers(state.company.id) : [];
  state.auditLogs = await listAudit(200);
  state.settings = await getAppSettings();
  state.permissions = buildPermissionContext({ user: state.user, profile: state.profile, activeMembership: state.activeMembership, company: state.company });
  const readiness = getWorkspaceReadiness(state);
  const dismissed = !!state.settings?.workspaceReadinessDismissedAt;
  state.setupWizard = { ...(state.setupWizard || {}), active: !!state.company?.id && !state.onboardingRequired && readiness.needsSetupWizard && !dismissed, step: state.setupWizard?.step || 1 };
}

export async function setActiveMembership(state, membership) {
  state.activeMembership = membership || null;
  const companyId = `${state.activeMembership?.companyId || ''}`.trim();
  setActiveCompanyContext(companyId || null);
  state.company = companyId ? (await getCompany(companyId).catch(() => null)) : null;
  state.companyMembers = companyId ? await listCompanyMembers(companyId).catch(() => []) : [];
  state.permissions = buildPermissionContext({ user: state.user, profile: state.profile, activeMembership: state.activeMembership, company: state.company });
  storeActiveMembershipId(state.user?.uid, state.activeMembership?.id || '');
}

export function canBypassCompany(state) {
  return isGlobalAdmin(state.permissions);
}

export async function bootstrapCompanyContext(state) {
  state.memberships = await listMembershipsByUser(state.user.uid);
  await hydrateMembershipCompanies(state);
  const storedMembershipId = getStoredActiveMembershipId(state.user.uid);
  const activeMembership = state.memberships.find((m) => m.id === storedMembershipId) || state.memberships[0] || null;
  await setActiveMembership(state, activeMembership);
}
