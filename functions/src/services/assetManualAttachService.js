const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { downloadManualCandidate, getExtension } = require('./manualAcquisitionService');
const { normalizeUrl } = require('./manualLibraryService');
const { createAssetManualId, materializeStoredAssetManual } = require('./manualIngestionService');

function normalizeString(value = '', max = 500) {
  return `${value || ''}`.trim().slice(0, max);
}

function uniqueList(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => `${value || ''}`.trim()).filter(Boolean)));
}

function isExtractableTextLike({ contentType = '', extension = '' } = {}) {
  const lowerType = `${contentType || ''}`.toLowerCase();
  const lowerExt = `${extension || ''}`.toLowerCase();
  return lowerType.startsWith('text/plain')
    || lowerType.startsWith('text/html')
    || ['txt', 'html', 'htm'].includes(lowerExt);
}

function isAllowedManualUpload({ contentType = '', extension = '' } = {}) {
  const lowerType = `${contentType || ''}`.toLowerCase();
  const lowerExt = `${extension || ''}`.toLowerCase();
  if (['pdf', 'doc', 'docx', 'txt', 'html', 'htm'].includes(lowerExt)) return true;
  return lowerType.includes('pdf')
    || lowerType.includes('msword')
    || lowerType.includes('officedocument')
    || lowerType.startsWith('text/plain')
    || lowerType.startsWith('text/html');
}

function getWarningForMaterialization(result = {}) {
  const status = `${result?.extractionStatus || ''}`.trim();
  if (status === 'unsupported_file_type') return 'Manual attached, but this file type is not text-extractable yet.';
  if (status === 'no_text_extracted') return 'Manual attached, but no readable text was extracted.';
  if (status && status !== 'completed') return `Manual attached with extraction status: ${status}.`;
  return '';
}

function buildAssetManualPatch({
  asset,
  userId = '',
  storagePath = '',
  manualUrl = '',
  sourceTitle = '',
  sourcePageUrl = '',
  sourceType = 'manual_url_attach',
  manualProvenance = 'user_manual_attach',
  materialized = {},
} = {}) {
  const existingLinks = Array.isArray(asset?.manualLinks) ? asset.manualLinks : [];
  const manualLinks = uniqueList([...existingLinks, storagePath, manualUrl, sourcePageUrl]);
  const chunkCount = Number(materialized?.chunkCount || 0) || 0;
  const normalizedSourceType = normalizeString(sourceType, 120) || 'manual_url_attach';
  const nextManualUrl = normalizedSourceType === 'manual_url_attach'
    ? (manualUrl || storagePath)
    : storagePath;
  return {
    manualStoragePath: storagePath,
    manualUrl: nextManualUrl,
    manualSourceUrl: sourcePageUrl || normalizeString(asset?.manualSourceUrl || '', 2000),
    manualLinks,
    manualStatus: 'manual_attached',
    enrichmentStatus: chunkCount > 0 ? 'verified_manual_found' : 'docs_found',
    enrichmentTerminalReason: 'user_manual_attached',
    manualReviewState: 'manual_attached_user',
    sourceType: normalizedSourceType,
    manualProvenance: normalizeString(manualProvenance, 120) || 'user_manual_attach',
    latestManualId: materialized.manualId || '',
    manualTextExtractionStatus: materialized.extractionStatus || 'failed',
    manualChunkCount: chunkCount,
    documentationTextAvailable: chunkCount > 0,
    selectedCandidateManualUrl: '',
    selectedCandidateUrl: '',
    selectedCandidateTitle: '',
    candidateRejectionReasons: [],
    manualMatchSummary: {
      ...(asset?.manualMatchSummary || {}),
      manualReady: true,
      status: chunkCount > 0 ? 'verified_manual_found' : 'docs_found',
      manualStoragePath: storagePath,
      manualUrl: nextManualUrl,
      manualSourceUrl: sourcePageUrl || normalizeString(asset?.manualSourceUrl || '', 2000),
    },
    sourceTitle: sourceTitle || normalizeString(asset?.sourceTitle || '', 200),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: normalizeString(userId, 180),
  };
}

function buildAttachResult({ assetId = '', storagePath = '', materialized = {} } = {}) {
  const warning = getWarningForMaterialization(materialized);
  return {
    ok: true,
    attached: true,
    assetId,
    manualId: materialized.manualId || '',
    storagePath,
    extractionStatus: materialized.extractionStatus || 'failed',
    extractionReason: materialized.extractionReason || '',
    chunkCount: Number(materialized.chunkCount || 0) || 0,
    documentationTextAvailable: Number(materialized.chunkCount || 0) > 0,
    warning,
  };
}

function validateStoragePathForAsset({ companyId = '', assetId = '', storagePath = '' } = {}) {
  const normalized = normalizeString(storagePath, 600);
  const expectedManualPrefix = `companies/${companyId}/manuals/${assetId}/`;
  const expectedBootstrapPrefix = `companies/${companyId}/asset-manual-bootstrap/${assetId}/`;
  const valid = normalized.startsWith(expectedManualPrefix) || normalized.startsWith(expectedBootstrapPrefix);
  return { valid, normalized };
}

