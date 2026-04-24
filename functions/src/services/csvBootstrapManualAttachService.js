const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { createHash } = require('node:crypto');
const { downloadManualCandidate, isDocumentLike } = require('./manualAcquisitionService');
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
  fetchImpl = fetch,
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

  const companyId = normalizeString(asset.companyId || '', 180);
  if (!companyId) {
    return {
      ok: false,
      attached: false,
      status: 'bootstrap_attach_failed_company_scope',
      reason: 'asset_missing_company_id',
    };
  }

  let download;
  try {
    download = await downloadManualCandidate(directManualUrl, fetchImpl);
  } catch (error) {
    return {
      ok: false,
      attached: false,
      status: 'bootstrap_attach_failed_fetch',
      reason: normalizeString(error?.message || 'bootstrap_attach_failed_fetch', 240),
    };
  }

  const acceptableExtension = ['pdf', 'doc', 'docx'].includes(`${download?.extension || ''}`.toLowerCase());
  const manualLikeFile = isDocumentLike(download);
  if (!download || !acceptableExtension || !manualLikeFile) {
    return {
      ok: false,
      attached: false,
      status: 'bootstrap_attach_failed_validation',
      reason: 'manual_not_document_like',
    };
  }

  const sourcePageUrl = normalizeUrl(manualSourceHintUrl) || normalizeUrl(supportHintUrl);
  const sha256 = createHash('sha256').update(download.buffer).digest('hex');
  const filename = `${Date.now()}-${sha256.slice(0, 12)}.${download.extension}`;
  const manualStoragePath = normalizeString(`companies/${companyId}/asset-manual-bootstrap/${normalizedAssetId}/${filename}`, 500);
  await storage.bucket().file(manualStoragePath).save(download.buffer, {
    resumable: false,
    contentType: download.contentType,
    metadata: {
      metadata: {
        companyId,
        assetId: normalizedAssetId,
        sourceUrl: directManualUrl,
        sourcePageUrl,
        attachmentMode: 'csv_direct_bootstrap',
        manualProvenance: 'csv_direct_manual_import',
      }
    }
  });

  const manualSourceUrl = normalizeUrl(download?.resolvedDownloadUrl || sourcePageUrl || directManualUrl);
  const matchSummary = {
    status: 'docs_found',
    sourceType: 'csv_direct_bootstrap_manual',
    matchType: 'csv_direct_bootstrap_manual_hint',
    manualReady: true,
    manualUrl: manualStoragePath,
    manualStoragePath,
    manualSourceUrl,
    attachmentMode: 'csv_direct_bootstrap',
    manualProvenance: 'csv_direct_manual_import',
    manualReviewState: 'manual_attached_bootstrap',
  };

  await assetRef.set({
    manualLibraryRef: '',
    manualStoragePath,
    manualUrl: manualStoragePath,
    manualSourceUrl,
    manualReady: true,
    manualStatus: 'manual_attached',
    enrichmentStatus: 'docs_found',
    enrichmentTerminalReason: 'csv_bootstrap_manual_attached',
    reviewState: 'pending_review',
    manualReviewState: 'manual_attached_bootstrap',
    matchType: 'csv_direct_bootstrap_manual_hint',
    sourceType: 'csv_direct_bootstrap_manual',
    attachmentMode: 'csv_direct_bootstrap',
    manualProvenance: 'csv_direct_manual_import',
    manualMatchSummary: {
      ...(asset.manualMatchSummary || {}),
      ...matchSummary,
    },
    documentationSuggestions: [{
      title: 'CSV bootstrap attached manual',
      url: manualStoragePath,
      sourcePageUrl: manualSourceUrl,
      sourceType: 'csv_direct_bootstrap_manual',
      matchType: 'csv_direct_bootstrap_manual_hint',
      manualLibraryRef: '',
      manualStoragePath,
      verified: false,
      trustedSource: false,
      attachmentMode: 'csv_direct_bootstrap',
      manualProvenance: 'csv_direct_manual_import',
    }],
    updatedAt: now(),
    updatedBy: normalizeString(userId, 120),
    csvBootstrapManualAttach: {
      attachedAt: now(),
      attachedBy: normalizeString(userId, 120),
      manualHintUrl: directManualUrl,
      manualSourceHintUrl: sourcePageUrl,
      resolvedManualUrl: normalizeUrl(download?.resolvedDownloadUrl || ''),
      manualStoragePath,
      attachmentMode: 'csv_direct_bootstrap',
      manualProvenance: 'csv_direct_manual_import',
    },
  }, { merge: true });

  return {
    ok: true,
    attached: true,
    status: 'docs_found',
    manualLibraryRef: '',
    manualStoragePath,
    manualUrl: manualStoragePath,
    manualSourceUrl,
  };
}

module.exports = {
  bootstrapAttachManualFromCsvHint,
};
