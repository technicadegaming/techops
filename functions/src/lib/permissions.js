const ROLE_ORDER = ['staff', 'lead', 'assistant_manager', 'manager', 'admin'];

function hasRoleAtLeast(role, minimum) {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimum);
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
  hasRoleAtLeast,
  canRunManualAi,
  canAnswerFollowup,
  canRunAssetEnrichment,
  canSaveToTroubleshootingLibrary,
  canManageAiSettings
};
