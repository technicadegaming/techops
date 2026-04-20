const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findManualLookupReferenceHints,
  __resetReferenceIndexForTests,
} = require('../src/services/manualLookupReferenceService');

test('findManualLookupReferenceHints resolves json index entries without Firestore dependency', async () => {
  __resetReferenceIndexForTests();
  const referenceIndex = {
    generatedAt: new Date().toISOString(),
    referenceOnly: true,
    notTrustedCatalog: true,
    entries: [
      {
        entryKey: 'raw thrills::jurassic park arcade',
        normalizedTitleKey: 'jurassic park arcade',
        normalizedNameKey: 'jurassic park arcade',
        originalTitleKey: 'jurassic park arcade',
        aliasKeys: ['jurassic park'],
        normalizedManufacturerKey: 'raw thrills',
        aliases: ['Jurassic Park'],
        familyTitles: ['Jurassic Park Arcade'],
        likelySlugPatterns: ['jurassic-park-arcade'],
        likelyManualFilenamePatterns: ['jurassic-park-arcade-manual.pdf'],
        preferredManufacturerDomains: ['rawthrills.com'],
        referenceRowCandidates: [{
          sourceRowId: 'jp-1',
          assetName: 'Jurassic Park Arcade',
          manufacturer: 'Raw Thrills',
          originalTitle: 'Jurassic Park Arcade',
          normalizedTitle: 'Jurassic Park Arcade',
          alternateNames: ['Jurassic Park'],
          manualUrl: 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-manual.pdf',
          manualSourceUrl: 'https://rawthrills.com/games/jurassic-park-arcade/',
          supportUrl: 'https://rawthrills.com/games/jurassic-park-arcade-support/',
          matchType: 'manual_page_with_download',
          manualReady: false,
          reviewRequired: true,
          matchConfidence: 0.92,
        }],
      },
    ],
    byNormalizedTitleKey: { 'jurassic park arcade': ['raw thrills::jurassic park arcade'] },
    byNormalizedNameKey: { 'jurassic park arcade': ['raw thrills::jurassic park arcade'] },
    byOriginalTitleKey: { 'jurassic park arcade': ['raw thrills::jurassic park arcade'] },
    byAliasKey: { 'jurassic park': ['raw thrills::jurassic park arcade'] },
    byNormalizedManufacturerKey: { 'raw thrills': ['raw thrills::jurassic park arcade'] },
    entryCount: 1,
  };

  const lookup = await findManualLookupReferenceHints({
    assetName: 'Jurassic Park Arcade',
    normalizedName: 'Jurassic Park Arcade',
    originalTitle: 'Jurassic Park Arcade',
    manufacturer: 'Raw Thrills',
    alternateNames: ['Jurassic Park'],
    referenceIndex,
  });

  assert.equal(lookup.source, 'json_index');
  assert.equal(lookup.hints.entryKey, 'raw thrills::jurassic park arcade');
  assert.equal(lookup.hints.preferredManufacturerDomains.includes('rawthrills.com'), true);
  assert.equal(Array.isArray(lookup.hints.referenceRowCandidates), true);
  assert.equal(lookup.hints.referenceRowCandidates[0].manualUrl.includes('jurassic-park-arcade-manual.pdf'), true);
  assert.equal(lookup.hints.referenceRowCandidates[0].manualSourceUrl.includes('/games/jurassic-park-arcade/'), true);
  assert.equal(lookup.hints.referenceRowCandidates[0].supportUrl.includes('/games/jurassic-park-arcade-support/'), true);
});

test('findManualLookupReferenceHints returns miss when no json entry exists', async () => {
  __resetReferenceIndexForTests();
  const lookup = await findManualLookupReferenceHints({
    assetName: 'Unknown Racer',
    normalizedName: 'Unknown Racer',
    originalTitle: 'Unknown Racer',
    manufacturer: 'Unknown',
    referenceIndex: {
      entries: [],
      byNormalizedTitleKey: {},
      byNormalizedNameKey: {},
      byOriginalTitleKey: {},
      byAliasKey: {},
    },
  });

  assert.equal(lookup, null);
});
