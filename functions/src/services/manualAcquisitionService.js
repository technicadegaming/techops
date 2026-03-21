const { createHash } = require('node:crypto');
const { extractManualLinksFromHtmlPage } = require('./manualDiscoveryService');
const {
  buildManualLibraryStoragePath,
  findManualLibraryRecordByDownloadUrl,
  findManualLibraryRecordBySha,
  findApprovedManualLibraryRecord,
  normalizePhrase,
  normalizeUrl,
  writeManualLibraryRecord,
} = require('./manualLibraryService');

const ALLOWED_EXTENSIONS = new Set(['pdf', 'doc', 'docx']);

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

async function downloadManualCandidate(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { 'user-agent': 'techops-manual-acquisition/1.0' } });
  if (!response.ok) throw new Error(`Manual download failed with status ${response.status}`);
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

  logEvent('start', { inputTitle: context.originalTitle, canonicalTitle, manufacturer, sourcePageUrl, originalDownloadUrl: directManualUrl });

  const approvedHit = await findApprovedManualLibraryRecord({ db, canonicalTitle, manufacturer, familyTitle });
  if (approvedHit) {
    logEvent('existing_library_hit', { canonicalTitle, manufacturer, manualLibraryId: approvedHit.id, reusedExisting: true });
    return { manualReady: true, reusedExisting: true, manualLibrary: approvedHit, manualUrl: approvedHit.storagePath, manualSourceUrl: approvedHit.sourcePageUrl || sourcePageUrl };
  }

  let candidates = [];
  if (directManualUrl) candidates.push({ url: directManualUrl, sourcePageUrl, title: candidate.title || context.originalTitle || canonicalTitle });
  if (!candidates.length && sourcePageUrl) {
    logEvent('source_page_fetch', { canonicalTitle, manufacturer, sourcePageUrl });
    const titleVariants = [canonicalTitle, context.originalTitle, familyTitle].filter(Boolean).map((value) => normalizePhrase(value));
    const extracted = await extractManualLinksFromHtmlPage({
      pageUrl: sourcePageUrl,
      pageTitle: candidate.title || canonicalTitle,
      manufacturer,
      titleVariants,
      manufacturerProfile: context.manufacturerProfile,
      fetchImpl,
      logEvent: (event, payload) => logEvent(event, payload),
    });
    candidates = extracted.map((entry) => ({ ...entry, sourcePageUrl }));
  }

  let acceptedCount = 0;
  for (const candidateLink of candidates) {
    const normalizedCandidateUrl = normalizeUrl(candidateLink.url);
    if (!normalizedCandidateUrl) {
      logEvent('download_candidate_rejected', { canonicalTitle, rejectionReasons: ['invalid_url'] });
      continue;
    }
    const existingByUrl = await findManualLibraryRecordByDownloadUrl(db, normalizedCandidateUrl);
    if (existingByUrl) {
      logEvent('existing_library_hit', { canonicalTitle, manufacturer, resolvedDownloadUrl: normalizedCandidateUrl, manualLibraryId: existingByUrl.id, reusedExisting: true });
      return { manualReady: true, reusedExisting: true, manualLibrary: existingByUrl, manualUrl: existingByUrl.storagePath, manualSourceUrl: existingByUrl.sourcePageUrl || sourcePageUrl };
    }
    logEvent('download_candidate_found', { canonicalTitle, manufacturer, sourcePageUrl, originalDownloadUrl: normalizedCandidateUrl, candidateCount: candidates.length });
    const download = await downloadManualCandidate(normalizedCandidateUrl, fetchImpl).catch((error) => {
      logEvent('download_candidate_rejected', { canonicalTitle, originalDownloadUrl: normalizedCandidateUrl, rejectionReasons: [error.message] });
      return null;
    });
    if (!download) continue;
    if (!ALLOWED_EXTENSIONS.has(download.extension) || !isDocumentLike(download)) {
      logEvent('download_candidate_rejected', { canonicalTitle, originalDownloadUrl: normalizedCandidateUrl, resolvedDownloadUrl: download.resolvedDownloadUrl, rejectionReasons: ['not_a_manual_document'] });
      continue;
    }
    acceptedCount += 1;
    const sha256 = createHash('sha256').update(download.buffer).digest('hex');
    logEvent('file_downloaded', { canonicalTitle, resolvedDownloadUrl: download.resolvedDownloadUrl, sha256, fileSize: download.buffer.length });
    const existingByHash = await findManualLibraryRecordBySha(db, sha256);
    if (existingByHash) {
      logEvent('file_reused_by_hash', { canonicalTitle, resolvedDownloadUrl: download.resolvedDownloadUrl, sha256, storagePath: existingByHash.storagePath, reusedExisting: true });
      return { manualReady: true, reusedExisting: true, manualLibrary: existingByHash, manualUrl: existingByHash.storagePath, manualSourceUrl: existingByHash.sourcePageUrl || sourcePageUrl };
    }
    const storagePath = buildManualLibraryStoragePath({ normalizedManufacturer, canonicalTitle, sha256, extension: download.extension });
    await storage.bucket().file(storagePath).save(download.buffer, {
      resumable: false,
      contentType: download.contentType,
      metadata: { metadata: { canonicalTitle, manufacturer, sha256, sourcePageUrl, resolvedDownloadUrl: download.resolvedDownloadUrl } }
    });
    logEvent('file_uploaded', { canonicalTitle, storagePath, sha256, reusedExisting: false });
    const record = await writeManualLibraryRecord({
      db,
      record: {
        canonicalTitle,
        familyTitle,
        manufacturer,
        normalizedManufacturer,
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
        notes: context.notes || '',
      },
    });
    logEvent('library_record_written', { canonicalTitle, storagePath, sha256, manualLibraryId: record.id });
    logEvent('final_result', { canonicalTitle, manufacturer, sourcePageUrl, resolvedDownloadUrl: download.resolvedDownloadUrl, acceptedCandidateCount: acceptedCount, sha256, storagePath, reusedExisting: false, finalManualReady: true });
    return { manualReady: true, reusedExisting: false, manualLibrary: record, manualUrl: storagePath, manualSourceUrl: sourcePageUrl };
  }

  logEvent('final_result', { canonicalTitle, manufacturer, sourcePageUrl, candidateCount: candidates.length, acceptedCandidateCount: acceptedCount, finalManualReady: false });
  return { manualReady: false, manualLibrary: null, manualUrl: '', manualSourceUrl: sourcePageUrl };
}

module.exports = { acquireManualToLibrary, downloadManualCandidate, isDocumentLike, getExtension };
