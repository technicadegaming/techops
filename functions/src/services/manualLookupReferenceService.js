const { normalizePhrase, normalizeManufacturerName } = require('./arcadeTitleAliasService');
const { buildTrustedCatalogLookupKeys } = require('./trustedManualCatalogService');

const TRUSTED_MANUAL_CATALOG_COLLECTION = 'trustedManualCatalog';

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

function buildReferenceHintsFromRows(rows = []) {
  const canonicalTitleHints = new Set();
  const normalizedTitleHints = new Set();
  const aliases = new Set();
  const familyTitles = new Set();
  const manufacturerDomains = new Set();
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
  };
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
} = {}) {
  if (!db) return null;
  const lookupKeys = buildTrustedCatalogLookupKeys({
    assetName,
    normalizedName,
    normalizedTitle: normalizedName || assetName,
    originalTitle: originalTitle || assetName,
    manufacturer,
    alternateNames,
  });

  const rows = await fetchRowsByKeys(db, lookupKeys);
  if (!rows.length) return null;
  const normalizedManufacturer = normalizePhrase(normalizeManufacturerName(manufacturer || ''));
  const deduped = new Map();
  rows.forEach((row) => {
    if (!row?.id || deduped.has(row.id)) return;
    const rowManufacturer = normalizePhrase(normalizeManufacturerName(row.manufacturer || ''));
    if (normalizedManufacturer && rowManufacturer && rowManufacturer !== normalizedManufacturer) return;
    deduped.set(row.id, row);
  });
  if (!deduped.size) return null;

  return {
    rows: Array.from(deduped.values()).slice(0, 8),
    lookupKeys,
    hints: buildReferenceHintsFromRows(Array.from(deduped.values())),
  };
}

module.exports = {
  findManualLookupReferenceHints,
  buildReferenceHintsFromRows,
};
