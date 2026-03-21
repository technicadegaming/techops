const catalogEntries = require('../data/manualLookupCatalog.json');
const { normalizePhrase, expandArcadeTitleAliases } = require('./arcadeTitleAliasService');

function normalizeCatalogPhrase(value) {
  return normalizePhrase(value)
    .replace(/\bdeluxe\b/g, ' dx ')
    .replace(/\bdx\b/g, ' deluxe ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNameCandidates(values = []) {
  const candidates = new Set();
  expandArcadeTitleAliases(values.flatMap((value) => Array.isArray(value) ? value : [value]))
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .forEach((value) => {
      const normalized = normalizeCatalogPhrase(value);
      if (!normalized) return;
      candidates.add(normalized);
      candidates.add(normalized.replace(/\bii\b/g, ' 2 ').replace(/\biii\b/g, ' 3 ').replace(/\s+/g, ' ').trim());
      candidates.add(normalized.replace(/\bthe\b/g, '').replace(/\s+/g, ' ').trim());
      candidates.add(normalized.replace(/\bdeluxe\b/g, '').replace(/\bdx\b/g, '').replace(/\s+/g, ' ').trim());
      candidates.add(normalized.replace(/\bquick\b/g, 'quik').replace(/\s+/g, ' ').trim());
      candidates.add(normalized.replace(/\bquik\b/g, 'quick').replace(/\s+/g, ' ').trim());
    });
  return Array.from(candidates).filter(Boolean);
}

function getCatalogEntries() {
  return Array.isArray(catalogEntries) ? catalogEntries : [];
}

function getCatalogEntryById(catalogEntryId = '') {
  const wanted = `${catalogEntryId || ''}`.trim();
  if (!wanted) return null;
  return getCatalogEntries().find((entry) => `${entry?.id || ''}`.trim() === wanted) || null;
}

function scoreCatalogEntry(entry, { assetCandidates, manufacturerCandidates }) {
  const entryManufacturerCandidates = buildNameCandidates([entry.manufacturerCanonical || entry.manufacturer, entry.manufacturerAliases]);
  const entryExactCandidates = buildNameCandidates([entry.canonicalTitle || entry.assetName, entry.titleAliases || entry.assetAliases]);
  const entryVariantCandidates = buildNameCandidates([entry.variantHints || entry.variants]);
  const entryFamilyCandidates = entry.allowFamilyFallback ? buildNameCandidates([entry.familyHints || entry.family]) : [];

  const manufacturerExact = manufacturerCandidates.some((candidate) => entryManufacturerCandidates.includes(candidate));
  if (!manufacturerExact) return null;

  const assetExact = assetCandidates.some((candidate) => entryExactCandidates.includes(candidate));
  const assetVariant = !assetExact && assetCandidates.some((candidate) => entryVariantCandidates.includes(candidate));
  const assetFamily = !assetExact && !assetVariant && entry.allowFamilyFallback
    && assetCandidates.some((candidate) => entryFamilyCandidates.includes(candidate));

  if (!assetExact && !assetVariant && !assetFamily) return null;

  const matchStatus = assetExact ? 'catalog_exact' : (assetVariant ? 'catalog_variant' : 'catalog_family');
  const score = assetExact ? 100 : (assetVariant ? 96 : 88);

  return {
    entry,
    score,
    matchStatus,
    assetExact,
    assetVariant,
    assetFamily,
    manufacturerExact
  };
}

function buildCatalogSuggestion(entry, match) {
  const common = {
    title: entry.canonicalTitle || entry.assetName,
    manufacturer: entry.manufacturerCanonical || entry.manufacturer,
    matchedManufacturer: normalizeCatalogPhrase(entry.manufacturerCanonical || entry.manufacturer),
    sourceType: /official/.test(entry.linkType || '') ? 'manufacturer' : (/authorized|distributor/.test(entry.linkType || '') ? 'distributor' : 'other'),
    linkType: entry.linkType || 'official_pdf',
    trustTier: entry.trustTier || '',
    manualType: entry.manualType || '',
    family: entry.family || entry.canonicalTitle || entry.assetName || '',
    cabinetVariant: Array.isArray(entry.variantHints) ? entry.variantHints[0] || '' : '',
    matchStatus: match.matchStatus || entry.matchStatus || 'catalog_exact',
    confidence: Number(entry.confidence || 0.95),
    matchScore: match.score,
    exactTitleMatch: true,
    exactManualMatch: true,
    trustedSource: true,
    isOfficial: /official/.test(entry.linkType || ''),
    verified: true,
    verificationStatus: 'seed_verified',
    verificationMetadata: entry.verification || { seededFromWorkbook: true },
    lookupMethod: entry.lookupMethod || 'catalog_curated',
    notes: entry.notes || '',
    catalogEntryId: entry.id || ''
  };

  const documentationSuggestions = [
    entry.manualPdfUrl ? {
      ...common,
      title: `${entry.canonicalTitle || entry.assetName} manual`,
      url: entry.manualPdfUrl,
      alternateManualUrl: entry.alternateManualUrl || '',
      sourcePageUrl: entry.sourcePageUrl || ''
    } : null,
    entry.alternateManualUrl ? {
      ...common,
      title: `${entry.canonicalTitle || entry.assetName} alternate manual`,
      url: entry.alternateManualUrl,
      primaryManualUrl: entry.manualPdfUrl || '',
      sourcePageUrl: entry.sourcePageUrl || '',
      linkType: 'alternate_manual',
      matchScore: Math.max(84, match.score - 4)
    } : null
  ].filter(Boolean);

  const supportResources = entry.sourcePageUrl ? [{
    title: `${entry.assetName} source page`,
    label: `${entry.assetName} source page`,
    url: entry.sourcePageUrl,
    sourceType: 'support',
    linkType: 'source_page',
    matchStatus: common.matchStatus,
    confidence: common.confidence,
    matchScore: Math.max(80, match.score - 6),
    exactTitleMatch: true,
    exactManualMatch: false,
    trustedSource: true,
    isOfficial: /official/.test(entry.linkType || ''),
    verified: true,
    verificationStatus: 'seed_verified',
    verificationMetadata: entry.verification || { seededFromWorkbook: true },
    lookupMethod: common.lookupMethod,
    notes: common.notes,
    catalogEntryId: common.catalogEntryId
  }] : [];

  return {
    entry,
    matchStatus: common.matchStatus,
    confidence: common.confidence,
    matchedManufacturer: common.matchedManufacturer,
    documentationSuggestions,
    supportResources,
    notes: common.notes,
    lookupMethod: common.lookupMethod,
    catalogEntryId: common.catalogEntryId
  };
}

function findCatalogManualMatch({ assetName = '', normalizedName = '', manufacturer = '', manufacturerProfile = null, alternateNames = [] }) {
  const assetCandidates = buildNameCandidates([assetName, normalizedName, alternateNames]);
  const manufacturerCandidates = buildNameCandidates([
    manufacturer,
    manufacturerProfile?.key,
    manufacturerProfile?.aliases || []
  ]);

  if (!assetCandidates.length || !manufacturerCandidates.length) return null;

  const ranked = getCatalogEntries()
    .map((entry) => scoreCatalogEntry(entry, { assetCandidates, manufacturerCandidates }))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || `${a.entry.id || ''}`.localeCompare(`${b.entry.id || ''}`));

  if (!ranked.length) return null;
  return buildCatalogSuggestion(ranked[0].entry, ranked[0]);
}

function findCatalogManualMatchByEntryId(catalogEntryId = '') {
  const entry = getCatalogEntryById(catalogEntryId);
  if (!entry) return null;
  return buildCatalogSuggestion(entry, {
    score: 100,
    matchStatus: 'catalog_exact'
  });
}

module.exports = {
  getCatalogEntries,
  getCatalogEntryById,
  buildNameCandidates,
  findCatalogManualMatch,
  findCatalogManualMatchByEntryId
};
