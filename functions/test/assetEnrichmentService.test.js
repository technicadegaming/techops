const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDocumentationSuggestions,
  detectDeadPageText,
  verifySuggestionUrl,
  verifyDocumentationSuggestions,
  getManufacturerProfile,
  buildFollowupQuestion
} = require('../src/services/assetEnrichmentService');

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

test('detectDeadPageText identifies common not-found/manual-missing responses', () => {
  assert.equal(detectDeadPageText('Manual Not Found for this model.'), true);
  assert.equal(detectDeadPageText('Welcome to the official operator manual.'), false);
});

test('verifySuggestionUrl marks dead pages and verified links', async () => {
  const deadFetch = async () => ({
    ok: false,
    status: 404,
    text: async () => 'page not found'
  });
  const deadResult = await verifySuggestionUrl('https://example.com/dead-manual', deadFetch);
  assert.equal(deadResult.verified, false);
  assert.equal(deadResult.deadPage, true);
  assert.equal(deadResult.httpStatus, 404);

  const goodFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => 'Operator manual for Cool Game Deluxe'
  });
  const goodResult = await verifySuggestionUrl('https://example.com/manual', goodFetch);
  assert.equal(goodResult.verified, true);
  assert.equal(goodResult.deadPage, false);
  assert.equal(goodResult.httpStatus, 200);
});

test('verifyDocumentationSuggestions sorts verified links first and preserves existing metadata', async () => {
  const fetchMock = async (url, options = {}) => {
    if (options.method === 'HEAD') {
      return { ok: true, status: 200, text: async () => '' };
    }
    if (url.includes('bad')) {
      return { ok: false, status: 404, text: async () => 'manual not found' };
    }
    return { ok: true, status: 200, text: async () => 'service manual' };
  };

  const verified = await verifyDocumentationSuggestions([
    { url: 'https://example.com/bad', matchScore: 85, isOfficial: true },
    { url: 'https://example.com/good', matchScore: 70, isOfficial: false }
  ], fetchMock);

  assert.equal(verified.length, 2);
  assert.equal(verified[0].url, 'https://example.com/good');
  assert.equal(verified[0].verified, true);
  assert.equal(verified[1].verified, false);
  assert.equal(verified[1].deadPage, true);
});

test('manufacturer-aware scoring prefers trusted manufacturer ecosystem links', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Raw Thrills support manual index', url: 'https://rawthrills.com/support/manuals', sourceType: 'manufacturer' },
      { title: 'Arcade game page', url: 'https://genericdocs.example.com/manual/fast-and-furious', sourceType: 'other' }
    ],
    confidence: 0.66,
    asset: { name: 'Fast and Furious Arcade', manufacturer: 'Raw Thrills' },
    normalizedName: 'Fast and Furious Arcade',
    manufacturerSuggestion: 'Raw Thrills'
  });

  assert.equal(suggestions[0].url, 'https://rawthrills.com/support/manuals');
  assert.equal(suggestions[0].matchedManufacturer, 'raw thrills');
  assert.ok(suggestions[0].reason.includes('manufacturer_trusted_source_match'));
});

test('getManufacturerProfile resolves aliases for known FEC manufacturers', () => {
  const profile = getManufacturerProfile('Baytek', 'Monopoly Roll-N-Go');
  assert.equal(profile?.key, 'bay tek');
  assert.ok(profile?.sourceTokens.includes('baytekent.com'));
});

test('buildFollowupQuestion asks one actionable arcade-specific question', () => {
  const noUrlPrompt = buildFollowupQuestion({
    parsedQuestion: 'Please share exact manual URL',
    profile: { categories: ['redemption'] },
    likelyCategory: 'ticket redemption'
  });
  assert.match(noUrlPrompt, /ticket\/redemption/i);

  const failedVerificationPrompt = buildFollowupQuestion({
    parsedQuestion: '',
    profile: { categories: ['video'] },
    likelyCategory: 'video',
    hasOnlyFailedVerification: true
  });
  assert.match(failedVerificationPrompt, /nameplate/i);
});


test('low-confidence normalization does not crash and returns bounded scores', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Support', url: 'https://rawthrills.com/support', sourceType: 'manufacturer' },
      { title: 'Broken', url: 'notaurl', sourceType: 'other' }
    ],
    confidence: 0.01,
    asset: { name: 'Unknown Racer', manufacturer: '' },
    normalizedName: 'Unknown Racer',
    manufacturerSuggestion: ''
  });

  assert.ok(Array.isArray(suggestions));
  assert.ok(suggestions.every((row) => row.matchScore >= 35 && row.matchScore <= 100));
});

test('support resources ranking favors official support pages', () => {
  const support = normalizeDocumentationSuggestions({
    links: [
      { label: 'Official support', url: 'https://baytekent.com/support', resourceType: 'support' },
      { label: 'Community thread', url: 'https://reddit.com/r/arcade/comments/x', resourceType: 'other' }
    ],
    confidence: 0.5,
    asset: { name: 'Monopoly Roll N Go', manufacturer: 'Bay Tek' },
    normalizedName: 'Monopoly Roll N Go',
    manufacturerSuggestion: 'Bay Tek',
    kind: 'support'
  });
  assert.ok(support.length >= 1);
  assert.equal(support[0].url, 'https://baytekent.com/support');
});
