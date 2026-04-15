import { formatActionError } from '../uiActions.js';

export function isPermissionRelatedError(error) {
  const code = `${error?.code || ''}`.toLowerCase();
  const message = `${error?.message || error || ''}`.toLowerCase();
  return code.includes('permission-denied') || message.includes('permission') || message.includes('missing or insufficient permissions');
}

function describeBootstrapStep(error) {
  const step = `${error?.bootstrapStep || ''}`.trim();
  if (!step) return 'workspace bootstrap checks';
  return step.replaceAll('_', ' ');
}

export function buildBootstrapErrorMessage(error) {
  if (!isPermissionRelatedError(error)) return formatActionError(error, 'Unable to finish account setup.');
  const blockedStep = describeBootstrapStep(error);
  return `Unable to finish account setup because ${blockedStep} was blocked by Firestore permissions. Your account was created, but workspace bootstrap could not complete. Please retry in a moment or contact support if it keeps happening.`;
}
