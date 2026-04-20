const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReferenceHintsFromRows } = require('../src/services/manualLookupReferenceService');

test('buildReferenceHintsFromRows creates reference-only hint payload', () => {
  const hints = buildReferenceHintsFromRows([
    {
      manufacturer: 'Raw Thrills',
      normalizedTitle: 'Jurassic Park Arcade',
      alternateNames: ['Jurassic Park'],
      manualUrl: 'https://rawthrills.com/wp-content/uploads/JP-Manual.pdf',
      supportUrl: 'https://rawthrills.com/games/jurassic-park-arcade/'
    }
  ]);

  assert.equal(hints.referenceOnly, true);
  assert.equal(hints.notTrustedCatalog, true);
  assert.equal(hints.aliases.includes('Jurassic Park'), true);
  assert.equal(hints.preferredManufacturerDomains.includes('rawthrills.com'), true);
  assert.equal(hints.likelyManualFilenamePatterns.some((value) => /manual\.pdf$/i.test(value)), true);
});
