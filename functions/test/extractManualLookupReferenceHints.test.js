const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReferenceHintsFromRows,
  buildReferenceIndexFromRows,
} = require('../src/services/manualLookupReferenceService');

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

test('buildReferenceIndexFromRows creates distinct keyed entries per title/manufacturer family', () => {
  const index = buildReferenceIndexFromRows([
    {
      id: 'jp-row',
      manufacturer: 'Raw Thrills',
      normalizedTitle: 'Jurassic Park Arcade',
      normalizedName: 'Jurassic Park Arcade',
      originalTitle: 'Jurassic Park Arcade',
      alternateNames: ['Jurassic Park'],
      manualUrl: 'https://rawthrills.com/wp-content/uploads/jurassic-park-manual.pdf',
      supportUrl: 'https://rawthrills.com/games/jurassic-park-arcade/',
    },
    {
      id: 'hs-row',
      manufacturer: 'LAI Games',
      normalizedTitle: 'HYPERshoot',
      normalizedName: 'HYPERshoot',
      originalTitle: 'HYPERshoot',
      alternateNames: ['Hyper Shoot'],
      manualUrl: 'https://laigames.com/wp-content/uploads/hypershoot-operator-manual.pdf',
      supportUrl: 'https://laigames.com/games/hypershoot/support/',
    },
  ]);

  assert.equal(Array.isArray(index.entries), true);
  assert.equal(index.entries.length, 2);
  assert.equal(index.entryCount, 2);

  const rawEntry = index.entries.find((entry) => entry.normalizedManufacturerKey === 'raw thrills');
  const laiEntry = index.entries.find((entry) => entry.normalizedManufacturerKey === 'lai games');

  assert.equal(!!rawEntry, true);
  assert.equal(!!laiEntry, true);
  assert.equal(rawEntry.aliases.includes('Jurassic Park'), true);
  assert.equal(laiEntry.aliases.includes('Hyper Shoot'), true);
  assert.equal(rawEntry.preferredManufacturerDomains.includes('rawthrills.com'), true);
  assert.equal(laiEntry.preferredManufacturerDomains.includes('laigames.com'), true);
  assert.equal(Array.isArray(index.byNormalizedTitleKey[rawEntry.normalizedTitleKey]), true);
  assert.equal(Array.isArray(index.byNormalizedTitleKey[laiEntry.normalizedTitleKey]), true);
  assert.notEqual(rawEntry.entryKey, laiEntry.entryKey);
});
