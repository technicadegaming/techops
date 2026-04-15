const admin = require('firebase-admin');
const { createHash } = require('node:crypto');

const COLLECTION = 'manualLibrary';

function normalizeString(value = '', max = 240) {
  return `${value || ''}`.trim().slice(0, max);
}

function normalizePhrase(value = '') {
  return `${value || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
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

async function findApprovedManualLibraryRecord({ db, canonicalTitle = '', manufacturer = '', familyTitle = '' } = {}) {
  if (!db) return null;
  const normalizedTitle = normalizePhrase(canonicalTitle);
  const normalizedManufacturer = normalizePhrase(manufacturer);
  const normalizedFamily = normalizePhrase(familyTitle);
  const snap = await db.collection(COLLECTION).limit(100).get().catch(() => ({ docs: [] }));
  const rows = (snap.docs || []).map((doc) => ({ id: doc.id, ...doc.data() }));
  return rows.find((row) => {
    if (!(row.approved === true || row.approvalState === 'approved')) return false;
    const rowTitle = normalizePhrase(row.canonicalTitle);
    const rowManufacturer = normalizePhrase(row.normalizedManufacturer || row.manufacturer);
    const rowFamily = normalizePhrase(row.familyTitle);
    return (!!normalizedTitle && rowTitle === normalizedTitle)
      && (!normalizedManufacturer || rowManufacturer === normalizedManufacturer)
      && (!normalizedFamily || !rowFamily || rowFamily === normalizedFamily);
  }) || null;
}

async function writeManualLibraryRecord({ db, record = {}, manualLibraryId = '' } = {}) {
  const id = manualLibraryId || createManualLibraryId(record);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection(COLLECTION).doc(id).set({
    approvalState: 'pending',
    approved: false,
    reviewRequired: true,
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
  normalizePhrase,
  normalizeUrl,
  writeManualLibraryRecord,
};
