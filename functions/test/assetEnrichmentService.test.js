const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDocumentationSuggestions,
  detectDeadPageText,
  verifySuggestionUrl,
  verifyDocumentationSuggestions,
  getDocumentationSuggestionRank,
  isPreservableVerifiedManualSuggestion,
  mergeDocumentationSuggestions,
  collectReusableVerifiedManuals,
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
  assert.ok(suggestions.every((row) => Number(row.matchScore) >= 48));
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

test('verifyDocumentationSuggestions keeps verification metadata and dead-page suppression', async () => {
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
  const deadRow = verified.find((row) => row.url.includes('bad'));
  const goodRow = verified.find((row) => row.url.includes('good'));
  assert.equal(goodRow.verified, false);
  assert.equal(deadRow.verified, false);
  assert.equal(deadRow.deadPage, true);
});

test('manufacturer-aware scoring prefers trusted manufacturer ecosystem links', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Raw Thrills Fast and Furious Arcade Operator Manual', url: 'https://rawthrills.com/support/fast-and-furious-arcade-operator-manual.pdf', sourceType: 'manufacturer' },
      { title: 'Arcade game page', url: 'https://genericdocs.example.com/manual/fast-and-furious', sourceType: 'other' }
    ],
    confidence: 0.66,
    asset: { name: 'Fast and Furious Arcade', manufacturer: 'Raw Thrills' },
    normalizedName: 'Fast and Furious Arcade',
    manufacturerSuggestion: 'Raw Thrills'
  });

  assert.equal(suggestions[0].url, 'https://rawthrills.com/support/fast-and-furious-arcade-operator-manual.pdf');
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
  assert.ok(suggestions.every((row) => row.matchScore >= 48 && row.matchScore <= 100));
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

test('exact manual outranks generic manufacturer manual library page', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Bay Tek Sink It Manuals', url: 'https://baytekent.com/support/manuals/sink-it-operator-manual.pdf', sourceType: 'manufacturer' },
      { title: 'Bay Tek Games Manual Library', url: 'https://baytekent.com/support/manual-library', sourceType: 'manufacturer' }
    ],
    confidence: 0.71,
    asset: { name: 'Sink It', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Sink It',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions[0].url, 'https://baytekent.com/support/manuals/sink-it-operator-manual.pdf');
  assert.equal(suggestions[0].exactManualMatch, true);
});

test('exact title official support/product page outranks generic distributor listing', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Sink It Support', url: 'https://baytekent.com/support/sink-it', sourceType: 'support' },
      { title: 'Bay Tek Products', url: 'https://www.betson.com/amusement-products/bay-tek-games/', sourceType: 'distributor' }
    ],
    confidence: 0.74,
    asset: { name: 'Sink It', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Sink It',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions[0].url, 'https://baytekent.com/support/sink-it');
  assert.equal(suggestions[0].exactTitleMatch, true);
});

test('short/common title does not overmatch weak generic results', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Pro Product Catalog', url: 'https://genericdocs.example.com/products/pro', sourceType: 'other' },
      { title: 'Bay Tek Pro Operator Manual', url: 'https://baytekent.com/support/manuals/pro-operator-manual.pdf', sourceType: 'manufacturer' }
    ],
    confidence: 0.62,
    asset: { name: 'Pro', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Pro',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions[0].url, 'https://baytekent.com/support/manuals/pro-operator-manual.pdf');
});

test('official generic page remains fallback but not top exact-doc result', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Sink It Service Manual', url: 'https://baytekent.com/support/sink-it-service-manual.pdf', sourceType: 'manufacturer' },
      { title: 'Bay Tek Home', url: 'https://baytekent.com/', sourceType: 'manufacturer' }
    ],
    confidence: 0.76,
    asset: { name: 'Sink It', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Sink It',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions[0].url, 'https://baytekent.com/support/sink-it-service-manual.pdf');
  assert.equal(suggestions.some((row) => row.url === 'https://baytekent.com/'), false);
});

test('conservative docs_found threshold signals exact-title requirement', () => {
  const generic = normalizeDocumentationSuggestions({
    links: [
      { title: 'Bay Tek Manual Library', url: 'https://baytekent.com/support/manual-library', sourceType: 'manufacturer' }
    ],
    confidence: 0.82,
    asset: { name: 'Sink It', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Sink It',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(generic.length, 0);
});


test('manufacturer alias + exact title is required for manual-library suggestions', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Bay Tek Monopoly Roll-N-Go Operator Manual', url: 'https://archive.org/details/bay-tek-monopoly-roll-n-go-operator-manual', sourceType: 'manual_library' },
      { title: 'Generic Bay Tek Manual Library', url: 'https://archive.org/details/baytek-manuals', sourceType: 'manual_library' }
    ],
    confidence: 0.8,
    asset: { name: 'Monopoly Roll-N-Go', manufacturer: 'Baytek' },
    normalizedName: 'Monopoly Roll-N-Go',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].exactTitleMatch, true);
});

