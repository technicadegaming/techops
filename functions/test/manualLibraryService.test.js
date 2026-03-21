const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, createManualLibraryId } = require('../src/services/manualLibraryService');

test('normalizeUrl strips fragments for manual-library dedupe', () => {
  assert.equal(normalizeUrl('https://example.com/manual.pdf#page=1'), 'https://example.com/manual.pdf');
});

test('createManualLibraryId remains stable for same manual inputs', () => {
  const a = createManualLibraryId({ normalizedManufacturer: 'raw thrills', canonicalTitle: 'Fast & Furious Arcade', variant: '2 player', sha256: 'abc' });
  const b = createManualLibraryId({ normalizedManufacturer: 'raw thrills', canonicalTitle: 'Fast & Furious Arcade', variant: '2 player', sha256: 'abc' });
  assert.equal(a, b);
});