async function attachAssetManualFromUrl({
  db,
  storage,
  asset,
  userId = '',
  manualUrl = '',
  sourceTitle = '',
  sourcePageUrl = '',
  fetchImpl = fetch,
} = {}) {
  const assetId = normalizeString(asset?.id, 180);
  const companyId = normalizeString(asset?.companyId, 180);
  const normalizedUrl = normalizeUrl(manualUrl);
  if (!db || !storage || !assetId || !companyId || !normalizedUrl) throw new HttpsError('invalid-argument', 'Missing required inputs for manual attachment.');

  const download = await downloadManualCandidate(normalizedUrl, fetchImpl);
  const extension = `${download?.extension || getExtension(download?.resolvedDownloadUrl || normalizedUrl, download?.contentType || '') || ''}`.toLowerCase();
  if (!isAllowedManualUpload({ contentType: download?.contentType, extension })) {
    throw new HttpsError('failed-precondition', 'Manual URL must point to a supported document type.');
  }

  const manualId = createAssetManualId({
    companyId,
    assetId,
    sourceUrl: normalizedUrl,
  });
  const targetPath = `companies/${companyId}/manuals/${assetId}/${manualId}/source.${extension || 'bin'}`;
  await storage.bucket().file(targetPath).save(download.buffer, {
    resumable: false,
    contentType: download.contentType || 'application/octet-stream',
    metadata: {
      metadata: {
        companyId,
        assetId,
        sourceUrl: normalizedUrl,
        sourcePageUrl: normalizeUrl(sourcePageUrl),
        attachmentMode: 'manual_url_attach',
        manualProvenance: 'user_manual_url_attach',
      }
    }
  });

  const materialized = await materializeStoredAssetManual({
    db,
    storage,
    asset,
    userId,
    storagePath: targetPath,
    sourceUrl: normalizedUrl,
    sourceTitle: normalizeString(sourceTitle || asset?.name || 'Attached manual', 200),
    sourceType: 'manual_url_attach',
    manualType: 'asset_manual_url_attach',
    contentType: download.contentType || '',
    attachmentMode: 'manual_url_attach',
    manualProvenance: 'user_manual_url_attach',
  });

  const patch = buildAssetManualPatch({
    asset,
    userId,
    storagePath: targetPath,
    manualUrl: normalizedUrl,
    sourceTitle,
    sourcePageUrl: normalizeUrl(sourcePageUrl),
    sourceType: 'manual_url_attach',
    manualProvenance: 'user_manual_attach',
    materialized,
  });
  await db.collection('assets').doc(assetId).set(patch, { merge: true });
  return buildAttachResult({ assetId, storagePath: targetPath, materialized });
}

async function attachAssetManualFromStoragePath({
  db,
  storage,
  asset,
  userId = '',
  storagePath = '',
  sourceTitle = '',
  originalFileName = '',
  contentType = '',
} = {}) {
  const assetId = normalizeString(asset?.id, 180);
  const companyId = normalizeString(asset?.companyId, 180);
  if (!db || !storage || !assetId || !companyId) throw new HttpsError('invalid-argument', 'Missing required inputs for manual attachment.');

  const pathValidation = validateStoragePathForAsset({ companyId, assetId, storagePath });
  if (!pathValidation.valid) {
    throw new HttpsError('permission-denied', 'Storage path is outside the allowed company/asset manual scope.');
  }

  const extension = `${getExtension(pathValidation.normalized, contentType) || ''}`.toLowerCase();
  if (!isAllowedManualUpload({ contentType, extension })) {
    throw new HttpsError('failed-precondition', 'Uploaded manual must be a supported document type.');
  }

  const materialized = await materializeStoredAssetManual({
    db,
    storage,
    asset,
    userId,
    storagePath: pathValidation.normalized,
    sourceUrl: pathValidation.normalized,
    sourceTitle: normalizeString(sourceTitle || originalFileName || asset?.name || 'Uploaded manual', 200),
    sourceType: 'manual_file_upload_attach',
    manualType: 'asset_manual_file_attach',
    contentType: normalizeString(contentType, 200),
    attachmentMode: 'manual_file_attach',
    manualProvenance: 'user_manual_file_attach',
  });

  const patch = buildAssetManualPatch({
    asset,
    userId,
    storagePath: pathValidation.normalized,
    manualUrl: pathValidation.normalized,
    sourceTitle,
    sourcePageUrl: '',
    sourceType: 'manual_file_upload_attach',
    manualProvenance: 'user_manual_attach',
    materialized,
  });
  await db.collection('assets').doc(assetId).set(patch, { merge: true });
  return buildAttachResult({ assetId, storagePath: pathValidation.normalized, materialized });
}

module.exports = {
  attachAssetManualFromUrl,
  attachAssetManualFromStoragePath,
  validateStoragePathForAsset,
  isExtractableTextLike,
};
