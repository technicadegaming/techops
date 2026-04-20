const admin = require('firebase-admin');
const { createHash } = require('node:crypto');
const { normalizePhrase, normalizeUrl, buildAliasKeys } = require('./manualLibraryService');
const { normalizeManufacturerName } = require('./arcadeTitleAliasService');

const TRUSTED_MANUAL_CATALOG_COLLECTION = 'trustedManualCatalog';
const DEFAULT_CONFIDENCE_THRESHOLD = 0.9;

function normalizeString(value = '', max = 240) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeBoolean(value = false) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeString(value, 20).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function normalizeNumber(value = 0, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseAlternateNames(value = '') {
  if (Array.isArray(value)) return buildAliasKeys(value);
  return buildAliasKeys(`${value || ''}`.split(/[;|]+/g).map((entry) => normalizeString(entry, 180)).filter(Boolean));
}

function buildTrustedCatalogLookupKeys(row = {}) {
  const normalizedTitleKey = normalizePhrase(row.normalizedTitle || row.originalTitle || row.assetName || '');
  const normalizedNameKey = normalizePhrase(row.normalizedName || row.normalizedTitle || row.assetName || '');
  const originalTitleKey = normalizePhrase(row.originalTitle || row.normalizedTitle || row.assetName || '');
  const normalizedManufacturerKey = normalizePhrase(normalizeManufacturerName(row.manufacturer || ''));
  const aliasKeys = buildAliasKeys([
    ...(Array.isArray(row.alternateNames) ? row.alternateNames : parseAlternateNames(row.alternateNames)),
    row.assetName,
    row.originalTitle,
    row.normalizedTitle,
    row.normalizedName,
    row.model,
  ]);
  const allTitleKeys = Array.from(new Set([
    normalizedTitleKey,
    normalizedNameKey,
    originalTitleKey,
    ...aliasKeys,
  ].filter(Boolean)));

  return {
    normalizedTitleKey,
    normalizedNameKey,
    originalTitleKey,
    normalizedManufacturerKey,
    aliasKeys,
    allTitleKeys,
  };
}

function buildTrustedCatalogRowId(row = {}) {
  const explicit = normalizeString(row.assetId || row.sourceRowId || '', 160);
  if (explicit) return explicit;
  const keys = buildTrustedCatalogLookupKeys(row);
  const raw = `${keys.normalizedManufacturerKey}::${keys.normalizedTitleKey}::${normalizeUrl(row.manualUrl || row.manualSourceUrl || '')}`;
  return createHash('sha1').update(raw).digest('hex').slice(0, 40);
}

function normalizeTrustedCatalogRow(row = {}, sourceFile = '') {
  const normalized = {
    sourceRowId: normalizeString(row.assetId || row.sourceRowId || '', 160),
    assetName: normalizeString(row['asset name'] || row.assetName, 180),
    manufacturer: normalizeString(row.manufacturer, 180),
    model: normalizeString(row.model, 180),
    originalTitle: normalizeString(row.originalTitle, 220),
    normalizedTitle: normalizeString(row.normalizedTitle, 220),
    normalizedName: normalizeString(row.normalizedName, 220),
    alternateNames: parseAlternateNames(row.alternateNames),
    manualUrl: normalizeUrl(row.manualUrl || ''),
    manualSourceUrl: normalizeUrl(row.manualSourceUrl || ''),
    supportUrl: normalizeUrl(row.supportUrl || ''),
    supportEmail: normalizeString(row.supportEmail, 180),
    supportPhone: normalizeString(row.supportPhone, 80),
    matchType: normalizeString(row.matchType, 80),
    manualReady: normalizeBoolean(row.manualReady),
    reviewRequired: normalizeBoolean(row.reviewRequired),
    matchConfidence: normalizeNumber(row.matchConfidence, 0),
    source: 'imported_csv',
    trustedCatalog: true,
    importSourceFile: normalizeString(sourceFile, 500),
  };
  const keys = buildTrustedCatalogLookupKeys(normalized);
  return {
    ...normalized,
    ...keys,
  };
}

function isHighConfidenceTrustedCatalogMatch(row = {}, threshold = DEFAULT_CONFIDENCE_THRESHOLD) {
  return row.manualReady === true
    && row.reviewRequired !== true
    && normalizeNumber(row.matchConfidence, 0) >= threshold
    && !!normalizeUrl(row.manualUrl || '');
}

function toTrustedCatalogSuggestion(row = {}) {
  const manualUrl = normalizeUrl(row.manualUrl || '');
  const manualSourceUrl = normalizeUrl(row.manualSourceUrl || '');
  const supportUrl = normalizeUrl(row.supportUrl || '');
  const title = normalizeString(row.normalizedTitle || row.normalizedName || row.originalTitle || row.assetName, 220);
  const manufacturer = normalizeString(row.manufacturer, 180);
  const confidence = normalizeNumber(row.matchConfidence, 0);
  const common = {
    title,
    manufacturer,
    sourceType: 'trusted_catalog',
    trustedSource: true,
    trustedCatalog: true,
    discoverySource: 'trusted_catalog',
    confidence,
    matchScore: Math.round(confidence * 100),
    exactTitleMatch: true,
    exactManualMatch: row.manualReady === true && !!manualUrl,
    matchStatus: row.matchType || (row.manualReady ? 'trusted_catalog_exact' : 'trusted_catalog_review'),
    source: 'imported_csv',
    trustedCatalogSourceRowId: row.sourceRowId || row.id || '',
    manualReady: row.manualReady === true,
    reviewRequired: row.reviewRequired === true,
  };

  const documentationSuggestions = [];
  if (manualUrl || manualSourceUrl) {
    documentationSuggestions.push({
      ...common,
      title: manualUrl ? `${title} manual` : `${title} documentation source`,
      url: manualUrl || manualSourceUrl,
      sourcePageUrl: manualSourceUrl || supportUrl,
      candidateBucket: row.manualReady === true ? 'verified_pdf_candidate' : 'title_specific_support_page',
    });
  }
  const supportResources = [];
  if (supportUrl || manualSourceUrl) {
    supportResources.push({
      ...common,
      exactManualMatch: false,
      title: `${title} support`,
      url: supportUrl || manualSourceUrl,
      sourceType: 'support',
      candidateBucket: 'title_specific_support_page',
    });
  }

  return {
    row,
    confidence,
    documentationSuggestions,
    supportResources,
    selectedManualUrl: manualUrl,
    reviewOnly: !isHighConfidenceTrustedCatalogMatch(row),
  };
}

async function fetchTrustedCatalogRowsByField(db, field, value, operator = '==', limit = 25) {
  if (!db || !field || !value) return [];
  const snap = await db.collection(TRUSTED_MANUAL_CATALOG_COLLECTION)
    .where(field, operator, value)
    .limit(limit)
    .get()
    .catch(() => ({ docs: [] }));
  return (snap.docs || []).map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function findTrustedCatalogManualMatch({
  db,
  assetName = '',
  normalizedName = '',
  originalTitle = '',
  manufacturer = '',
  alternateNames = [],
  minConfidence = DEFAULT_CONFIDENCE_THRESHOLD,
} = {}) {
  if (!db) return null;
  const lookupKeys = buildTrustedCatalogLookupKeys({
    assetName,
    normalizedTitle: normalizedName || assetName,
    normalizedName,
    originalTitle: originalTitle || assetName,
    manufacturer,
    alternateNames,
  });

  const queryValues = Array.from(new Set([
    lookupKeys.normalizedTitleKey,
    lookupKeys.normalizedNameKey,
    lookupKeys.originalTitleKey,
    ...lookupKeys.aliasKeys,
  ].filter(Boolean))).slice(0, 20);

  const rows = [];
  for (const value of queryValues) {
    rows.push(...await fetchTrustedCatalogRowsByField(db, 'allTitleKeys', value, 'array-contains', 20));
  }

  const deduped = new Map();
  rows.forEach((row) => {
    const key = `${row.id || ''}`;
    if (!key || deduped.has(key)) return;
    deduped.set(key, row);
  });
  const candidates = Array.from(deduped.values()).filter((row) => {
    if (row.trustedCatalog !== true && row.source !== 'imported_csv') return false;
    const rowManufacturer = normalizePhrase(normalizeManufacturerName(row.manufacturer || ''));
    return !lookupKeys.normalizedManufacturerKey || !rowManufacturer || rowManufacturer === lookupKeys.normalizedManufacturerKey;
  });
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aReady = isHighConfidenceTrustedCatalogMatch(a, minConfidence) ? 1 : 0;
    const bReady = isHighConfidenceTrustedCatalogMatch(b, minConfidence) ? 1 : 0;
    if (aReady !== bReady) return bReady - aReady;
    return normalizeNumber(b.matchConfidence, 0) - normalizeNumber(a.matchConfidence, 0);
  });

  const best = normalizeTrustedCatalogRow(candidates[0]);
  return {
    row: { ...candidates[0], ...best },
    lookupKeys,
    highConfidenceSelected: isHighConfidenceTrustedCatalogMatch(candidates[0], minConfidence),
    reviewOnly: !isHighConfidenceTrustedCatalogMatch(candidates[0], minConfidence),
    confidenceThreshold: minConfidence,
  };
}

