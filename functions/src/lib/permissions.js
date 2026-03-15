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

function canRunManualAi(role) {
  return hasRoleAtLeast(role, 'lead');
}

function canAnswerFollowup(role) {
  return hasRoleAtLeast(role, 'staff');
}


function canRunAssetEnrichment(role) {
  return hasRoleAtLeast(role, 'staff');
}

function canSaveToTroubleshootingLibrary(role) {
  return hasRoleAtLeast(role, 'lead');
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