test('detectDeadPageText recognizes soft-404 copy', () => {
  assert.equal(detectDeadPageText('Sorry, the page you are looking for cannot be found.'), true);
});

test('verifyDocumentationSuggestions suppresses verified-but-weak title matches', async () => {
  const fetchMock = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    url: 'https://example.com/manual-index',
    text: async () => 'manual index'
  });

  const verified = await verifyDocumentationSuggestions([
    { url: 'https://example.com/manual-index', matchScore: 90, exactTitleMatch: false, exactManualMatch: false, isOfficial: true },
    { url: 'https://example.com/sink-it-service-manual.pdf', matchScore: 88, exactTitleMatch: true, exactManualMatch: true, isOfficial: true }
  ], fetchMock);

  assert.equal(verified[0].url, 'https://example.com/sink-it-service-manual.pdf');
  assert.equal(verified[0].verified, true);
  assert.equal(verified[1].verified, false);
});

test('verified direct pdf outranks verified manual-library html pages', async () => {
  const fetchMock = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => (url.endsWith('.pdf') ? 'application/pdf' : 'text/html') },
    url,
    text: async () => 'operator manual'
  });

  const verified = await verifyDocumentationSuggestions([
    {
      url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
      sourceType: 'distributor',
      matchScore: 92,
      exactTitleMatch: true,
      exactManualMatch: true,
      isLikelyManual: true
    },
    {
      url: 'https://www.manualslib.com/manual/999999/Quik-Drop.html',
      sourceType: 'manual_library',
      matchScore: 96,
      exactTitleMatch: true,
      exactManualMatch: true
    }
  ], fetchMock);

  assert.equal(verified[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(getDocumentationSuggestionRank(verified[0]) < getDocumentationSuggestionRank(verified[1]), true);
});


test('bay tek preferred parts host outranks generic manual-library and distributor results for quik drop', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Quik Drop Manual', url: 'https://parts.baytekent.com/quik-drop-manual.pdf', sourceType: 'parts' },
      { title: 'Bay Tek Quik Drop Manual', url: 'https://www.betson.com/amusement-products/quik-drop-manual/', sourceType: 'distributor' },
      { title: 'Quik Drop Operator Manual', url: 'https://archive.org/details/quik-drop-operator-manual', sourceType: 'manual_library' }
    ],
    confidence: 0.83,
    asset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions[0].url, 'https://parts.baytekent.com/quik-drop-manual.pdf');
  assert.equal(suggestions[0].sourceTrustReason, 'manufacturer_preferred_source_match');
  assert.equal(suggestions[0].exactManualMatch, true);
});

test('bay tek manufacturer profile exposes preferred and low-trust sources', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  assert.deepEqual(profile?.preferredSourceTokens, ['parts.baytekent.com', 'baytekent.com']);
  assert.deepEqual(profile?.lowTrustSourceTokens, ['betson.com']);
});

test('ice and raw thrills manufacturer profiles expose official-domain-first preferences', () => {
  const iceProfile = getManufacturerProfile('ICE', 'Air FX');
  const rawThrillsProfile = getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade');
  assert.deepEqual(iceProfile?.preferredSourceTokens, ['support.icegame.com', 'icegame.com']);
  assert.deepEqual(rawThrillsProfile?.preferredSourceTokens, ['rawthrills.com']);
});

test('generic distributor and manual-library results are demoted without exact-title evidence', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Bay Tek Redemption Manuals', url: 'https://archive.org/details/baytek-redemption-manuals', sourceType: 'manual_library' },
      { title: 'Bay Tek Games Catalog', url: 'https://www.betson.com/amusement-products/bay-tek-games/', sourceType: 'distributor' },
      { title: 'Quik Drop Parts Manual', url: 'https://parts.baytekent.com/quik-drop-parts-manual.pdf', sourceType: 'parts' }
    ],
    confidence: 0.79,
    asset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].url, 'https://parts.baytekent.com/quik-drop-parts-manual.pdf');
});

