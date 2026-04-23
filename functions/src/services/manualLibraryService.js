const admin = require('firebase-admin');
const { createHash } = require('node:crypto');

const COLLECTION = 'manualLibrary';
const NON_DURABLE_MATCH_TYPES = new Set([
  'unresolved',
  'support only',
  'title specific source',
  'title specific support page',
  'brochure or spec doc',
  'vendor',
  'store',
  'navigation',
  'generic support',
]);
const BROCHURE_HINT_PATTERN = /(brochure|spec(?:ification)?(?:\s*sheet)?|sell[\s-]?sheet|flyer|catalog|promo|marketing)/i;
const WRONG_FAMILY_HINT_PATTERN = /(support|help|blog|news|parts|store|vendor|shop|product-category|taxonomy|checkout|cart|login)/i;

function normalizeString(value = '', max = 240) {
  return `${value || ''}`.trim().slice(0, max);
}

function normalizePhrase(value = '') {
  return `${value || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function buildAliasKeys(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizePhrase(value))
    .filter((value) => value.length >= 3))).slice(0, 25);
}

function normalizeUrl(value = '') {
  const trimmed = `${value || ''}`.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function tokenizePhrase(value = '') {
  return normalizePhrase(value)
    .split(' ')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 3);
}

function tokenOverlapRatio(a = '', b = '') {
  const aTokens = tokenizePhrase(a);
  const bTokens = tokenizePhrase(b);
  if (!aTokens.length || !bTokens.length) return 0;
  const bSet = new Set(bTokens);
  const overlap = aTokens.filter((token) => bSet.has(token)).length;
  return overlap / Math.max(aTokens.length, bTokens.length);
}

function assessManualLibraryCandidateIntegrity({ candidate = {}, context = {} } = {}) {
  const matchType = normalizePhrase(candidate.matchType || context.matchType || '');
  const sourceType = normalizePhrase(candidate.sourceType || candidate.resourceType || context.sourceType || '');
  const cachedManual = candidate.cachedManual === true || `${candidate.cachedManual || ''}` === 'true';
  const reusableManualRef = normalizeString(candidate.manualLibraryRef || candidate.manualStoragePath || '', 500);
  if (cachedManual || reusableManualRef || sourceType === 'manual library') {
    return {
      durableAllowed: true,
      flags: [],
      reason: 'already_durable_manual_evidence',
    };
  }
  const textBlob = [
    candidate.reason,
    candidate.notes,
    candidate.title,
    candidate.sourceTitle,
    candidate.url,
    candidate.resolvedDownloadUrl,
    candidate.originalDownloadUrl,
    sourceType,
    matchType,
  ].join(' ');
  const hasDirectManualSignal = /\.pdf($|[?#])/i.test(`${candidate.url || candidate.resolvedDownloadUrl || candidate.originalDownloadUrl || ''}`)
    || /manual|operator|service/i.test(textBlob);
  const flags = [];
  if (NON_DURABLE_MATCH_TYPES.has(matchType)) flags.push(`non_durable_match_type:${matchType}`);
  if (sourceType && /support|vendor|store|navigation|generic/.test(sourceType) && !hasDirectManualSignal) flags.push(`non_manual_source_type:${sourceType}`);
  if (BROCHURE_HINT_PATTERN.test(textBlob)) flags.push('brochure_like_signal');
  if (WRONG_FAMILY_HINT_PATTERN.test(textBlob) && !/manual|operator|service/i.test(textBlob)) flags.push('generic_support_or_navigation_signal');
  const durableAllowed = flags.length === 0;
  return {
    durableAllowed,
    flags,
    reason: durableAllowed ? 'manual_grade_candidate' : 'blocked_non_durable_manual_candidate',
  };
}

function assessManualLibraryRecordIntegrity(record = {}) {
  const canonicalTitle = normalizeString(record.canonicalTitle || '', 240);
  const familyTitle = normalizeString(record.familyTitle || '', 240);
  const sourceTitle = normalizeString(record.sourceTitle || record.title || '', 240);
  const manufacturer = normalizeString(record.manufacturer || '', 240);
  const sourceManufacturer = normalizeString(record.sourceManufacturer || record.manualManufacturer || '', 240);
  const sourceUrl = normalizeString(record.sourcePageUrl || record.originalDownloadUrl || record.resolvedDownloadUrl || '', 2000);
  const matchType = normalizePhrase(record.matchType || '');
  const provenance = normalizePhrase(record.provenance || record.source || '');
  const notesBlob = `${record.notes || ''} ${record.reason || ''}`;
  const flags = [];

  const titleOverlap = tokenOverlapRatio(canonicalTitle || familyTitle, sourceTitle);
  if (sourceTitle && titleOverlap > 0 && titleOverlap < 0.34) flags.push('title_source_mismatch');
  if (sourceTitle && !titleOverlap && canonicalTitle) flags.push('title_source_no_overlap');

  const manufacturerOverlap = tokenOverlapRatio(manufacturer, sourceManufacturer);
  if (manufacturer && sourceManufacturer && manufacturerOverlap < 0.34) flags.push('manufacturer_mismatch');

  const sourceBlob = `${sourceTitle} ${sourceUrl} ${notesBlob}`;
  if (BROCHURE_HINT_PATTERN.test(sourceBlob)) flags.push('brochure_like_document');
  if (WRONG_FAMILY_HINT_PATTERN.test(sourceBlob) && !/manual|operator|service/i.test(sourceBlob)) flags.push('wrong_family_or_navigation_source');
  if (NON_DURABLE_MATCH_TYPES.has(matchType)) flags.push(`non_durable_match_type:${matchType}`);
  if (!matchType && !/manual|trusted|catalog|approved/.test(provenance)) flags.push('weak_match_provenance');
  if (!(record.approved === true || record.approvalState === 'approved') && record.reviewRequired !== true) flags.push('missing_review_controls');

  return {
    suspicious: flags.length > 0,
    flags,
    reviewSummary: {
      canonicalTitle,
      familyTitle,
      sourceTitle,
      manufacturer,
      sourceManufacturer,
      sourceUrl,
      matchType,
      provenance,
    },
  };
}

function createManualLibraryId({ normalizedManufacturer = '', canonicalTitle = '', variant = '', sha256 = '', resolvedDownloadUrl = '' } = {}) {
  const key = [normalizedManufacturer, normalizePhrase(canonicalTitle), normalizePhrase(variant), sha256 || createHash('sha1').update(resolvedDownloadUrl || '').digest('hex')]
    .filter(Boolean)
    .join('::');
  return key.replace(/[^a-z0-9:]+/g, '-').slice(0, 180) || `manual-${Date.now()}`;
}

function buildManualLibraryStoragePath({ normalizedManufacturer = '', canonicalTitle = '', sha256 = '', extension = 'bin' } = {}) {
  const manufacturerPart = normalizePhrase(normalizedManufacturer).replace(/\s+/g, '-') || 'unknown-manufacturer';
  const titlePart = normalizePhrase(canonicalTitle).replace(/\s+/g, '-') || 'unknown-title';
  const ext = normalizeString(extension || 'bin', 12).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `manual-library/${manufacturerPart}/${titlePart}/${sha256 || 'file'}.${ext}`;
}

async function findManualLibraryRecordByDownloadUrl(db, resolvedDownloadUrl = '') {
  const normalized = normalizeUrl(resolvedDownloadUrl);
  if (!db || !normalized) return null;
  const snap = await db.collection(COLLECTION)
    .where('resolvedDownloadUrl', '==', normalized)
    .limit(1)
    .get()
    .catch(() => ({ empty: true, docs: [] }));
  if (snap.empty || !snap.docs?.length) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function findManualLibraryRecordBySha(db, sha256 = '') {
  const normalized = normalizeString(sha256, 128).toLowerCase();
  if (!db || !normalized) return null;
  const snap = await db.collection(COLLECTION)
    .where('sha256', '==', normalized)
    .limit(1)
    .get()
    .catch(() => ({ empty: true, docs: [] }));
  if (snap.empty || !snap.docs?.length) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function findApprovedManualLibraryRecord({ db, canonicalTitle = '', manufacturer = '', familyTitle = '', alternateTitles = [] } = {}) {
  if (!db) return null;
  const normalizedTitle = normalizePhrase(canonicalTitle);
  const normalizedManufacturer = normalizePhrase(manufacturer);
  const normalizedFamily = normalizePhrase(familyTitle);
  const titleKeys = buildAliasKeys([canonicalTitle, familyTitle, ...(Array.isArray(alternateTitles) ? alternateTitles : [])]);
  const tryQueries = [
    normalizedTitle ? ['canonicalTitleNormalized', normalizedTitle] : null,
    normalizedFamily ? ['familyTitleNormalized', normalizedFamily] : null,
  ].filter(Boolean);

  const rows = [];
  for (const [field, value] of tryQueries) {
    const snap = await db.collection(COLLECTION)
      .where(field, '==', value)
      .limit(25)
      .get()
      .catch(() => ({ docs: [] }));
    rows.push(...(snap.docs || []).map((doc) => ({ id: doc.id, ...doc.data() })));
  }
  if (!rows.length) {
    const snap = await db.collection(COLLECTION).limit(200).get().catch(() => ({ docs: [] }));
    rows.push(...(snap.docs || []).map((doc) => ({ id: doc.id, ...doc.data() })));
  }
  return rows.find((row) => {
    if (!(row.approved === true || row.approvalState === 'approved')) return false;
    const rowTitle = normalizePhrase(row.canonicalTitleNormalized || row.canonicalTitle);
    const rowManufacturer = normalizePhrase(row.normalizedManufacturer || row.manufacturer);
    const rowFamily = normalizePhrase(row.familyTitleNormalized || row.familyTitle);
    const rowAliases = buildAliasKeys([...(row.alternateTitleKeys || []), ...(row.aliasKeys || []), row.canonicalTitle, row.familyTitle]);
    const titleMatch = (!!normalizedTitle && rowTitle === normalizedTitle)
      || (!!normalizedTitle && rowAliases.includes(normalizedTitle))
      || (!!normalizedFamily && rowAliases.includes(normalizedFamily))
      || titleKeys.some((key) => rowAliases.includes(key));
    return titleMatch
      && (!normalizedManufacturer || rowManufacturer === normalizedManufacturer)
      && (!normalizedFamily || !rowFamily || rowFamily === normalizedFamily || rowAliases.includes(normalizedFamily));
  }) || null;
}

async function writeManualLibraryRecord({ db, record = {}, manualLibraryId = '' } = {}) {
  const id = manualLibraryId || createManualLibraryId(record);
  const aliasKeys = buildAliasKeys([
    ...(Array.isArray(record.alternateTitleKeys) ? record.alternateTitleKeys : []),
    ...(Array.isArray(record.aliasKeys) ? record.aliasKeys : []),
    record.canonicalTitle,
    record.familyTitle,
    record.variant,
  ]);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection(COLLECTION).doc(id).set({
    approvalState: 'pending',
    approved: false,
    reviewRequired: true,
    canonicalTitleNormalized: normalizePhrase(record.canonicalTitle || ''),
    familyTitleNormalized: normalizePhrase(record.familyTitle || ''),
    normalizedManufacturer: normalizePhrase(record.normalizedManufacturer || record.manufacturer || ''),
    alternateTitleKeys: aliasKeys,
    aliasKeys,
    createdAt: now,
    updatedAt: now,
    ...record,
  }, { merge: true });
  return { id, ...record };
}

module.exports = {
  COLLECTION,
  assessManualLibraryCandidateIntegrity,
  assessManualLibraryRecordIntegrity,
  buildManualLibraryStoragePath,
  NON_DURABLE_MATCH_TYPES,
  createManualLibraryId,
  findApprovedManualLibraryRecord,
  findManualLibraryRecordByDownloadUrl,
  findManualLibraryRecordBySha,
  buildAliasKeys,
  normalizePhrase,
  normalizeUrl,
  writeManualLibraryRecord,
};