async function importTrustedCatalogRows({ db, rows = [], sourceFile = '' } = {}) {
  const stats = {
    rowsProcessed: 0,
    rowsImported: 0,
    rowsSkipped: 0,
    rowsMissingManualUrl: 0,
    rowsTrustedManualReady: 0,
  };
  if (!db || !Array.isArray(rows)) return stats;

  for (const row of rows) {
    stats.rowsProcessed += 1;
    const normalized = normalizeTrustedCatalogRow(row, sourceFile);
    const id = buildTrustedCatalogRowId(normalized);
    if (!normalized.assetName && !normalized.normalizedTitle && !normalized.originalTitle) {
      stats.rowsSkipped += 1;
      continue;
    }
    if (!normalized.manualUrl) stats.rowsMissingManualUrl += 1;
    if (normalized.trustedCatalog && normalized.manualReady) stats.rowsTrustedManualReady += 1;
    await db.collection(TRUSTED_MANUAL_CATALOG_COLLECTION).doc(id).set({
      ...normalized,
      sourceRowId: normalized.sourceRowId || id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      importedAtMs: Date.now(),
    }, { merge: true });
    stats.rowsImported += 1;
  }
  return stats;
}

module.exports = {
  TRUSTED_MANUAL_CATALOG_COLLECTION,
  DEFAULT_CONFIDENCE_THRESHOLD,
  normalizeTrustedCatalogRow,
  buildTrustedCatalogLookupKeys,
  buildTrustedCatalogRowId,
  findTrustedCatalogManualMatch,
  importTrustedCatalogRows,
  toTrustedCatalogSuggestion,
  isHighConfidenceTrustedCatalogMatch,
};
