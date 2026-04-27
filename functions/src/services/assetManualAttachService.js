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

function normalizeManualAttachFailureCode(code = '') {
  const allowed = new Set([
    'download_timeout',
    'download_failed',
    'unsupported_file_type',
    'no_text_extracted',
    'extraction_failed',
    'storage_write_failed',
    'asset_not_found',
    'permission_company_mismatch',
  ]);
  const normalized = `${code || ''}`.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : 'extraction_failed';
}

function classifyManualAttachError(error) {
  const message = `${error?.message || ''}`.toLowerCase();
  const code = `${error?.code || ''}`.toLowerCase();
  if (message.includes('timeout') || code === 'deadline-exceeded') return 'download_timeout';
  if (message.includes('fetch') || message.includes('download') || message.includes('http')) return 'download_failed';
  if (message.includes('supported document type') || message.includes('supported file type')) return 'unsupported_file_type';
  if (message.includes('no text') || message.includes('no readable text')) return 'no_text_extracted';
  if (message.includes('outside the allowed company/asset manual scope')) return 'permission_company_mismatch';
  if (message.includes('not found')) return 'asset_not_found';
  if (message.includes('storage') || message.includes('bucket') || message.includes('save')) return 'storage_write_failed';
  return 'extraction_failed';
}

async function queueManualAttachJob({
  db,
  asset,
  userId = '',
  mode = 'url_attach',
  manualUrl = '',
  storagePath = '',
  sourceTitle = '',
  sourcePageUrl = '',
  originalFileName = '',
  contentType = '',
} = {}) {
  const assetId = normalizeString(asset?.id, 180);
  const companyId = normalizeString(asset?.companyId, 180);
  const assetDocId = normalizeString(asset?.firestoreDocId || asset?.docId || asset?.id, 180);
  if (!db || !assetId || !assetDocId || !companyId) {
    throw new HttpsError('invalid-argument', 'Missing required inputs for manual attachment.');
  }

  const normalizedMode = mode === 'storage_attach' ? 'storage_attach' : 'url_attach';
  const normalizedManualUrl = normalizeUrl(manualUrl);
  const normalizedStoragePath = normalizeString(storagePath, 600);
  if (normalizedMode === 'url_attach' && !normalizedManualUrl) {
    throw new HttpsError('invalid-argument', 'Manual URL is required for manual attachment.');
  }
  if (normalizedMode === 'storage_attach' && !normalizedStoragePath) {
    throw new HttpsError('invalid-argument', 'Manual file upload did not produce a storage path.');
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const jobRef = db.collection('manualAttachJobs').doc();
  const jobId = jobRef.id;
  await jobRef.set({
    id: jobId,
    companyId,
    assetId,
    assetDocId,
    manualUrl: normalizedManualUrl,
    storagePath: normalizedStoragePath,
    sourceTitle: normalizeString(sourceTitle, 200),
    sourcePageUrl: normalizeUrl(sourcePageUrl),
    originalFileName: normalizeString(originalFileName, 300),
    contentType: normalizeString(contentType, 200),
    requestedBy: normalizeString(userId, 180),
    mode: normalizedMode,
    status: 'queued',
    errorCode: '',
    errorMessage: '',
    createdAt: now,
    updatedAt: now,
  });

  await db.collection('assets').doc(assetDocId).set({
    manualAttachStatus: 'queued',
    manualAttachJobId: jobId,
    manualAttachRequestedAt: now,
    manualAttachError: '',
    updatedAt: now,
    updatedBy: normalizeString(userId, 180),
  }, { merge: true });

  return {
    ok: true,
    queued: true,
    jobId,
    assetId,
    message: 'Manual attachment queued.',
  };
}

async function processManualAttachJob({
  db,
  storage,
  job = {},
  fetchImpl = fetch,
} = {}) {
  const jobId = normalizeString(job?.id, 180);
  const assetDocId = normalizeString(job?.assetDocId || job?.assetId, 180);
  const companyId = normalizeString(job?.companyId, 180);
  if (!db || !storage || !jobId || !assetDocId || !companyId) return { ok: false, skipped: true };

  const jobRef = db.collection('manualAttachJobs').doc(jobId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const assetSnap = await db.collection('assets').doc(assetDocId).get();
  if (!assetSnap.exists) {
    await jobRef.set({ status: 'failed', errorCode: 'asset_not_found', errorMessage: 'Asset not found.', updatedAt: now }, { merge: true });
    return { ok: false, code: 'asset_not_found' };
  }

  const asset = { id: assetSnap.id, firestoreDocId: assetSnap.id, ...(assetSnap.data() || {}) };
  const assetCompanyId = normalizeString(asset?.companyId, 180);
  if (!assetCompanyId || assetCompanyId !== companyId) {
    await db.collection('assets').doc(assetDocId).set({
      manualAttachStatus: 'failed',
      manualAttachError: 'permission/company_mismatch',
      manualAttachUpdatedAt: now,
    }, { merge: true });
    await jobRef.set({ status: 'failed', errorCode: 'permission_company_mismatch', errorMessage: 'Asset/company mismatch.', updatedAt: now }, { merge: true });
    return { ok: false, code: 'permission_company_mismatch' };
  }

  await jobRef.set({ status: 'running', startedAt: now, updatedAt: now }, { merge: true });
  await db.collection('assets').doc(assetDocId).set({
    manualAttachStatus: 'running',
    manualAttachError: '',
    manualAttachUpdatedAt: now,
  }, { merge: true });

  try {
    let attachResult = null;
    if (job.mode === 'storage_attach') {
      const pathValidation = validateStoragePathForAsset({ companyId, assetId: assetDocId, storagePath: job.storagePath });
      if (!pathValidation.valid) {
        throw new HttpsError('permission-denied', 'Storage path is outside the allowed company/asset manual scope.');
      }
      const extension = `${getExtension(pathValidation.normalized, job.contentType) || ''}`.toLowerCase();
      if (!isAllowedManualUpload({ contentType: job.contentType, extension })) {
        throw new HttpsError('failed-precondition', 'Uploaded manual must be a supported document type.');
      }

      const materialized = await materializeStoredAssetManual({
        db,
        storage,
        asset: { ...asset, id: assetDocId, firestoreDocId: assetDocId },
        userId: job.requestedBy || 'system',
        storagePath: pathValidation.normalized,
        sourceUrl: pathValidation.normalized,
        sourceTitle: normalizeString(job.sourceTitle || job.originalFileName || asset?.name || 'Uploaded manual', 200),
        sourceType: 'manual_file_upload_attach',
        manualType: 'asset_manual_file_attach',
        contentType: normalizeString(job.contentType, 200),
        attachmentMode: 'manual_file_attach',
        manualProvenance: 'user_manual_file_attach',
      });

      const patch = buildAssetManualPatch({
        asset,
        userId: job.requestedBy || 'system',
        storagePath: pathValidation.normalized,
        manualUrl: pathValidation.normalized,
        sourceTitle: job.sourceTitle,
        sourceType: 'manual_file_upload_attach',
        manualProvenance: 'user_manual_attach',
        materialized,
      });
      attachResult = buildAttachResult({ assetId: assetDocId, storagePath: pathValidation.normalized, materialized });
      await db.collection('assets').doc(assetDocId).set({
        ...patch,
        manualAttachStatus: 'completed',
        manualAttachError: '',
        manualAttachCompletedAt: now,
        manualAttachUpdatedAt: now,
        extractedCodeCount: Number(materialized?.codeDefinitionCount || 0) || 0,
      }, { merge: true });
    } else {
      const normalizedUrl = normalizeUrl(job.manualUrl);
      if (!normalizedUrl) throw new HttpsError('invalid-argument', 'Manual URL is required for manual attachment.');
      const download = await downloadManualCandidate(normalizedUrl, fetchImpl);
      const extension = `${download?.extension || getExtension(download?.resolvedDownloadUrl || normalizedUrl, download?.contentType || '') || ''}`.toLowerCase();
      if (!isAllowedManualUpload({ contentType: download?.contentType, extension })) {
        throw new HttpsError('failed-precondition', 'Manual URL must point to a supported document type.');
      }
      const manualId = createAssetManualId({ companyId, assetId: assetDocId, sourceUrl: normalizedUrl });
      const targetPath = `companies/${companyId}/manuals/${assetDocId}/${manualId}/source.${extension || 'bin'}`;

      await storage.bucket().file(targetPath).save(download.buffer, {
        resumable: false,
        contentType: download.contentType || 'application/octet-stream',
        metadata: {
          metadata: {
            companyId,
            assetId: assetDocId,
            sourceUrl: normalizedUrl,
            sourcePageUrl: normalizeUrl(job.sourcePageUrl),
            attachmentMode: 'manual_url_attach',
            manualProvenance: 'user_manual_url_attach',
          }
        }
      });

      const materialized = await materializeStoredAssetManual({
        db,
        storage,
        asset: { ...asset, id: assetDocId, firestoreDocId: assetDocId },
        userId: job.requestedBy || 'system',
        storagePath: targetPath,
        sourceUrl: normalizedUrl,
        sourceTitle: normalizeString(job.sourceTitle || asset?.name || 'Attached manual', 200),
        sourceType: 'manual_url_attach',
        manualType: 'asset_manual_url_attach',
        contentType: download.contentType || '',
        attachmentMode: 'manual_url_attach',
        manualProvenance: 'user_manual_url_attach',
      });

      const patch = buildAssetManualPatch({
        asset,
        userId: job.requestedBy || 'system',
        storagePath: targetPath,
        manualUrl: normalizedUrl,
        sourceTitle: job.sourceTitle,
        sourcePageUrl: normalizeUrl(job.sourcePageUrl),
        sourceType: 'manual_url_attach',
        manualProvenance: 'user_manual_attach',
        materialized,
      });
      attachResult = buildAttachResult({ assetId: assetDocId, storagePath: targetPath, materialized });
      await db.collection('assets').doc(assetDocId).set({
        ...patch,
        manualAttachStatus: 'completed',
        manualAttachError: '',
        manualAttachCompletedAt: now,
        manualAttachUpdatedAt: now,
        extractedCodeCount: Number(materialized?.codeDefinitionCount || 0) || 0,
      }, { merge: true });
    }

    await jobRef.set({
      status: 'completed',
      updatedAt: now,
      completedAt: now,
      result: {
        chunkCount: Number(attachResult?.chunkCount || 0) || 0,
        extractionStatus: attachResult?.extractionStatus || '',
        storagePath: attachResult?.storagePath || '',
      }
    }, { merge: true });
    return { ok: true, result: attachResult };
  } catch (error) {
    const code = normalizeManualAttachFailureCode(classifyManualAttachError(error));
    console.error('processManualAttachJob:error', {
      jobId,
      assetDocId,
      companyId,
      mode: job.mode || 'url_attach',
      code,
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
    await db.collection('assets').doc(assetDocId).set({
      manualAttachStatus: 'failed',
      manualAttachError: code,
      manualAttachUpdatedAt: now,
    }, { merge: true });
    await jobRef.set({
      status: 'failed',
      errorCode: code,
      errorMessage: `${error?.message || 'Manual attachment failed.'}`.slice(0, 240),
      updatedAt: now,
      completedAt: now,
    }, { merge: true });
    return { ok: false, code };
  }
}

module.exports = {
  queueManualAttachJob,
  processManualAttachJob,
  validateStoragePathForAsset,
};
