const { createHash } = require('node:crypto');
const { extractManualLinksFromHtmlPage } = require('./manualDiscoveryService');
const {
  buildManualLibraryStoragePath,
  findManualLibraryRecordByDownloadUrl,
  findManualLibraryRecordBySha,
  findApprovedManualLibraryRecord,
  buildAliasKeys,
  normalizePhrase,
  normalizeUrl,
  writeManualLibraryRecord,
} = require('./manualLibraryService');

const ALLOWED_EXTENSIONS = new Set(['pdf', 'doc', 'docx']);
const DOWNLOAD_TIMEOUT_MS = 10000;
const DEAD_LINK_STATUSES = new Set([404, 410]);

function isAbortLikeError(error) {
  const code = `${error?.code || ''}`.toLowerCase();
  const name = `${error?.name || ''}`.toLowerCase();
  return code === 'abort_err' || code === 'aborted' || name === 'aborterror';
}

function logEvent(event, payload = {}) {
  try { console.log(`manualAcquire:${event}`, payload); } catch (error) {
    void error;
  }
}

function getExtension(url = '', contentType = '') {
  const match = `${url}`.toLowerCase().match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
  if (match?.[1]) return match[1].toLowerCase();
  if (`${contentType}`.toLowerCase().includes('pdf')) return 'pdf';
  if (`${contentType}`.toLowerCase().includes('word')) return 'docx';
  return 'bin';
}

function isDocumentLike({ contentType = '', extension = '', buffer = Buffer.alloc(0) } = {}) {
  const lowerType = `${contentType}`.toLowerCase();
  const ext = `${extension}`.toLowerCase();
  if (lowerType.includes('html')) return false;
  if (ext === 'pdf') return buffer.slice(0, 5).toString('utf8').startsWith('%PDF-');
  if (['doc', 'docx'].includes(ext)) return true;
  return lowerType.includes('pdf') || lowerType.includes('msword') || lowerType.includes('officedocument');
}

function isDeadLinkStatus(status = 0) {
  const code = Number(status || 0) || 0;
  return DEAD_LINK_STATUSES.has(code) || code >= 500;
}

