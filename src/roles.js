export const Roles = Object.freeze({
  ADMIN: 'admin',
  MANAGER: 'manager',
  ASSISTANT_MANAGER: 'assistant_manager',
  LEAD: 'lead',
  STAFF: 'staff'
});

const roleFrom = (u) => u?.companyRole || u?.role || null;

export const buildPermissionContext = ({ profile = null, membership = null } = {}) => ({
  role: membership?.role || null,
  companyRole: membership?.role || null,
  globalRole: profile?.role || null,
  legacyBootstrapEligible: profile?.legacyBootstrapEligible === true
});

export const isGlobalAdmin = (u) => u?.globalRole === Roles.ADMIN;
export const isAdmin = (u) => ['owner', Roles.ADMIN].includes(roleFrom(u));
export const isManager = (u) => ['owner', Roles.ADMIN, Roles.MANAGER].includes(roleFrom(u));
export const isAssistantManager = (u) => ['owner', Roles.ADMIN, Roles.MANAGER, Roles.ASSISTANT_MANAGER].includes(roleFrom(u));
export const isLead = (u) => ['owner', Roles.ADMIN, Roles.MANAGER, Roles.ASSISTANT_MANAGER, Roles.LEAD].includes(roleFrom(u));
export const isStaff = (u) => ['owner', Roles.ADMIN, Roles.MANAGER, Roles.ASSISTANT_MANAGER, Roles.LEAD, Roles.STAFF].includes(roleFrom(u));

export const canDelete = (u) => isManager(u);
export const canManageUsers = (u) => isAdmin(u);
export const canManageBackups = (u) => isAdmin(u);
export const canEditAssets = (u) => isLead(u);
export const canEditTasks = (u) => isLead(u);
export const canCloseTasks = (u) => isLead(u);
export const canChangeAISettings = (u) => isManager(u);
export const canRunAiTroubleshooting = (u) => isLead(u);
export const canAnswerAiFollowups = (u) => isStaff(u);
export const canSaveFixToLibrary = (u) => isLead(u);
