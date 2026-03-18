import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { functions } from './firebase.js';
import { getActiveCompanyContext } from './companyScope.js';

function withCompanyScope(payload = {}) {
  const scope = getActiveCompanyContext();
  const companyId = `${scope?.companyId || ''}`.trim();
  return companyId ? { ...payload, companyId } : payload;
}

const call = (name, payload) => httpsCallable(functions, name)(withCompanyScope(payload)).then((r) => r.data);

export function analyzeTaskTroubleshooting(taskId) {
  return call('analyzeTaskTroubleshooting', { taskId });
}

export function answerTaskFollowup(taskId, runId, answers) {
  return call('answerTaskFollowup', { taskId, runId, answers });
}

export function regenerateTaskTroubleshooting(taskId) {
  return call('regenerateTaskTroubleshooting', { taskId });
}

export function fetchWebContextForTask(taskId) {
  return call('fetchWebContextForTask', { taskId });
}

export function saveTaskFixToTroubleshootingLibrary(payload) {
  return call('saveTaskFixToTroubleshootingLibrary', payload);
}

export function enrichAssetDocumentation(assetId, options = {}) {
  return call('enrichAssetDocumentation', { assetId, ...options });
}

export function previewAssetDocumentationLookup(payload) {
  return call('previewAssetDocumentationLookup', payload);
}

export function approveAssetManual(payload) {
  return call('approveAssetManual', payload);
}