function isLikelyDirectDocumentUrl(url = '') {
  const normalized = normalizeUrl(url).toLowerCase();
  if (!normalized) return false;
  return /\.(pdf|docx?)($|[?#])/.test(normalized);
}

async function downloadManualCandidate(url, fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': 'techops-manual-acquisition/1.0' },
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortLikeError(error)) throw new Error(`Manual download timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const error = new Error(`Manual download failed with status ${response.status}`);
    error.code = 'manual-download-http-error';
    error.httpStatus = Number(response.status || 0) || 0;
    throw error;
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = `${response.headers.get('content-type') || ''}`.toLowerCase();
  return {
    originalDownloadUrl: normalizeUrl(url),
    resolvedDownloadUrl: normalizeUrl(response.url || url),
    buffer,
    contentType,
    extension: getExtension(response.url || url, contentType),
  };
}

async function acquireManualToLibrary({
  db,
  storage,
  fetchImpl = fetch,
  candidate = {},
  context = {},
} = {}) {
  const canonicalTitle = context.canonicalTitle || context.normalizedTitle || context.originalTitle || '';
  const familyTitle = context.familyTitle || canonicalTitle;
  const manufacturer = context.manufacturer || '';
  const normalizedManufacturer = normalizePhrase(manufacturer);
  const sourcePageUrl = normalizeUrl(candidate.sourcePageUrl || context.manualSourceUrl || '');
  const directManualUrl = normalizeUrl(candidate.url || context.manualUrl || '');
  const directManualLooksDocument = isLikelyDirectDocumentUrl(directManualUrl);
  const fallbackSourcePageUrl = !directManualLooksDocument ? directManualUrl : '';
  const sourcePageProbeUrl = sourcePageUrl || fallbackSourcePageUrl;

  const startedAt = Date.now();
  logEvent('start', { inputTitle: context.originalTitle, canonicalTitle, manufacturer, sourcePageUrl, originalDownloadUrl: directManualUrl });

  const approvedHit = await findApprovedManualLibraryRecord({ db, canonicalTitle, manufacturer, familyTitle });
  if (approvedHit) {
    logEvent('existing_library_hit', { canonicalTitle, manufacturer, manualLibraryId: approvedHit.id, reusedExisting: true });
    return { manualReady: true, reusedExisting: true, manualLibrary: approvedHit, manualUrl: approvedHit.storagePath, manualSourceUrl: approvedHit.sourcePageUrl || sourcePageUrl };
  }

  let candidates = [];
  const failedCandidates = [];
  if (directManualLooksDocument && directManualUrl) {
    candidates.push({ url: directManualUrl, sourcePageUrl: sourcePageProbeUrl, title: candidate.title || context.originalTitle || canonicalTitle });
  }
  if (sourcePageProbeUrl) {
    logEvent('source_page_fetch', { canonicalTitle, manufacturer, sourcePageUrl: sourcePageProbeUrl });
    const titleVariants = [canonicalTitle, context.originalTitle, familyTitle].filter(Boolean).map((value) => normalizePhrase(value));
    const extracted = await extractManualLinksFromHtmlPage({
      pageUrl: sourcePageProbeUrl,
      pageTitle: candidate.title || canonicalTitle,
      manufacturer,
      titleVariants,
      manufacturerProfile: context.manufacturerProfile,
      fetchImpl,
      logEvent: (event, payload) => logEvent(event, payload),
    });
    candidates = [
      ...candidates,
      ...extracted.map((entry) => ({ ...entry, sourcePageUrl: sourcePageProbeUrl })),
    ];
  }

  let acceptedCount = 0;
  for (const candidateLink of candidates) {
    const normalizedCandidateUrl = normalizeUrl(candidateLink.url);
    if (!normalizedCandidateUrl) {
      logEvent('download_candidate_rejected', { canonicalTitle, rejectionReasons: ['invalid_url'] });
      failedCandidates.push({
        url: `${candidateLink.url || ''}`.trim(),
        status: 'unusable',
        reason: 'invalid_url',
        deadLink: false,
      });
      continue;
    }
    const existingByUrl = await findManualLibraryRecordByDownloadUrl(db, normalizedCandidateUrl);
    if (existingByUrl) {
      logEvent('existing_library_hit', { canonicalTitle, manufacturer, resolvedDownloadUrl: normalizedCandidateUrl, manualLibraryId: existingByUrl.id, reusedExisting: true });
      return { manualReady: true, reusedExisting: true, manualLibrary: existingByUrl, manualUrl: existingByUrl.storagePath, manualSourceUrl: existingByUrl.sourcePageUrl || sourcePageUrl };
    }
    logEvent('download_candidate_found', { canonicalTitle, manufacturer, sourcePageUrl, originalDownloadUrl: normalizedCandidateUrl, candidateCount: candidates.length });
    const download = await downloadManualCandidate(normalizedCandidateUrl, fetchImpl, context.downloadTimeoutMs).catch((error) => {
      logEvent('download_candidate_rejected', { canonicalTitle, originalDownloadUrl: normalizedCandidateUrl, rejectionReasons: [error.message] });
      const httpStatus = Number(error?.httpStatus || 0) || 0;
      const deadLink = isDeadLinkStatus(httpStatus);
      failedCandidates.push({
        url: normalizedCandidateUrl,
        status: deadLink ? 'dead_link' : 'download_failed',
        reason: normalizePhrase(error?.message || '') || 'download_failed',
        deadLink,
        httpStatus,
      });
      return null;
    });
    if (!download) continue;
    logEvent('acquisition_download_succeeded', {
      canonicalTitle,
      originalDownloadUrl: normalizedCandidateUrl,
      resolvedDownloadUrl: download.resolvedDownloadUrl,
      contentType: download.contentType,
      extension: download.extension,
      fileSize: download.buffer.length,
    });
    if (!ALLOWED_EXTENSIONS.has(download.extension) || !isDocumentLike(download)) {
      logEvent('download_candidate_rejected', { canonicalTitle, originalDownloadUrl: normalizedCandidateUrl, resolvedDownloadUrl: download.resolvedDownloadUrl, rejectionReasons: ['not_a_manual_document'] });
      failedCandidates.push({
        url: normalizedCandidateUrl,
        status: 'unusable',
        reason: 'not_a_manual_document',
        deadLink: false,
      });
      continue;
    }
    acceptedCount += 1;
    const sha256 = createHash('sha256').update(download.buffer).digest('hex');
    logEvent('file_downloaded', { canonicalTitle, resolvedDownloadUrl: download.resolvedDownloadUrl, sha256, fileSize: download.buffer.length });
    const existingByHash = await findManualLibraryRecordBySha(db, sha256);
    if (existingByHash) {
      logEvent('file_reused_by_hash', { canonicalTitle, resolvedDownloadUrl: download.resolvedDownloadUrl, sha256, storagePath: existingByHash.storagePath, reusedExisting: true });
      return { manualReady: true, reusedExisting: true, manualLibrary: existingByHash, manualUrl: existingByHash.storagePath, manualSourceUrl: existingByHash.sourcePageUrl || sourcePageUrl, failedCandidates };
    }
    const storagePath = buildManualLibraryStoragePath({ normalizedManufacturer, canonicalTitle, sha256, extension: download.extension });
    logEvent('durable_storage_write_started', {
      canonicalTitle,
      resolvedDownloadUrl: download.resolvedDownloadUrl,
      storagePath,
      sha256,
    });
    await storage.bucket().file(storagePath).save(download.buffer, {
      resumable: false,
      contentType: download.contentType,
      metadata: { metadata: { canonicalTitle, manufacturer, sha256, sourcePageUrl, resolvedDownloadUrl: download.resolvedDownloadUrl } }
    });
    logEvent('durable_storage_write_completed', {
      canonicalTitle,
      storagePath,
      sha256,
    });
    logEvent('file_uploaded', { canonicalTitle, storagePath, sha256, reusedExisting: false });
    const record = await writeManualLibraryRecord({
      db,
      record: {
        canonicalTitle,
        familyTitle,
        manufacturer,
        normalizedManufacturer,
        canonicalTitleNormalized: normalizePhrase(canonicalTitle),
        familyTitleNormalized: normalizePhrase(familyTitle),
        alternateTitleKeys: buildAliasKeys([
          ...(Array.isArray(context.titleAliases) ? context.titleAliases : []),
          canonicalTitle,
          familyTitle,
          context.originalTitle || '',
          context.normalizedTitle || '',
        ]),
        variant: candidateLink.variant || context.variant || '',
        sourcePageUrl,
        originalDownloadUrl: download.originalDownloadUrl,
        resolvedDownloadUrl: download.resolvedDownloadUrl,
        storagePath,
        contentType: download.contentType,
        fileSize: download.buffer.length,
        sha256,
        filename: storagePath.split('/').pop() || '',
        extension: download.extension,
        linkType: candidateLink.linkType || candidate.linkType || '',
        matchType: context.matchType || candidate.matchType || 'exact_manual',
        matchConfidence: Number(context.matchConfidence || context.confidence || 0) || 0,
        reviewRequired: true,
        approvalState: 'pending',
        approved: false,
        lastVerifiedAt: new Date().toISOString(),
        seededFromWorkbook: context.seededFromWorkbook === true,
        catalogEntryId: context.catalogEntryId || '',
        trustedCatalog: context.trustedCatalog === true,
        trustedCatalogSourceRowId: context.trustedCatalogSourceRowId || '',
        source: context.source || '',
        notes: context.notes || '',
      },
    });
    logEvent('manual_library_record_persisted', { canonicalTitle, storagePath, sha256, manualLibraryId: record.id });
    logEvent('final_result', { canonicalTitle, manufacturer, sourcePageUrl, resolvedDownloadUrl: download.resolvedDownloadUrl, acceptedCandidateCount: acceptedCount, sha256, storagePath, reusedExisting: false, finalManualReady: true, elapsedMs: Date.now() - startedAt });
    return { manualReady: true, reusedExisting: false, manualLibrary: record, manualUrl: storagePath, manualSourceUrl: sourcePageUrl, failedCandidates };
  }

  logEvent('final_result', { canonicalTitle, manufacturer, sourcePageUrl, candidateCount: candidates.length, acceptedCandidateCount: acceptedCount, finalManualReady: false, elapsedMs: Date.now() - startedAt });
  return { manualReady: false, manualLibrary: null, manualUrl: '', manualSourceUrl: sourcePageUrl, failedCandidates };
}

module.exports = { acquireManualToLibrary, downloadManualCandidate, isDocumentLike, getExtension };
