const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WORKBOOK_PATH = path.resolve(__dirname, '../data/manualLookupWorkbookSeed.json');

function normalizeText(value, max = 240) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeList(value, max = 24) {
  const items = Array.isArray(value) ? value : (`${value || ''}`.trim() ? [`${value}`] : []);
  return Array.from(new Set(items.map((item) => normalizeText(item, 180)).filter(Boolean))).slice(0, max);
}

function slugify(value) {
  return normalizeText(value, 180)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'manual-entry';
}

function loadWorkbookSeed(filePath = DEFAULT_WORKBOOK_PATH) {
  const absolute = path.resolve(filePath);
  const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  return {
    sourcePath: absolute,
    manualLookupMaster: Array.isArray(parsed.manual_lookup_master) ? parsed.manual_lookup_master : [],
    searchPlaybook: parsed.search_playbook || {}
  };
}

function normalizeWorkbookRow(row = {}, index = 0) {
  const canonicalTitle = normalizeText(row.canonicalTitle || row.assetName || row.title, 180);
  const manufacturerCanonical = normalizeText(row.manufacturerCanonical || row.manufacturer || '', 140);
  const titleAliases = normalizeList(row.titleAliases || row.assetAliases || row.alternateTitles);
  const manufacturerAliases = normalizeList(row.manufacturerAliases);
  const variantHints = normalizeList(row.variantHints || row.variants);
  const familyHints = normalizeList(row.familyHints || row.family || row.families);
  const sourcePageUrl = normalizeText(row.sourcePageUrl, 2000);
  const manualPdfUrl = normalizeText(row.manualPdfUrl, 2000);
  const alternateManualUrl = normalizeText(row.alternateManualUrl, 2000);
  const linkType = normalizeText(row.linkType || (manualPdfUrl ? 'official_pdf' : 'source_page'), 40).toLowerCase();
  const trustTier = normalizeText(row.trustTier || (linkType.includes('official') ? 'official' : 'authorized_distributor'), 40).toLowerCase();
  const id = normalizeText(row.id, 120) || `${slugify(manufacturerCanonical)}-${slugify(canonicalTitle)}-${index + 1}`;
  const family = familyHints[0] || canonicalTitle;
  const allowFamilyFallback = familyHints.some((hint) => normalizeText(hint).toLowerCase() !== canonicalTitle.toLowerCase())
    || titleAliases.some((alias) => normalizeText(alias).toLowerCase() !== canonicalTitle.toLowerCase());

  return {
    id,
    canonicalTitle,
    titleAliases,
    manufacturerCanonical,
    manufacturerAliases,
    manualPdfUrl,
    alternateManualUrl,
    sourcePageUrl,
    linkType,
    matchStatus: normalizeText(row.matchStatus || 'catalog_exact', 40).toLowerCase(),
    confidence: Number(row.confidence || 0.8),
    notes: normalizeText(row.notes, 600),
    lookupMethod: normalizeText(row.lookupMethod || 'workbook_seed', 80),
    variantHints,
    familyHints,
    trustTier,
    manualType: normalizeText(row.manualType || '', 60).toLowerCase(),
    family,
    allowFamilyFallback,
    assetName: canonicalTitle,
    assetAliases: titleAliases,
    manufacturer: manufacturerCanonical,
    variants: variantHints,
    verification: {
      seededFromWorkbook: true,
      hasDirectManual: !!manualPdfUrl,
      hasAlternateManual: !!alternateManualUrl,
      hasSourcePage: !!sourcePageUrl,
      sourcePath: 'manual_lookup_master'
    }
  };
}

function buildCuratedCatalog({ manualLookupMaster = [], searchPlaybook = {} }) {
  const entries = manualLookupMaster.map((row, index) => normalizeWorkbookRow(row, index));
  return {
    generatedAt: new Date().toISOString(),
    searchPlaybook,
    entries
  };
}

module.exports = {
  DEFAULT_WORKBOOK_PATH,
  loadWorkbookSeed,
  normalizeWorkbookRow,
  buildCuratedCatalog
};