test('betson-like pages stay weak unless they are the exact machine manual', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Bay Tek Games', url: 'https://www.betson.com/amusement-products/bay-tek-games/', sourceType: 'distributor' },
      { title: 'Quik Drop Operator Manual PDF', url: 'https://www.betson.com/amusement-products/quik-drop-operator-manual.pdf', sourceType: 'distributor' }
    ],
    confidence: 0.77,
    asset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].url, 'https://www.betson.com/amusement-products/quik-drop-operator-manual.pdf');
  assert.ok(suggestions[0].reason.includes('exact_title_manual_match'));
  assert.equal(suggestions[0].sourceType, 'distributor');
});

test('quik drop betson direct pdf beats manualslib and all-guidesbox style pages', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Quik Drop Service Manual PDF', url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf', sourceType: 'distributor' },
      { title: 'Quik Drop Manual', url: 'https://www.manualslib.com/manual/999999/Quik-Drop.html', sourceType: 'manual_library' },
      { title: 'Quik Drop Service Manual', url: 'https://www.all-guidesbox.com/manual/123456/quik-drop.html', sourceType: 'other' }
    ],
    confidence: 0.86,
    asset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(suggestions.every((row) => row.url !== 'https://www.all-guidesbox.com/manual/123456/quik-drop.html'), true);
  assert.equal(suggestions.some((row) => row.sourceType === 'manual_library'), false);
});

test('support resources do not outrank direct manuals in verified ordering', async () => {
  const fetchMock = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => (url.endsWith('.pdf') ? 'application/pdf' : 'text/html') },
    url,
    text: async () => 'support manual'
  });

  const verified = await verifyDocumentationSuggestions([
    {
      url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
      sourceType: 'distributor',
      matchScore: 91,
      exactTitleMatch: true,
      exactManualMatch: true,
      isLikelyManual: true
    },
    {
      url: 'https://www.baytekent.com/support/quik-drop',
      sourceType: 'support',
      matchScore: 95,
      exactTitleMatch: true,
      exactManualMatch: false,
      isOfficial: true
    }
  ], fetchMock);

  assert.equal(verified[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(getDocumentationSuggestionRank(verified[0]) < getDocumentationSuggestionRank(verified[1]), true);
});

test('bay tek quik drop rejects generic official home/support pages as manual results', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Bay Tek Entertainment', url: 'https://www.baytekent.com/', sourceType: 'manufacturer' },
      { title: 'Bay Tek Support', url: 'https://www.baytekent.com/support', sourceType: 'support' },
      { title: 'Quik Drop Service Manual PDF', url: 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf', sourceType: 'parts' }
    ],
    confidence: 0.84,
    asset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.deepEqual(suggestions.map((row) => row.url), ['https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf']);
});

test('bay tek sink it keeps title-specific support in manuals but excludes generic support hub', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Support', url: 'https://baytekent.com/support', sourceType: 'support' },
      { title: 'Sink It Support', url: 'https://baytekent.com/support/sink-it', sourceType: 'support' },
      { title: 'Products', url: 'https://baytekent.com/products', sourceType: 'manufacturer' }
    ],
    confidence: 0.78,
    asset: { name: 'Sink It', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Sink It',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].url, 'https://baytekent.com/support/sink-it');
});

test('bay tek skee-ball modern prefers exact manual over official generic manual hub', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Bay Tek Manual Library', url: 'https://baytekent.com/support/manual-library', sourceType: 'manufacturer' },
      { title: 'Skee-Ball Modern Operator Manual', url: 'https://parts.baytekent.com/manuals/skee-ball-modern-operator-manual.pdf', sourceType: 'parts' }
    ],
    confidence: 0.81,
    asset: { name: 'Skee-Ball Modern', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Skee-Ball Modern',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].url, 'https://parts.baytekent.com/manuals/skee-ball-modern-operator-manual.pdf');
});

test('ice air fx prefers support.icegame.com manual results over broader official pages', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'ICE Air FX Manual', url: 'https://support.icegame.com/manuals/air-fx-service-manual.pdf', sourceType: 'support' },
      { title: 'ICE Home', url: 'https://www.icegame.com/', sourceType: 'manufacturer' },
      { title: 'ICE Support', url: 'https://www.icegame.com/support', sourceType: 'support' }
    ],
    confidence: 0.8,
    asset: { name: 'Air FX', manufacturer: 'ICE' },
    normalizedName: 'Air FX',
    manufacturerSuggestion: 'ICE'
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].url, 'https://support.icegame.com/manuals/air-fx-service-manual.pdf');
  assert.equal(suggestions[0].sourceTrustReason, 'manufacturer_preferred_source_match');
});

