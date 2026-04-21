const fs = require('node:fs');
const path = require('node:path');
const { normalizePhrase, normalizeManufacturerName } = require('./arcadeTitleAliasService');
const { buildTrustedCatalogLookupKeys } = require('./trustedManualCatalogService');

const TRUSTED_MANUAL_CATALOG_COLLECTION = 'trustedManualCatalog';
const DEFAULT_REFERENCE_INDEX_PATH = path.resolve(__dirname, '../data/manualLookupReferenceHints.json');

let inMemoryReferenceIndex = null;

function logReferenceEvent(event, payload = {}) {
  try {
    console.log(`manualLookupReference:${event}`, payload);
  } catch {
    // ignore logging failures for safety
  }
}

function normalizeString(value = '', max = 240) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeDomain(value = '') {
  const trimmed = normalizeString(value, 220);
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function splitAliases(value = '') {
  if (Array.isArray(value)) return value.map((entry) => normalizeString(entry, 180)).filter(Boolean);
  return `${value || ''}`
    .split(/[;|,]+/g)
    .map((entry) => normalizeString(entry, 180))
    .filter(Boolean);
}

function deriveSlugHints(values = []) {
  return Array.from(new Set(
    values
      .map((value) => normalizePhrase(value))
      .filter(Boolean)
      .map((value) => value.replace(/\s+/g, '-'))
      .filter(Boolean)
  ));
}

function deriveFilenameHints(values = []) {
  const out = [];
  values.forEach((value) => {
    const phrase = normalizePhrase(value);
    if (!phrase) return;
    const slug = phrase.replace(/\s+/g, '-');
    out.push(`${slug}-manual.pdf`);
    out.push(`${slug}-operator-manual.pdf`);
    out.push(`${slug}-service-manual.pdf`);
  });
  return Array.from(new Set(out));
}

function toReferenceRowCandidate(row = {}) {
  const normalizeBool = (value) => value === true || `${value || ''}`.trim().toLowerCase() === 'true';
  const normalizeConfidence = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const alternateNames = splitAliases(row.alternateNames).slice(0, 16);
  return {
    rowId: normalizeString(row.rowId || row.id || row.assetId || '', 160),
    sourceRowId: normalizeString(row.sourceRowId || row.id || row.assetId || '', 160),
    assetName: normalizeString(row.assetName || '', 220),
    manufacturer: normalizeString(row.manufacturer || '', 180),
    originalTitle: normalizeString(row.originalTitle || row.assetName || '', 220),
    normalizedTitle: normalizeString(row.normalizedTitle || row.normalizedName || '', 220),
    alternateNames,
    manualUrl: normalizeString(row.manualUrl || '', 320),
    manualSourceUrl: normalizeString(row.manualSourceUrl || '', 320),
    supportUrl: normalizeString(row.supportUrl || '', 320),
    matchType: normalizeString(row.matchType || '', 120),
    manualReady: normalizeBool(row.manualReady),
    reviewRequired: normalizeBool(row.reviewRequired),
    matchConfidence: normalizeConfidence(row.matchConfidence),
  };
}

function createIndexContainer() {
  return {
    generatedAt: new Date().toISOString(),
    referenceOnly: true,
    notTrustedCatalog: true,
    entries: [],
    byNormalizedTitleKey: {},
    byNormalizedNameKey: {},
    byOriginalTitleKey: {},
    byAliasKey: {},
    byNormalizedManufacturerKey: {},
  };
}

function indexEntryKey(row = {}) {
  const keys = buildTrustedCatalogLookupKeys(row);
  const titleKey = keys.normalizedTitleKey || keys.originalTitleKey || keys.normalizedNameKey || 'unknown-title';
  const manufacturerKey = keys.normalizedManufacturerKey || 'unknown-manufacturer';
  return `${manufacturerKey}::${titleKey}`;
}

function buildReferenceHintsFromRows(rows = []) {
  const canonicalTitleHints = new Set();
  const normalizedTitleHints = new Set();
  const aliases = new Set();
  const familyTitles = new Set();
  const manufacturerDomains = new Set();
  const provenance = new Set();
  const referenceRowCandidates = [];
  let manufacturerNormalization = '';

  rows.forEach((row = {}) => {
    const title = normalizeString(row.normalizedTitle || row.normalizedName || row.originalTitle || row.assetName, 220);
    const family = normalizeString(row.familyTitle || row.family || '', 220);
    if (title) {
      canonicalTitleHints.add(title);
      normalizedTitleHints.add(normalizePhrase(title));
    }
    splitAliases(row.alternateNames).forEach((alias) => aliases.add(alias));
    if (family) familyTitles.add(family);

    manufacturerNormalization = manufacturerNormalization || normalizeManufacturerName(row.manufacturer || '');
    [row.manualUrl, row.manualSourceUrl, row.supportUrl, ...(Array.isArray(row.preferredDomains) ? row.preferredDomains : [])]
      .map((value) => normalizeDomain(value))
      .filter(Boolean)
      .forEach((domain) => manufacturerDomains.add(domain));

    const sourceRowId = normalizeString(row.sourceRowId || row.id || row.assetId || '', 160);
    if (sourceRowId) provenance.add(sourceRowId);
    referenceRowCandidates.push(toReferenceRowCandidate(row));
  });

  const allTitles = [
    ...canonicalTitleHints,
    ...aliases,
    ...familyTitles,
  ];

  return {
    referenceOnly: true,
    notTrustedCatalog: true,
    canonicalTitleHints: Array.from(canonicalTitleHints).slice(0, 12),
    normalizedTitleHints: Array.from(normalizedTitleHints).slice(0, 12),
    manufacturerNormalization,
    aliases: Array.from(aliases).slice(0, 20),
    familyTitles: Array.from(familyTitles).slice(0, 10),
    likelyManualFilenamePatterns: deriveFilenameHints(allTitles).slice(0, 24),
    likelySlugPatterns: deriveSlugHints(allTitles).slice(0, 24),
    preferredManufacturerDomains: Array.from(manufacturerDomains).slice(0, 10),
    lookupRowsUsed: rows.length,
    provenance: Array.from(provenance).slice(0, 30),
    referenceRowCandidates: referenceRowCandidates.slice(0, 30),
  };
}

function addKeyedReference(map = {}, key = '', entryKey = '') {
  if (!key || !entryKey) return;
  const existing = Array.isArray(map[key]) ? map[key] : [];
  if (!existing.includes(entryKey)) map[key] = [...existing, entryKey];
}

function buildReferenceIndexFromRows(rows = []) {
  const grouped = new Map();
  rows.forEach((row) => {
    const key = indexEntryKey(row);
    const list = grouped.get(key) || [];
    list.push(row);
    grouped.set(key, list);
  });

  const index = createIndexContainer();
  grouped.forEach((groupRows, entryKey) => {
    const primary = groupRows[0] || {};
    const keys = buildTrustedCatalogLookupKeys(primary);
    const hints = buildReferenceHintsFromRows(groupRows);
    const entry = {
      entryKey,
      normalizedTitleKey: keys.normalizedTitleKey,
      normalizedNameKey: keys.normalizedNameKey,
      originalTitleKey: keys.originalTitleKey,
      aliasKeys: keys.aliasKeys || [],
      normalizedManufacturerKey: keys.normalizedManufacturerKey,
      ...hints,
    };
    index.entries.push(entry);

    addKeyedReference(index.byNormalizedTitleKey, entry.normalizedTitleKey, entryKey);
    addKeyedReference(index.byNormalizedNameKey, entry.normalizedNameKey, entryKey);
    addKeyedReference(index.byOriginalTitleKey, entry.originalTitleKey, entryKey);
    (entry.aliasKeys || []).forEach((aliasKey) => addKeyedReference(index.byAliasKey, aliasKey, entryKey));
    addKeyedReference(index.byNormalizedManufacturerKey, entry.normalizedManufacturerKey, entryKey);
  });

  return {
    ...index,
    entryCount: index.entries.length,
  };
}

function safeReadReferenceIndex(referenceIndexPath = DEFAULT_REFERENCE_INDEX_PATH) {
  try {
    if (!fs.existsSync(referenceIndexPath)) return createIndexContainer();
    const parsed = JSON.parse(fs.readFileSync(referenceIndexPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return createIndexContainer();
    return {
      ...createIndexContainer(),
      ...parsed,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return createIndexContainer();
  }
}

function getReferenceIndex({ referenceIndex = null, referenceIndexPath = DEFAULT_REFERENCE_INDEX_PATH } = {}) {
  if (referenceIndex && typeof referenceIndex === 'object') return referenceIndex;
  if (!inMemoryReferenceIndex) {
    inMemoryReferenceIndex = safeReadReferenceIndex(referenceIndexPath);
    logReferenceEvent('reference_index_loaded', {
      referenceIndexPath,
      referenceIndexEntryCount: (inMemoryReferenceIndex.entries || []).length,
    });
    logReferenceEvent('reference_index_entry_count', {
      count: (inMemoryReferenceIndex.entries || []).length,
    });
  }
  return inMemoryReferenceIndex;
}

function findReferenceEntries(index = {}, lookupKeys = {}) {
  const entryByKey = new Map((index.entries || []).map((entry) => [entry.entryKey, entry]));
  const candidateKeys = new Set();
  const expandedMatchReasons = [];
  const addFromMap = (mapName, key) => {
    if (!key) return;
    const rows = Array.isArray(index?.[mapName]?.[key]) ? index[mapName][key] : [];
    rows.forEach((entryKey) => {
      candidateKeys.add(entryKey);
      expandedMatchReasons.push({ mapName, key, entryKey });
    });
  };
  const expandArcadeKeyVariants = (key = '') => {
    const normalized = normalizePhrase(key);
    if (!normalized) return [];
    const expanded = new Set([normalized]);
    if (/\barcade\b/.test(normalized)) expanded.add(normalized.replace(/\barcade\b/g, '').replace(/\s+/g, ' ').trim());
    else expanded.add(`${normalized} arcade`.trim());
    return Array.from(expanded).filter(Boolean);
  };
  const buildFamilyAliasKeys = () => {
    const all = [
      lookupKeys.normalizedTitleKey,
      lookupKeys.normalizedNameKey,
      lookupKeys.originalTitleKey,
      ...(lookupKeys.aliasKeys || []),
    ].filter(Boolean);
    return Array.from(new Set(
      expandArcadeKeyVariants(all.join(' '))
        .flatMap((value) => value.split(/\s{2,}|\s*\/\s*/g))
        .map((value) => normalizePhrase(value))
        .filter(Boolean)
    ));
  };

  const normalizedTitleKeys = expandArcadeKeyVariants(lookupKeys.normalizedTitleKey);
  const normalizedNameKeys = expandArcadeKeyVariants(lookupKeys.normalizedNameKey);
  const originalTitleKeys = expandArcadeKeyVariants(lookupKeys.originalTitleKey);
  const aliasKeys = Array.from(new Set((lookupKeys.aliasKeys || []).flatMap((key) => expandArcadeKeyVariants(key))));
  const familyKeys = buildFamilyAliasKeys();
  normalizedTitleKeys.forEach((key) => addFromMap('byNormalizedTitleKey', key));
  normalizedNameKeys.forEach((key) => addFromMap('byNormalizedNameKey', key));
  originalTitleKeys.forEach((key) => addFromMap('byOriginalTitleKey', key));
  aliasKeys.forEach((key) => addFromMap('byAliasKey', key));
  familyKeys.forEach((key) => addFromMap('byAliasKey', key));

  const entries = Array.from(candidateKeys)
    .map((entryKey) => entryByKey.get(entryKey))
    .filter(Boolean)
    .filter((entry) => {
      if (!lookupKeys.normalizedManufacturerKey) return true;
      return !entry.normalizedManufacturerKey || entry.normalizedManufacturerKey === lookupKeys.normalizedManufacturerKey;
    });

  return { entries, expandedMatchReasons };
}

async function fetchRowsByKeys(db, lookupKeys = {}) {
  if (!db) return [];
  const queryValues = Array.from(new Set([
    lookupKeys.normalizedTitleKey,
    lookupKeys.normalizedNameKey,
    lookupKeys.originalTitleKey,
    ...(Array.isArray(lookupKeys.aliasKeys) ? lookupKeys.aliasKeys : []),
  ].filter(Boolean))).slice(0, 20);
  const rows = [];
  for (const value of queryValues) {
    const snap = await db.collection(TRUSTED_MANUAL_CATALOG_COLLECTION)
      .where('allTitleKeys', 'array-contains', value)
      .limit(20)
      .get()
      .catch(() => ({ docs: [] }));
    (snap.docs || []).forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));
  }
  return rows;
}

async function findManualLookupReferenceHints({
  db,
  assetName = '',
  normalizedName = '',
  originalTitle = '',
  manufacturer = '',
  alternateNames = [],
  referenceIndex = null,
  referenceIndexPath = DEFAULT_REFERENCE_INDEX_PATH,
  allowFirestoreFallback = false,
} = {}) {
  const lookupKeys = buildTrustedCatalogLookupKeys({
    assetName,
    normalizedName,
    normalizedTitle: normalizedName || assetName,
    originalTitle: originalTitle || assetName,
    manufacturer,
    alternateNames,
  });

  const title = normalizeString(originalTitle || normalizedName || assetName, 180);
  logReferenceEvent('reference_index_lookup_started', {
    title,
    normalizedManufacturerKey: lookupKeys.normalizedManufacturerKey,
  });

  const index = getReferenceIndex({ referenceIndex, referenceIndexPath });
  const { entries, expandedMatchReasons } = findReferenceEntries(index, lookupKeys);
  if (entries.length) {
    const bestEntry = entries[0];
    logReferenceEvent('reference_index_hit', {
      title,
      entryKey: bestEntry.entryKey,
      candidateEntryCount: entries.length,
      expandedMatchCount: expandedMatchReasons.length,
    });
    return {
      source: 'json_index',
      lookupKeys,
      entryCount: (index.entries || []).length,
      entry: bestEntry,
      hints: {
        ...bestEntry,
        expandedMatchReasons: expandedMatchReasons.slice(0, 20),
        lookupRowsUsed: Number(bestEntry.lookupRowsUsed || 0),
      },
    };
  }

  logReferenceEvent('reference_index_miss', {
    title,
    normalizedManufacturerKey: lookupKeys.normalizedManufacturerKey,
  });

  if (!allowFirestoreFallback || !db) return null;

  const rows = await fetchRowsByKeys(db, lookupKeys);
  if (!rows.length) return null;
  const filtered = rows.filter((row) => {
    const rowManufacturer = normalizePhrase(normalizeManufacturerName(row.manufacturer || ''));
    return !lookupKeys.normalizedManufacturerKey || !rowManufacturer || rowManufacturer === lookupKeys.normalizedManufacturerKey;
  });
  if (!filtered.length) return null;

  const hints = buildReferenceHintsFromRows(filtered);
  return {
    source: 'firestore',
    lookupKeys,
    entryCount: (index.entries || []).length,
    entry: null,
    hints,
  };
}

function __resetReferenceIndexForTests() {
  inMemoryReferenceIndex = null;
}

module.exports = {
  findManualLookupReferenceHints,
  buildReferenceHintsFromRows,
  buildReferenceIndexFromRows,
  __resetReferenceIndexForTests,
};
