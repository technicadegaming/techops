export const Roles = Object.freeze({
  ADMIN: 'admin',
  MANAGER: 'manager',
  ASSISTANT_MANAGER: 'assistant_manager',
  LEAD: 'lead',
  STAFF: 'staff'
});

export const isAdmin = (u) => u?.role === Roles.ADMIN;
export const isManager = (u) => [Roles.ADMIN, Roles.MANAGER].includes(u?.role);
export const isAssistantManager = (u) => [Roles.ADMIN, Roles.MANAGER, Roles.ASSISTANT_MANAGER].includes(u?.role);
export const isLead = (u) => [Roles.ADMIN, Roles.MANAGER, Roles.ASSISTANT_MANAGER, Roles.LEAD].includes(u?.role);
export const isStaff = (u) => [Roles.ADMIN, Roles.MANAGER, Roles.ASSISTANT_MANAGER, Roles.LEAD, Roles.STAFF].includes(u?.role);

export const canDelete = (u) => isManager(u);
export const canManageUsers = (u) => isAdmin(u);
export const canManageBackups = (u) => isAdmin(u);
export const canEditAssets = (u) => isLead(u);
export const canEditTasks = (u) => isLead(u);
export const canCloseTasks = (u) => isLead(u);
export const canChangeAISettings = (u) => isAdmin(u);
