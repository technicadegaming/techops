const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCatalogEntries,
  buildNameCandidates,
  findCatalogManualMatch
} = require('../src/services/manualLookupCatalogService');
const { discoverManualDocumentation } = require('../src/services/manualDiscoveryService');
const { getManufacturerProfile } = require('../src/services/assetEnrichmentService');

test('catalog exposes workbook-friendly manual lookup structure', () => {
  const entries = getCatalogEntries();
  assert.ok(entries.length >= 1);
  assert.ok(entries[0].manualPdfUrl);
  assert.ok(Object.hasOwn(entries[0], 'alternateManualUrl'));
  assert.ok(Object.hasOwn(entries[0], 'sourcePageUrl'));
  assert.ok(Object.hasOwn(entries[0], 'linkType'));
  assert.ok(Object.hasOwn(entries[0], 'matchStatus'));
  assert.ok(Object.hasOwn(entries[0], 'confidence'));
  assert.ok(Object.hasOwn(entries[0], 'notes'));
  assert.ok(Object.hasOwn(entries[0], 'lookupMethod'));
});

test('catalog matches exact asset/manufacturer pairs first', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const match = findCatalogManualMatch({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    alternateNames: []
  });

  assert.ok(match);
  assert.equal(match.documentationSuggestions[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(match.documentationSuggestions[0].matchStatus, 'catalog_exact');
  assert.equal(match.supportResources[0].url, 'https://www.betson.com/amusement-products/quik-drop/');
  assert.equal(match.documentationSuggestions[0].sourceType, 'distributor');
  assert.equal(match.documentationSuggestions[0].lookupMethod, 'catalog_curated_distributor_pdf');
});

test('catalog matches alternate asset names and title normalization aliases', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const match = findCatalogManualMatch({
    assetName: 'Quick Drop',
    normalizedName: 'Quick Drop Deluxe',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    alternateNames: ['Quik Drop']
  });

  assert.ok(match);
  assert.equal(match.documentationSuggestions[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
});

test('catalog matches manufacturer aliases', () => {
  const profile = getManufacturerProfile('Baytek', 'Quik Drop');
  const match = findCatalogManualMatch({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Baytek',
    manufacturerProfile: profile,
    alternateNames: []
  });

  assert.ok(match);
  assert.equal(match.matchedManufacturer, 'bay tek games');
  assert.equal(match.documentationSuggestions[0].catalogEntryId, 'bay-tek-quik-drop');
});

test('Quik Drop known-good catalog match returns direct manuals instead of generic support-only results', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const match = findCatalogManualMatch({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    alternateNames: []
  });

  assert.deepEqual(match.documentationSuggestions.map((entry) => entry.url), ['https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf']);
  assert.equal(match.supportResources.every((entry) => !/\/support\/?$/.test(new URL(entry.url).pathname) || /quik-drop/.test(entry.url)), true);
});

test('fallback discovery still works when catalog has no match', async () => {
  const profile = getManufacturerProfile('ICE', 'Air FX');
  const catalogMatch = findCatalogManualMatch({
    assetName: 'Air FX',
    normalizedName: 'Air FX',
    manufacturer: 'ICE',
    manufacturerProfile: profile,
    alternateNames: []
  });
  assert.equal(catalogMatch, null);

  const result = await discoverManualDocumentation({
    assetName: 'Air FX',
    normalizedName: 'Air FX',
    manufacturer: 'ICE',
    manufacturerProfile: profile,
    searchProvider: async () => [],
    fetchImpl: async (url) => {
      if (url === 'https://support.icegame.com/manuals/air-fx-service-manual.pdf') {
        return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
      }
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    },
    logger: { log: () => {} }
  });

  assert.equal(result.documentationLinks[0]?.url, 'https://support.icegame.com/manuals/air-fx-service-manual.pdf');
});

test('buildNameCandidates normalizes common marketing-name variants deterministically', () => {
  const candidates = buildNameCandidates(['Quick Drop DX']);
  assert.ok(candidates.includes('quick drop deluxe'));
  assert.ok(candidates.includes('quik drop deluxe'));
});