test('raw thrills jurassic park arcade rejects generic support page and keeps direct manual', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Support', url: 'https://rawthrills.com/support', sourceType: 'support' },
      { title: 'Jurassic Park Arcade Operator Manual', url: 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf', sourceType: 'manufacturer' }
    ],
    confidence: 0.82,
    asset: { name: 'Jurassic Park Arcade', manufacturer: 'Raw Thrills' },
    normalizedName: 'Jurassic Park Arcade',
    manufacturerSuggestion: 'Raw Thrills'
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].url, 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf');
});

test('support resources reject generic Bay Tek homepage, parts-service, blog, and terms pages', () => {
  const support = normalizeDocumentationSuggestions({
    links: [
      { label: 'Bay Tek Home', url: 'https://www.baytekent.com/', resourceType: 'official_site' },
      { label: 'Bay Tek Parts Service', url: 'https://www.baytekent.com/parts-service', resourceType: 'support' },
      { label: 'Bay Tek Blog', url: 'https://www.baytekent.com/blog', resourceType: 'support' },
      { label: 'Bay Tek Terms', url: 'https://www.baytekent.com/terms-conditions/', resourceType: 'support' },
      { label: 'Quik Drop Support', url: 'https://www.baytekent.com/support/quik-drop', resourceType: 'support' }
    ],
    confidence: 0.63,
    asset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games',
    kind: 'support'
  });

  assert.deepEqual(support.map((row) => row.url), ['https://www.baytekent.com/support/quik-drop']);
});


test('mergeDocumentationSuggestions preserves previously verified direct pdf when a later run returns no manual candidates', () => {
  const existing = [{
    title: 'Quik Drop Service Manual PDF',
    url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
    sourceType: 'distributor',
    matchScore: 91,
    exactTitleMatch: true,
    exactManualMatch: true,
    verified: true,
    trustedSource: true,
    deadPage: false,
    unreachable: false
  }];

  const merged = mergeDocumentationSuggestions({
    existingSuggestions: existing,
    nextSuggestions: []
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
});

test('isPreservableVerifiedManualSuggestion rejects support-only results but preserves verified direct manuals', () => {
  assert.equal(isPreservableVerifiedManualSuggestion({
    url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
    verified: true,
    exactTitleMatch: true,
    exactManualMatch: true
  }), true);

  assert.equal(isPreservableVerifiedManualSuggestion({
    url: 'https://www.baytekent.com/support/quik-drop',
    verified: true,
    exactTitleMatch: true,
    exactManualMatch: false
  }), false);
});

test('mergeDocumentationSuggestions keeps Quik Drop verified direct pdf ahead of later support-only refresh results', () => {
  const merged = mergeDocumentationSuggestions({
    existingSuggestions: [{
      title: 'Quik Drop Service Manual PDF',
      url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
      sourceType: 'distributor',
      matchScore: 91,
      exactTitleMatch: true,
      exactManualMatch: true,
      verified: true,
      trustedSource: true
    }],
    nextSuggestions: [{
      title: 'Bay Tek Support',
      url: 'https://www.baytekent.com/support/quik-drop',
      sourceType: 'support',
      matchScore: 84,
      exactTitleMatch: true,
      exactManualMatch: false,
      verified: false,
      trustedSource: true
    }]
  });

  assert.equal(merged[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(merged.some((row) => row.url === 'https://www.baytekent.com/support/quik-drop'), true);
});

test('collectReusableVerifiedManuals reuses previously approved exact-match Quik Drop manual from company records', () => {
  const reused = collectReusableVerifiedManuals({
    asset: { name: 'Quik Drop', normalizedName: 'Quik Drop' },
    matchedManufacturer: 'bay tek',
    manualRecords: [{
      sourceTitle: 'Quik Drop Service Manual PDF',
      sourceUrl: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
      manufacturer: 'Bay Tek Games',
      assetTitle: 'Quik Drop'
    }],
    siblingAssets: [{
      name: 'Quik Drop',
      normalizedName: 'Quik Drop',
      matchedManufacturer: 'bay tek',
      documentationSuggestions: [{
        title: 'Quik Drop Service Manual PDF',
        url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
        sourceType: 'distributor',
        matchScore: 91,
        exactTitleMatch: true,
        exactManualMatch: true,
        verified: true,
        trustedSource: true
      }]
    }]
  });

  assert.equal(reused.length, 1);
  assert.equal(reused[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(reused[0].reusedVerifiedManual, true);
  assert.equal(reused[0].verified, true);
});
