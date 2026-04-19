const admin = require('firebase-admin');
const { createHash } = require('node:crypto');

const COLLECTION = 'manualLibrary';

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
  buildManualLibraryStoragePath,
  createManualLibraryId,
  findApprovedManualLibraryRecord,
  findManualLibraryRecordByDownloadUrl,
  findManualLibraryRecordBySha,
  buildAliasKeys,
  normalizePhrase,
  normalizeUrl,
  writeManualLibraryRecord,
};
