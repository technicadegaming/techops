const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { acquireManualToLibrary } = require('./manualAcquisitionService');
const { normalizeUrl } = require('./manualLibraryService');

function normalizeString(value = '', max = 500) {
  return `${value || ''}`.trim().slice(0, max);
}

async function bootstrapAttachManualFromCsvHint({
  db,
  storage,
  assetId = '',
  userId = '',
  manualHintUrl = '',
  manualSourceHintUrl = '',
  supportHintUrl = '',
  acquireManual = acquireManualToLibrary,
  now = () => admin.firestore.FieldValue.serverTimestamp(),
} = {}) {
  const normalizedAssetId = normalizeString(assetId, 180);
  if (!db || !storage || !normalizedAssetId) throw new HttpsError('invalid-argument', 'assetId is required');

  const directManualUrl = normalizeUrl(manualHintUrl);
  if (!directManualUrl) {
    return {
      ok: false,
      attached: false,
      status: 'skipped_missing_manual_hint',
      reason: 'manual_hint_missing_or_invalid',
    };
  }

  const assetRef = db.collection('assets').doc(normalizedAssetId);
  const assetSnap = await assetRef.get();
  if (!assetSnap.exists) throw new HttpsError('not-found', 'Asset not found');
  const asset = assetSnap.data() || {};

  const sourcePageUrl = normalizeUrl(manualSourceHintUrl) || normalizeUrl(supportHintUrl);

  let acquisition;
  try {
    acquisition = await acquireManual({
      db,
      storage,
      candidate: {
        url: directManualUrl,
        sourcePageUrl,
        title: `${asset.name || normalizedAssetId} CSV bootstrap manual hint`,
        sourceType: 'csv_bootstrap_manual',
        matchType: 'csv_bootstrap_direct_manual_hint',
      },
      context: {
        originalTitle: normalizeString(asset.originalTitle || asset.name || normalizedAssetId, 240),
        canonicalTitle: normalizeString(asset.name || normalizedAssetId, 240),
        familyTitle: normalizeString(asset.name || normalizedAssetId, 240),
        manufacturer: normalizeString(asset.manufacturer || '', 240),
        manualUrl: directManualUrl,
        manualSourceUrl: sourcePageUrl,
        sourceType: 'csv_bootstrap_manual',
        matchType: 'csv_bootstrap_direct_manual_hint',
      },
    });
  } catch (error) {
    return {
      ok: false,
      attached: false,
      status: 'bootstrap_attach_failed_fetch',
      reason: normalizeString(error?.message || 'bootstrap_attach_failed_fetch', 240),
    };
  }

  const library = acquisition?.manualLibrary || null;
  const manualStoragePath = normalizeString(library?.storagePath || acquisition?.manualUrl || '', 500);
  const manualLibraryRef = normalizeString(library?.id || '', 180);
  if (!acquisition?.manualReady || !manualStoragePath || !manualLibraryRef) {
    return {
      ok: false,
      attached: false,
      status: 'bootstrap_attach_failed_validation',
      reason: 'manual_not_durable_ready',
    };
  }

  const manualSourceUrl = normalizeUrl(acquisition?.manualSourceUrl || sourcePageUrl || '');
  const matchSummary = {
    status: 'docs_found',
    sourceType: 'csv_bootstrap_manual',
    matchType: 'csv_bootstrap_direct_manual_hint',
    manualReady: true,
    manualUrl: manualStoragePath,
    manualStoragePath,
    manualLibraryRef,
    manualSourceUrl,
    attachmentMode: 'csv_bootstrap',
    manualProvenance: 'csv_manual_hint_direct_attach',
    manualReviewState: 'manual_attached_bootstrap',
  };

  await assetRef.set({
    manualLibraryRef,
    manualStoragePath,
    manualUrl: manualStoragePath,
    manualSourceUrl,
    manualReady: true,
    manualStatus: 'manual_attached',
    enrichmentStatus: 'docs_found',
    enrichmentTerminalReason: 'csv_bootstrap_manual_attached',
    reviewState: 'pending_review',
    manualReviewState: 'manual_attached_bootstrap',
    matchType: 'csv_bootstrap_direct_manual_hint',
    sourceType: 'csv_bootstrap_manual',
    attachmentMode: 'csv_bootstrap',
    manualProvenance: 'csv_manual_hint_direct_attach',
    manualMatchSummary: {
      ...(asset.manualMatchSummary || {}),
      ...matchSummary,
    },
    documentationSuggestions: [{
      title: 'CSV bootstrap attached manual',
      url: manualStoragePath,
      sourcePageUrl: manualSourceUrl,
      sourceType: 'csv_bootstrap_manual',
      matchType: 'csv_bootstrap_direct_manual_hint',
      manualLibraryRef,
      manualStoragePath,
      verified: false,
      trustedSource: false,
      attachmentMode: 'csv_bootstrap',
      manualProvenance: 'csv_manual_hint_direct_attach',
    }],
    updatedAt: now(),
    updatedBy: normalizeString(userId, 120),
    csvBootstrapManualAttach: {
      attachedAt: now(),
      attachedBy: normalizeString(userId, 120),
      manualHintUrl: directManualUrl,
      manualSourceHintUrl: sourcePageUrl,
      attachmentMode: 'csv_bootstrap',
      manualProvenance: 'csv_manual_hint_direct_attach',
    },
  }, { merge: true });

  return {
    ok: true,
    attached: true,
    status: 'docs_found',
    manualLibraryRef,
    manualStoragePath,
    manualUrl: manualStoragePath,
    manualSourceUrl,
  };
}

module.exports = {
  bootstrapAttachManualFromCsvHint,
};
