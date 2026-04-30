const companyScopedCollections = new Set([
  'assets', 'tasks', 'operations', 'manuals', 'pmSchedules', 'notes', 'auditLogs',
  'taskAiRuns', 'taskAiFollowups', 'troubleshootingLibrary', 'appSettings', 'workers', 'importHistory', 'companyLocations', 'companyInvites', 'notifications', 'checklistTemplates', 'checklistSignoffEvents', 'quizQuestions', 'quizSubmissions', 'quizAttemptEvents'
]);

const companyScopeState = {
  companyId: null,
  allowLegacy: false
};

export function isCompanyScopedCollection(name) {
  return companyScopedCollections.has(name);
}

export function setActiveCompanyContext(companyId, options = {}) {
  companyScopeState.companyId = companyId || null;
  companyScopeState.allowLegacy = !!options.allowLegacy;
}

export function getActiveCompanyContext() {
  return { ...companyScopeState };
}

export function buildCompanyScopedPayload(name, payload = {}) {
  if (!isCompanyScopedCollection(name)) return payload;
  const explicitCompanyId = payload.companyId || null;
  const activeCompanyId = companyScopeState.companyId || null;
  if (!explicitCompanyId && !activeCompanyId) return payload;
  return { ...payload, companyId: explicitCompanyId || activeCompanyId };
}

export function includeRecordForActiveCompany(name, entity = {}) {
  if (!companyScopeState.companyId || !isCompanyScopedCollection(name)) return true;
  const itemCompanyId = entity.companyId || null;
  if (itemCompanyId === companyScopeState.companyId) return true;
  if (!itemCompanyId && companyScopeState.allowLegacy) return true;
  return false;
}
