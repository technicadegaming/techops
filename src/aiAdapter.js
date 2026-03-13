import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { functions } from './firebase.js';

const call = (name, payload) => httpsCallable(functions, name)(payload).then((r) => r.data);

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
