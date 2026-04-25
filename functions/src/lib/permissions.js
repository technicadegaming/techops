const ROLE_ORDER = ['staff', 'lead', 'assistant_manager', 'manager', 'admin'];

function normalizeRole(role) {
  const normalized = `${role || ''}`.trim().toLowerCase();
  if (normalized === 'owner') return 'admin';
  return normalized;
}

function hasRoleAtLeast(role, minimum) {
  const normalizedRole = normalizeRole(role);
  const normalizedMinimum = normalizeRole(minimum);
  const roleIndex = ROLE_ORDER.indexOf(normalizedRole);
  const minimumIndex = ROLE_ORDER.indexOf(normalizedMinimum);
  if (minimumIndex < 0) return false;
  if (roleIndex < 0) return false;
  return roleIndex >= minimumIndex;
}

function canRunManualAi(role, settings = {}) {
  if (hasRoleAtLeast(role, 'lead')) return true;
  return normalizeRole(role) === 'staff' && settings.aiAllowStaffManualRerun === true;
}

function canAnswerFollowup(role) {
  return hasRoleAtLeast(role, 'staff');
}

// Asset enrichment aligns with company membership policy in enrichmentAuthorization:
// owner/admin/manager only for company-scoped assets, owner/admin globally.
function canRunAssetEnrichment(role) {
  return hasRoleAtLeast(role, 'manager');
}

function canSaveToTroubleshootingLibrary(role, settings = {}) {
  if (hasRoleAtLeast(role, 'lead')) return true;
  return normalizeRole(role) === 'staff' && settings.aiAllowStaffSaveFixesToLibrary === true;
}

function canManageAiSettings(role) {
  return hasRoleAtLeast(role, 'manager');
}

module.exports = {
  normalizeRole,
  hasRoleAtLeast,
  canRunManualAi,
  canAnswerFollowup,
  canRunAssetEnrichment,
  canSaveToTroubleshootingLibrary,
  canManageAiSettings
};
