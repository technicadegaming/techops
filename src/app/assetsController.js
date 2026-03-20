import { formatActionError } from '../uiActions.js';
import { createAssetActions } from '../features/assetActions.js';
import { buildPreviewQueryKey, createEmptyAssetDraft } from './state.js';

function isPermissionRelatedError(error) {
  const code = `${error?.code || ''}`.toLowerCase();
  const message = `${error?.message || error || ''}`.toLowerCase();
  return code.includes('permission-denied') || message.includes('permission') || message.includes('missing or insufficient permissions');
}

function getEnrichmentFailureState(error) {
  const blocked = isPermissionRelatedError(error);
  return {
    status: blocked ? 'permission_blocked' : 'lookup_failed',
    message: blocked
      ? 'Asset saved. Access blocked while checking manuals/support links.'
      : 'Asset saved. Lookup failed; retry when ready.'
  };
}

function normalizeAssetId(name = '') {
  const base = `${name}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'asset';
  return `asset-${base}`;
}

function pickUniqueAssetId(desiredId, assets) {
  const used = new Set((assets || []).map((asset) => asset.id));
  const clean = `${desiredId || ''}`.trim();
  if (clean && !used.has(clean)) return clean;
  const root = clean || normalizeAssetId(clean);
  if (!used.has(root)) return root;
  let i = 2;
  while (used.has(`${root}-${i}`)) i += 1;
  return `${root}-${i}`;
}

function dedupeUrls(values = []) {
  return [...new Set((values || []).map((value) => `${value || ''}`.trim()).filter(Boolean))];
}

function normalizeSupportEntries(values = []) {
  const mapped = (values || []).map((entry) => {
    if (typeof entry === 'string') return { url: entry.trim() };
    return { ...entry, url: `${entry?.url || ''}`.trim() };
  }).filter((entry) => entry.url);
  const seen = new Set();
  return mapped.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
}

async function withTimeout(promise, ms, timeoutMessage) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), ms);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function createAssetsController({
  state,
  navigationController,
  render,
  refreshData,
  runAction,
  withRequiredCompanyId,
  upsertEntity,
  deleteEntity,
  approveAssetManual,
  enrichAssetDocumentation,
  previewAssetDocumentationLookup,
  canDelete,
  isAdmin,
  isManager
}) {
  async function markAssetEnrichmentFailure(assetId, error, preserveFollowup = false) {
    const current = state.assets.find((entry) => entry.id === assetId) || {};
    const failure = getEnrichmentFailureState(error);
    await upsertEntity('assets', assetId, {
      ...current,
      enrichmentStatus: failure.status,
      enrichmentUpdatedAt: new Date().toISOString(),
      enrichmentFailedAt: new Date().toISOString(),
      enrichmentErrorCode: `${error?.code || ''}`.trim() || 'unknown',
      enrichmentErrorMessage: `${error?.message || error || ''}`.trim().slice(0, 240),
      enrichmentFollowupQuestion: preserveFollowup ? (current.enrichmentFollowupQuestion || '') : '',
      enrichmentFollowupAnswer: preserveFollowup ? (current.enrichmentFollowupAnswer || '') : ''
    }, state.user);
    return failure;
  }

  function buildAssetSaveErrorMessage(error) {
    if (!isPermissionRelatedError(error)) return formatActionError(error, 'Unable to save asset.');
    return 'Unable to save asset due to company permissions. Verify your company access and try again.';
  }

  function buildAssetSaveDebugContext() {
    return {
      companyId: `${state.company?.id || state.activeMembership?.companyId || ''}`.trim() || 'unknown',
      companyRole: state.permissions?.companyRole || 'unknown'
    };
  }

  return {
    createActions() {
      return createAssetActions({
        state,
        onLocationFilter: (locationKey) => {
          navigationController.showAssetsForLocation(locationKey);
          render();
        },
        render,
        refreshData,
        runAction,
        withRequiredCompanyId,
        upsertEntity,
        deleteEntity,
        approveAssetManual,
        enrichAssetDocumentation,
        previewAssetDocumentationLookup,
        markAssetEnrichmentFailure,
        normalizeAssetId,
        pickUniqueAssetId,
        createEmptyAssetDraft,
        withTimeout,
        dedupeUrls,
        normalizeSupportEntries,
        canDelete,
        isAdmin,
        isManager,
        buildAssetSaveErrorMessage,
        buildAssetSaveDebugContext,
        isPermissionRelatedError,
        buildPreviewQueryKey
      });
    }
  };
}
