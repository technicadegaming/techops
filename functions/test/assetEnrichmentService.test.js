const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDocumentationSuggestions } = require('../src/services/assetEnrichmentService');

test('normalizeDocumentationSuggestions filters weak and malformed links and ranks strong matches first', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Cool game operator manual', url: 'https://www.manufacturer.com/manuals/cool-game-deluxe', sourceType: 'manufacturer' },
      { title: 'Home', url: 'https://www.manufacturer.com/', sourceType: 'manufacturer' },
      { title: 'Random forum thread', url: 'https://reddit.com/r/arcade/comments/abc', sourceType: 'other' },
      { title: 'Unrelated model service manual', url: 'https://trusted-manuals.example/service/other-9000', sourceType: 'manual_library' },
      { title: 'Bad url', url: 'notaurl', sourceType: 'other' }
    ],
    confidence: 0.72,
    asset: { name: 'Cool Game Deluxe 2000', manufacturer: 'Manufacturer' },
    normalizedName: 'Cool Game Deluxe 2000',
    manufacturerSuggestion: 'Manufacturer'
  });

  assert.ok(suggestions.length >= 1);
  assert.equal(suggestions[0].url, 'https://www.manufacturer.com/manuals/cool-game-deluxe');
  assert.ok(suggestions.every((row) => /^https?:\/\//.test(row.url)));
  assert.ok(suggestions.every((row) => Number(row.matchScore) >= 35));
  assert.ok(suggestions.some((row) => row.isOfficial));
});
