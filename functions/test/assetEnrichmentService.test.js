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
  buildFollowupQuestion,
  shouldDiscoverAfterCatalogMatch,
  hasUsableVerifiedManualSuggestion,
  recoverCatalogSourcePageManuals,
  enrichAssetDocumentation,
  cleanFinalEnrichmentResult,
  resolveTerminalEnrichmentStatus,
  repairLegacyAssetEnrichmentRecord,
  isSeededCatalogManualCandidate,
  rehydrateSeededManualDocumentationSuggestions,
  classifyManualMatchSummary
} = require('../src/services/assetEnrichmentService');
const { resolveArcadeTitleFamily } = require('../src/services/arcadeTitleAliasService');
const { findCatalogManualMatch } = require('../src/services/manualLookupCatalogService');

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




test('verifyDocumentationSuggestions preserves cached manual-library suggestions without refetching storage paths', async () => {
  let fetchCalls = 0;
  const verified = await verifyDocumentationSuggestions([
    {
      title: 'Fast & Furious Arcade Manual',
      url: 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf',
      sourceType: 'manual_library',
      manualLibraryRef: 'manual-fast-furious',
      manualStoragePath: 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf',
      cachedManual: true,
      matchScore: 98,
      exactTitleMatch: true,
      exactManualMatch: true,
    }
  ], async () => {
    fetchCalls += 1;
    throw new Error('cached manuals should not be fetched again');
  });

  assert.equal(fetchCalls, 0);
  assert.equal(verified[0].verified, true);
  assert.equal(verified[0].verificationStatus, 'cached_manual');
  assert.equal(verified[0].manualLibraryRef, 'manual-fast-furious');
  assert.equal(verified[0].manualStoragePath, 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf');
});

test('shouldDiscoverAfterCatalogMatch skips discovery for healthy catalog direct manuals', async () => {
  const catalogMatch = {
    confidence: 0.99,
    documentationSuggestions: [{
      title: 'Quik Drop Service Manual PDF',
      url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
      sourceType: 'distributor',
      matchScore: 96,
      exactTitleMatch: true,
      exactManualMatch: true
    }]
  };

  const shouldDiscover = await shouldDiscoverAfterCatalogMatch({
    catalogMatch,
    confidence: 0.8,
    draftAsset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games',
    followupAnswer: '',
    fetchImpl: async (url, options = {}) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => (url.endsWith('.pdf') ? 'application/pdf' : 'text/html') },
      text: async () => options.method === 'HEAD' ? '' : 'Quik Drop service manual PDF'
    })
  });

  assert.equal(shouldDiscover, false);
});



test('shouldDiscoverAfterCatalogMatch keeps discovering when catalog only yields a generic surviving support hub', async () => {
  const catalogMatch = {
    confidence: 0.97,
    documentationSuggestions: [{
      title: 'Raw Thrills Service Support',
      url: 'https://rawthrills.com/service-support/',
      sourceType: 'support',
      matchScore: 88,
      exactTitleMatch: false,
      exactManualMatch: false
    }]
  };

  const shouldDiscover = await shouldDiscoverAfterCatalogMatch({
    catalogMatch,
    confidence: 0.8,
    draftAsset: { name: 'Jurassic Park', manufacturer: 'Raw Thrills' },
    normalizedName: 'Jurassic Park',
    manufacturerSuggestion: 'Raw Thrills',
    followupAnswer: '',
    fetchImpl: async (url, options = {}) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/html' },
      text: async () => options.method === 'HEAD' ? '' : 'Raw Thrills service support manual downloads'
    })
  });

  assert.equal(shouldDiscover, true);
});

test('verifyDocumentationSuggestions downgrades live generic Raw Thrills service pages so they cannot survive as manual_html exact matches', async () => {
  const verified = await verifyDocumentationSuggestions([{
    title: 'Jurassic Park support',
    url: 'https://rawthrills.com/service/',
    sourceType: 'support',
    assetName: 'Jurassic Park',
    normalizedName: 'Jurassic Park Arcade',
    exactTitleMatch: true,
    exactManualMatch: true,
    trustedSource: true,
    matchScore: 91
  }], async (url, options = {}) => ({
    ok: true,
    status: 200,
    url,
    headers: { get: () => 'text/html' },
    text: async () => options.method === 'HEAD' ? '' : 'Jurassic Park service manual and support resources'
  }));

  assert.equal(verified[0].verificationKind, 'support_html');
  assert.equal(verified[0].verified, false);
  assert.equal(verified[0].exactManualMatch, false);
  const cleaned = cleanFinalEnrichmentResult({ documentationSuggestions: verified, supportResourcesSuggestion: [] });
  assert.deepEqual(cleaned.documentationSuggestions, []);
});


test('shouldDiscoverAfterCatalogMatch continues to fallback when catalog manual verifies dead', async () => {
  const catalogMatch = {
    confidence: 0.99,
    documentationSuggestions: [{
      title: 'Quik Drop Service Manual PDF',
      url: 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf',
      sourceType: 'manufacturer',
      matchScore: 96,
      exactTitleMatch: true,
      exactManualMatch: true
    }]
  };

  const shouldDiscover = await shouldDiscoverAfterCatalogMatch({
    catalogMatch,
    confidence: 0.8,
    draftAsset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games',
    followupAnswer: '',
    fetchImpl: async (url, options = {}) => ({
      ok: false,
      status: 404,
      url,
      headers: { get: () => 'text/html' },
      text: async () => options.method === 'HEAD' ? '' : 'manual not found'
    })
  });

  assert.equal(shouldDiscover, true);
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

test('classifyManualMatchSummary distinguishes exact manual, title-specific source, and family review buckets', () => {
  const exact = classifyManualMatchSummary({
    inputTitle: 'Quick Drop',
    titleFamily: resolveArcadeTitleFamily({ title: 'Quick Drop' }),
    documentationSuggestions: [{
      title: 'Quik Drop Service Manual',
      url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
      verified: true,
      exactTitleMatch: true,
      exactManualMatch: true,
      sourceType: 'distributor',
      matchScore: 96
    }],
    confidence: 0.96
  });
  assert.equal(exact.matchType, 'exact_manual');
  assert.equal(exact.manualReady, true);
  assert.equal(exact.manualUrl, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(exact.reviewRequired, false);

  const sourceOnly = classifyManualMatchSummary({
    inputTitle: 'Fast and Furious',
    titleFamily: resolveArcadeTitleFamily({ title: 'Fast and Furious' }),
    supportResourcesSuggestion: [{
      title: 'Fast & Furious Arcade product page',
      url: 'https://rawthrills.com/games/fast-furious-arcade/',
      sourceType: 'support',
      matchScore: 84
    }],
    confidence: 0.73
  });
  assert.equal(sourceOnly.matchType, 'title_specific_source');
  assert.equal(sourceOnly.manualReady, false);
  assert.equal(sourceOnly.manualUrl, '');
  assert.equal(sourceOnly.supportUrl, 'https://rawthrills.com/games/fast-furious-arcade/');

  const familyReview = classifyManualMatchSummary({
    inputTitle: 'Sink-It',
    titleFamily: resolveArcadeTitleFamily({ title: 'Sink-It' }),
    documentationSuggestions: [{
      title: 'Sink It Shootout Operator Manual',
      url: 'https://www.betson.com/wp-content/uploads/2019/09/Sink-It-Shootout-Operator-Manual.pdf',
      verified: true,
      exactTitleMatch: true,
      exactManualMatch: true,
      sourceType: 'distributor',
      matchScore: 88
    }],
    confidence: 0.88,
    catalogMatch: { matchStatus: 'catalog_family' }
  });
  assert.equal(familyReview.matchType, 'family_match_needs_review');
  assert.equal(familyReview.manualReady, false);
  assert.equal(familyReview.reviewRequired, true);
  assert.match(familyReview.variantWarning, /cabinet|model|variant/i);
});



test('classifyManualMatchSummary marks title-specific verified manual HTML pages as manual_page_with_download', () => {
  const summary = classifyManualMatchSummary({
    inputTitle: 'Fast and Furious Arcade',
    titleFamily: resolveArcadeTitleFamily({ title: 'Fast and Furious Arcade' }),
    documentationSuggestions: [{
      title: 'Fast & Furious Arcade Downloads',
      url: 'https://rawthrills.com/games/fast-furious-arcade/manuals/',
      sourceType: 'support',
      assetName: 'Fast and Furious Arcade',
      normalizedName: 'Fast and Furious Arcade',
      verified: true,
      exactTitleMatch: true,
      exactManualMatch: true,
      trustedSource: true,
      verificationKind: 'manual_html',
      sourcePageUrl: 'https://rawthrills.com/games/fast-furious-arcade/'
    }],
    supportResourcesSuggestion: [{
      title: 'Fast & Furious Arcade product page',
      url: 'https://rawthrills.com/games/fast-furious-arcade/',
      sourceType: 'support'
    }],
    confidence: 0.9
  });

  assert.equal(summary.matchType, 'manual_page_with_download');
  assert.equal(summary.manualReady, true);
  assert.equal(summary.manualUrl, 'https://rawthrills.com/games/fast-furious-arcade/manuals/');
  assert.equal(summary.manualSourceUrl, 'https://rawthrills.com/games/fast-furious-arcade/');
  assert.equal(summary.supportUrl, 'https://rawthrills.com/games/fast-furious-arcade/');
  assert.equal(summary.reviewRequired, false);
});

test('classifyManualMatchSummary keeps generic Raw Thrills service pages as support_only and never manual-ready', () => {
  const summary = classifyManualMatchSummary({
    inputTitle: 'King Kong VR',
    titleFamily: resolveArcadeTitleFamily({ title: 'King Kong VR' }),
    supportResourcesSuggestion: [{
      title: 'Raw Thrills service support',
      url: 'https://rawthrills.com/service/',
      sourceType: 'support',
      matchScore: 60
    }],
    confidence: 0.62
  });

  assert.equal(summary.matchType, 'support_only');
  assert.equal(summary.manualReady, false);
  assert.equal(summary.manualUrl, '');
  assert.equal(summary.status, 'followup_needed');
});

test('classifyManualMatchSummary treats Virtual Rabbids install-guide evidence as family review instead of manual-ready', () => {
  const summary = classifyManualMatchSummary({
    inputTitle: 'Virtual Rabbids',
    titleFamily: resolveArcadeTitleFamily({ title: 'Virtual Rabbids' }),
    documentationSuggestions: [{
      title: 'Virtual Rabbids install guide',
      url: 'https://laigames.com/downloads/virtual-rabbids-the-big-ride-install-guide.pdf',
      sourcePageUrl: 'https://laigames.com/virtual-rabbids-upgrade-kit',
      sourceType: 'manufacturer',
      manualType: 'install_guide',
      verified: true,
      exactTitleMatch: true,
      exactManualMatch: false,
      trustedSource: true,
      matchScore: 88
    }],
    supportResourcesSuggestion: [{
      title: 'Virtual Rabbids upgrade kit',
      url: 'https://laigames.com/virtual-rabbids-upgrade-kit',
      sourceType: 'support',
      matchScore: 76
    }],
    confidence: 0.88
  });

  assert.equal(summary.matchType, 'title_specific_source');
  assert.equal(summary.manualReady, false);
  assert.equal(summary.manualUrl, '');
  assert.equal(summary.supportUrl, 'https://laigames.com/virtual-rabbids-upgrade-kit');
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

test('Jurassic Park exact-title Raw Thrills page outranks generic service-support hub', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Raw Thrills Service Support', url: 'https://rawthrills.com/service-support/', sourceType: 'support' },
      { title: 'Jurassic Park Arcade support', url: 'https://rawthrills.com/games/jurassic-park-arcade-support', sourceType: 'support' },
      { title: 'Jurassic Park Arcade operator manual', url: 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf', sourceType: 'manufacturer' }
    ],
    confidence: 0.82,
    asset: { name: 'Jurassic Park', manufacturer: 'Raw Thrills' },
    normalizedName: 'Jurassic Park',
    manufacturerSuggestion: 'Raw Thrills'
  });

  assert.deepEqual(suggestions.map((entry) => entry.url), [
    'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf',
    'https://rawthrills.com/games/jurassic-park-arcade-support'
  ]);
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
  assert.equal(profile?.lowTrustSourceTokens.includes('betson.com'), true);
  assert.equal(profile?.lowTrustSourceTokens.includes('manualslib.com'), true);
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

test('Quik Drop workbook-seeded catalog direct manual survives preview merge while source page stays support-only', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const catalogMatch = findCatalogManualMatch({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    alternateNames: ['Quik Drop']
  });

  const normalizedCatalogSuggestions = normalizeDocumentationSuggestions({
    links: catalogMatch.documentationSuggestions,
    confidence: 0.99,
    asset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games'
  });
  const supportResourcesSuggestion = normalizeDocumentationSuggestions({
    links: catalogMatch.supportResources,
    confidence: 0.99,
    asset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games',
    kind: 'support'
  });

  const merged = mergeDocumentationSuggestions({
    existingSuggestions: normalizedCatalogSuggestions,
    nextSuggestions: [],
    preserveExistingCandidates: true
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(supportResourcesSuggestion.length, 1);
  assert.match(supportResourcesSuggestion[0].url, /quik-drop/);
  assert.equal(merged.some((entry) => entry.url === supportResourcesSuggestion[0].url), false);
});



test('seeded catalog direct pdf remains a reviewable manual candidate when runtime verification is temporarily unreachable', async () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const catalogMatch = findCatalogManualMatch({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    alternateNames: ['Quik Drop']
  });
  const normalizedCatalogSuggestions = normalizeDocumentationSuggestions({
    links: catalogMatch.documentationSuggestions,
    confidence: 0.99,
    asset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  const verified = await verifyDocumentationSuggestions(normalizedCatalogSuggestions, async () => {
    throw new Error('temporary network failure');
  });
  const cleaned = cleanFinalEnrichmentResult({
    documentationSuggestions: verified,
    supportResourcesSuggestion: catalogMatch.supportResources,
    enrichmentFollowupQuestion: 'What exact subtitle appears under the logo?'
  });

  assert.equal(isSeededCatalogManualCandidate(verified[0]), true);
  assert.equal(verified[0].verified, true);
  assert.equal(verified[0].verificationStatus, 'seed_verified');
  assert.equal(cleaned.documentationSuggestions.length, 1);
  assert.equal(cleaned.documentationSuggestions[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(cleaned.enrichmentStatus, 'docs_found');
  assert.equal(cleaned.reviewState, 'pending_review');
  assert.equal(cleaned.enrichmentFollowupQuestion, '');
});

test('Quik Drop workbook-seeded verified catalog manual resolves to docs_found status signal', async () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const catalogMatch = findCatalogManualMatch({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    alternateNames: ['Quik Drop']
  });

  const normalizedCatalogSuggestions = normalizeDocumentationSuggestions({
    links: catalogMatch.documentationSuggestions,
    confidence: 0.99,
    asset: { name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Quik Drop',
    manufacturerSuggestion: 'Bay Tek Games'
  });
  const verified = await verifyDocumentationSuggestions(normalizedCatalogSuggestions, async (url, options = {}) => ({
    ok: true,
    status: 200,
    url,
    headers: { get: () => (url.endsWith('.pdf') ? 'application/pdf' : 'text/html') },
    text: async () => options.method === 'HEAD' ? '' : 'Quik Drop service manual PDF'
  }));
  const suggestions = mergeDocumentationSuggestions({
    existingSuggestions: [],
    nextSuggestions: verified
  });

  assert.equal(hasUsableVerifiedManualSuggestion(suggestions), true);
  assert.equal(suggestions[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
});

test('Jurassic Park generic Raw Thrills service hub does not verify as a reviewable manual_html suggestion', async () => {
  const verified = await verifyDocumentationSuggestions([{
    title: 'Jurassic Park service and support',
    url: 'https://rawthrills.com/service/',
    assetName: 'Jurassic Park',
    normalizedName: 'Jurassic Park Arcade',
    sourceType: 'support',
    matchScore: 86,
    exactTitleMatch: true,
    exactManualMatch: true,
    isOfficial: true,
    trustedSource: true
  }], async (url, options = {}) => ({
    ok: true,
    status: 200,
    url,
    headers: { get: () => 'text/html' },
    text: async () => options.method === 'HEAD' ? '' : 'Jurassic Park service manuals and support'
  }));
  const cleaned = cleanFinalEnrichmentResult({
    documentationSuggestions: verified,
    supportResourcesSuggestion: [],
    enrichmentFollowupQuestion: ''
  });

  assert.equal(verified[0].verificationKind, 'support_html');
  assert.equal(verified[0].verified, false);
  assert.equal(cleaned.documentationSuggestions.length, 0);
  assert.equal(cleaned.enrichmentStatus, 'no_match_yet');
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

test('verifySuggestionUrl returns verification metadata for direct pdfs', async () => {
  const result = await verifySuggestionUrl('https://example.com/manual.pdf', async () => ({
    ok: true,
    status: 200,
    url: 'https://example.com/manual.pdf',
    headers: { get: () => 'application/pdf' },
    text: async () => ''
  }));

  assert.equal(result.verified, true);
  assert.equal(result.directPdf, true);
  assert.equal(result.verificationKind, 'direct_pdf');
  assert.equal(result.contentType, 'application/pdf');
});

test('verified direct pdf outranks support page and manual library html', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Fast and Furious Manual PDF', url: 'https://rawthrills.com/manuals/fast-and-furious.pdf', sourceType: 'manufacturer' },
      { title: 'Fast and Furious Support', url: 'https://rawthrills.com/games/fast-furious-arcade/', sourceType: 'support' },
      { title: 'Fast and Furious Manual', url: 'https://www.manualslib.com/manual/123/fast-and-furious.html', sourceType: 'manual_library' }
    ],
    confidence: 0.8,
    asset: { name: 'Fast and Furious Arcade', manufacturer: 'Raw Thrills' },
    normalizedName: 'Fast and Furious Arcade',
    manufacturerSuggestion: 'Raw Thrills'
  });

  assert.equal(suggestions[0].url, 'https://rawthrills.com/manuals/fast-and-furious.pdf');
});

test('source page extraction can recover official Raw Thrills manuals', async () => {
  const fetchMock = async (url) => {
    if (url === 'https://rawthrills.com/games/fast-furious-arcade/') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<a href="https://rawthrills.com/manuals/fast-furious-arcade-2-player.pdf">2 Player Manual PDF</a><a href="https://rawthrills.com/manuals/fast-furious-arcade-motion.pdf">Motion Manual PDF</a>'
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/pdf' },
      text: async () => ''
    };
  };

  const extracted = await require('../src/services/manualDiscoveryService').extractManualLinksFromHtmlPage({
    pageUrl: 'https://rawthrills.com/games/fast-furious-arcade/',
    pageTitle: 'Fast and Furious Arcade',
    manufacturer: 'Raw Thrills',
    titleVariants: ['fast and furious arcade', 'fast and furious'],
    manufacturerProfile: getManufacturerProfile('Raw Thrills', 'Fast and Furious Arcade'),
    fetchImpl: fetchMock,
    logEvent: () => {}
  });

  assert.deepEqual(extracted.map((row) => row.url), [
    'https://rawthrills.com/manuals/fast-furious-arcade-2-player.pdf',
    'https://rawthrills.com/manuals/fast-furious-arcade-motion.pdf'
  ]);
});

test('family fallback requires explicit Sink It family evidence', () => {
  const suggestions = normalizeDocumentationSuggestions({
    links: [
      { title: 'Sink It Shootout Operator Manual', url: 'https://www.betson.com/wp-content/uploads/2019/09/Sink-It-Shootout-Operator-Manual.pdf', sourceType: 'distributor' },
      { title: 'Random Shootout Manual', url: 'https://example.com/shootout-manual.pdf', sourceType: 'other' }
    ],
    confidence: 0.74,
    asset: { name: 'Sink It', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Sink It',
    manufacturerSuggestion: 'Bay Tek Games'
  });

  assert.equal(suggestions[0].url, 'https://www.betson.com/wp-content/uploads/2019/09/Sink-It-Shootout-Operator-Manual.pdf');
  assert.equal(suggestions.some((row) => row.url === 'https://example.com/shootout-manual.pdf'), false);
});




test('Fast and Furious official source page extraction yields surviving final documentation suggestions', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Fast & Furious');
  const catalogMatch = findCatalogManualMatch({
    assetName: 'Fast & Furious',
    normalizedName: 'Fast and Furious',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    alternateNames: []
  });

  const fetchMock = async (url, options = {}) => {
    if (url === 'https://rawthrills.com/games/fast-furious-arcade/') {
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html' },
        text: async () => options.method === 'HEAD'
          ? ''
          : '<a href="https://rawthrills.com/manuals/fast-furious-arcade-2-player.pdf">2 Player Manual PDF</a><a href="https://rawthrills.com/manuals/fast-furious-arcade-motion.pdf">Motion Manual PDF</a>'
      };
    }
    if (/rawthrills\.com\/manuals\//.test(url)) {
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'application/pdf' },
        text: async () => ''
      };
    }
    return {
      ok: false,
      status: 404,
      url,
      headers: { get: () => 'text/html' },
      text: async () => options.method === 'HEAD' ? '' : 'manual not found'
    };
  };

  const recovered = await recoverCatalogSourcePageManuals({
    catalogMatch,
    draftAsset: { name: 'Fast & Furious', manufacturer: 'Raw Thrills' },
    normalizedName: 'Fast and Furious',
    manufacturerSuggestion: 'Raw Thrills',
    manufacturerProfile: profile,
    fetchImpl: fetchMock
  });
  const normalizedRecovered = normalizeDocumentationSuggestions({
    links: recovered,
    confidence: 0.9,
    asset: { name: 'Fast & Furious', manufacturer: 'Raw Thrills' },
    normalizedName: 'Fast and Furious',
    manufacturerSuggestion: 'Raw Thrills'
  });
  const verified = await verifyDocumentationSuggestions(normalizedRecovered, fetchMock);
  const finalSuggestions = mergeDocumentationSuggestions({ existingSuggestions: [], nextSuggestions: verified });
  const supportResourcesSuggestion = normalizeDocumentationSuggestions({
    links: catalogMatch.supportResources,
    confidence: 0.9,
    asset: { name: 'Fast & Furious', manufacturer: 'Raw Thrills' },
    normalizedName: 'Fast and Furious',
    manufacturerSuggestion: 'Raw Thrills',
    kind: 'support'
  });

  assert.deepEqual(finalSuggestions.map((entry) => entry.url), [
    'https://rawthrills.com/manuals/fast-furious-arcade-2-player.pdf',
    'https://rawthrills.com/manuals/fast-furious-arcade-motion.pdf'
  ]);
  assert.equal(finalSuggestions.every((entry) => entry.verified), true);
  assert.equal(hasUsableVerifiedManualSuggestion(finalSuggestions), true);
  assert.equal(supportResourcesSuggestion.some((entry) => entry.url === 'https://rawthrills.com/games/fast-furious-arcade/'), true);
  assert.equal(finalSuggestions.some((entry) => entry.url === 'https://rawthrills.com/games/fast-furious-arcade/'), false);
});

test('Sink It dead family manual falls back cleanly without dead final docs or internal-failure behavior', async () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Sink It');
  const catalogMatch = findCatalogManualMatch({
    assetName: 'Sink It',
    normalizedName: 'Sink It',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    alternateNames: []
  });

  const fetchMock = async (url, options = {}) => {
    if (url === 'https://www.betson.com/wp-content/uploads/2019/09/Sink-It-Shootout-Operator-Manual.pdf') {
      return {
        ok: false,
        status: 404,
        url,
        headers: { get: () => 'text/html' },
        text: async () => options.method === 'HEAD' ? '' : 'manual not found'
      };
    }
    if (url === 'https://www.baytekent.com/games/sink-it-shootout/') {
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html' },
        text: async () => '<html><body><a href="/support">Support</a><p>Sink It Shootout</p></body></html>'
      };
    }
    return {
      ok: false,
      status: 404,
      url,
      headers: { get: () => 'text/html' },
      text: async () => options.method === 'HEAD' ? '' : 'page not found'
    };
  };

  const normalizedCatalogSuggestions = normalizeDocumentationSuggestions({
    links: catalogMatch.documentationSuggestions,
    confidence: 0.82,
    asset: { name: 'Sink It', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Sink It',
    manufacturerSuggestion: 'Bay Tek Games'
  });
  const verifiedCatalog = await verifyDocumentationSuggestions(normalizedCatalogSuggestions, fetchMock);
  const survivingCatalog = verifiedCatalog.filter((entry) => !entry.deadPage && !entry.unreachable);
  const recovered = await recoverCatalogSourcePageManuals({
    catalogMatch,
    draftAsset: { name: 'Sink It', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Sink It',
    manufacturerSuggestion: 'Bay Tek Games',
    manufacturerProfile: profile,
    fetchImpl: fetchMock
  });
  const finalSuggestions = mergeDocumentationSuggestions({
    existingSuggestions: survivingCatalog,
    nextSuggestions: normalizeDocumentationSuggestions({
      links: recovered,
      confidence: 0.82,
      asset: { name: 'Sink It', manufacturer: 'Bay Tek Games' },
      normalizedName: 'Sink It',
      manufacturerSuggestion: 'Bay Tek Games'
    }),
    preserveExistingCandidates: true
  });
  const supportResourcesSuggestion = normalizeDocumentationSuggestions({
    links: catalogMatch.supportResources,
    confidence: 0.82,
    asset: { name: 'Sink It', manufacturer: 'Bay Tek Games' },
    normalizedName: 'Sink It',
    manufacturerSuggestion: 'Bay Tek Games',
    kind: 'support'
  });

  assert.equal(verifiedCatalog[0].deadPage, true);
  assert.equal(survivingCatalog.length, 0);
  assert.equal(finalSuggestions.length, 0);
  assert.equal(hasUsableVerifiedManualSuggestion(finalSuggestions), false);
  assert.equal(supportResourcesSuggestion.some((entry) => entry.url === 'https://www.baytekent.com/games/sink-it-shootout/'), true);
  assert.equal(finalSuggestions.some((entry) => entry.url === 'https://www.betson.com/wp-content/uploads/2019/09/Sink-It-Shootout-Operator-Manual.pdf'), false);
});

test('cleanup pass removes dead docs, separates support resources, and strips junk anchors', () => {
  const cleaned = cleanFinalEnrichmentResult({
    documentationSuggestions: [
      {
        title: 'Jurassic Park Official PDF',
        url: 'https://example.com/jurassic-park.pdf',
        verified: false,
        deadPage: true,
        exactTitleMatch: true,
        exactManualMatch: true
      },
      {
        title: 'Jurassic Park Service Manual',
        url: 'https://archive.org/jurassic-park-service-manual.pdf',
        verified: true,
        deadPage: false,
        unreachable: false,
        exactTitleMatch: true,
        exactManualMatch: true,
        sourceType: 'manual_library'
      },
      {
        title: 'Product page duplicate',
        url: 'https://manufacturer.example.com/jurassic-park#respond',
        verified: true,
        deadPage: false,
        unreachable: false,
        exactTitleMatch: true,
        exactManualMatch: false,
        sourceType: 'support'
      }
    ],
    supportResourcesSuggestion: [
      { title: 'Jurassic Park Product', url: 'https://manufacturer.example.com/jurassic-park#respond', sourceType: 'support', matchScore: 65 },
      { title: 'Jurassic Park Help', url: 'https://manufacturer.example.com/jurassic-park#comments', sourceType: 'support', matchScore: 65 }
    ],
    enrichmentFollowupQuestion: ''
  });

  assert.deepEqual(cleaned.documentationSuggestions.map((entry) => entry.url), [
    'https://archive.org/jurassic-park-service-manual.pdf'
  ]);
  assert.deepEqual(cleaned.supportResourcesSuggestion.map((entry) => entry.url), [
    'https://manufacturer.example.com/jurassic-park'
  ]);
  assert.equal(cleaned.enrichmentStatus, 'docs_found');
  assert.equal(cleaned.reviewState, 'pending_review');
});

test('terminal status resolver maps support-only and follow-up states without treating them as backend failures', () => {
  assert.equal(resolveTerminalEnrichmentStatus({
    documentationSuggestions: [],
    supportResourcesSuggestion: [{ url: 'https://rawthrills.com/games/fast-furious-arcade/', sourceType: 'support', matchScore: 60 }],
    followupQuestion: ''
  }), 'followup_needed');
  assert.equal(resolveTerminalEnrichmentStatus({
    documentationSuggestions: [],
    supportResourcesSuggestion: [],
    followupQuestion: 'What exact subtitle is on the marquee?'
  }), 'followup_needed');
  assert.equal(resolveTerminalEnrichmentStatus({
    documentationSuggestions: [],
    supportResourcesSuggestion: [],
    followupQuestion: ''
  }), 'no_match_yet');
});



test('support-only context cannot reach docs_found terminal status even when review metadata exists', () => {
  const supportOnlySummary = {
    matchType: 'support_only',
    manualReady: false
  };
  assert.equal(resolveTerminalEnrichmentStatus({
    documentationSuggestions: [],
    supportResourcesSuggestion: [{ title: 'Raw Thrills service', url: 'https://rawthrills.com/service/', sourceType: 'support', matchScore: 60 }],
    followupQuestion: '',
    manualMatchSummary: supportOnlySummary
  }), 'followup_needed');
});

test('Quik Drop exact manual-bearing official page resolves terminal docs_found without followup', () => {
  const cleaned = cleanFinalEnrichmentResult({
    documentationSuggestions: [{
      title: 'Quik Drop Support and Installation Guide',
      url: 'https://www.baytekent.com/games/quik-drop/',
      assetName: 'Quik Drop',
      normalizedName: 'Quik Drop',
      sourceType: 'support',
      matchScore: 78,
      exactTitleMatch: true,
      exactManualMatch: false,
      isOfficial: true,
      trustedSource: true,
      verified: true,
      verificationKind: 'manual_html',
      deadPage: false,
      unreachable: false
    }],
    supportResourcesSuggestion: [{
      title: 'Quik Drop source page',
      url: 'https://www.baytekent.com/games/quik-drop/',
      sourceType: 'support',
      matchScore: 78
    }],
    enrichmentFollowupQuestion: 'What exact subtitle appears under the logo?'
  });

  assert.equal(cleaned.enrichmentStatus, 'docs_found');
  assert.equal(cleaned.enrichmentFollowupQuestion, '');
  assert.equal(cleaned.documentationSuggestions[0].verificationKind, 'manual_html');
  assert.equal(cleaned.manualMatchSummary.matchType, 'manual_page_with_download');
  assert.equal(cleaned.manualMatchSummary.manualReady, true);
});

test('Quik Drop exact catalog manual persists as documentationSuggestions and avoids followup terminal state', async () => {
  const { db, assetWrites, assetState } = createEnrichmentDb({ name: 'Quik Drop', manufacturer: 'Bay Tek Games', companyId: 'company-1' });
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const catalogMatch = findCatalogManualMatch({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    alternateNames: []
  });

  const result = await enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'manual',
    followupAnswer: '',
    traceId: 'trace-quik-drop-catalog',
    dependencies: {
      runLookupPreview: async () => ({
        confidence: 0.99,
        normalizedName: 'Quik Drop',
        likelyManufacturer: 'Bay Tek Games',
        documentationSuggestions: catalogMatch.documentationSuggestions,
        supportResourcesSuggestion: catalogMatch.supportResources,
        supportContactsSuggestion: [],
        alternateNames: ['Quick Drop'],
        searchHints: [],
        likelyCategory: 'redemption',
        topMatchReason: 'catalog exact match',
        oneFollowupQuestion: '',
        catalogMatch: {
          catalogEntryId: catalogMatch.catalogEntryId,
          matchStatus: catalogMatch.matchStatus,
          confidence: catalogMatch.confidence,
          lookupMethod: catalogMatch.lookupMethod,
          notes: catalogMatch.notes
        }
      }),
      findReusableVerifiedManuals: async () => [],
      verifyDocumentationSuggestions: async (rows) => rows.map((row) => ({
        ...row,
        verified: true,
        deadPage: false,
        unreachable: false,
        verificationStatus: 'verified',
        verificationKind: 'direct_pdf',
        contentType: 'application/pdf'
      }))
    }
  });

  assert.equal(result.status, 'docs_found');
  assert.equal(assetWrites.at(-1).payload.enrichmentStatus, 'docs_found');
  assert.equal(assetWrites.at(-1).payload.reviewState, 'pending_review');
  assert.equal(assetState.documentationSuggestions.length, 1);
  assert.equal(assetState.documentationSuggestions[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(assetState.manualLookupCatalogMatch.matchStatus, 'catalog_exact');
  assert.equal(assetState.enrichmentFollowupQuestion, '');
});

test('Virtual Rabbids workbook seed materializes a trustworthy official documentation suggestion', async () => {
  const profile = getManufacturerProfile('LAI Games', 'Virtual Rabbids');
  const catalogMatch = findCatalogManualMatch({
    assetName: 'Virtual Rabbids',
    normalizedName: 'Virtual Rabbids Arcade',
    manufacturer: 'LAI Games',
    manufacturerProfile: profile,
    alternateNames: ['Virtual Rabbids Arcade']
  });
  const normalizedCatalogSuggestions = normalizeDocumentationSuggestions({
    links: catalogMatch.documentationSuggestions,
    confidence: 0.96,
    asset: { name: 'Virtual Rabbids', manufacturer: 'LAI Games' },
    normalizedName: 'Virtual Rabbids Arcade',
    manufacturerSuggestion: 'LAI Games'
  });
  const verified = await verifyDocumentationSuggestions(normalizedCatalogSuggestions, async (url, options = {}) => ({
    ok: true,
    status: 200,
    url,
    headers: { get: () => (url.endsWith('.pdf') ? 'application/pdf' : 'text/html') },
    text: async () => options.method === 'HEAD' ? '' : 'Virtual Rabbids The Big Ride install guide PDF'
  }));
  const cleaned = cleanFinalEnrichmentResult({
    documentationSuggestions: verified,
    supportResourcesSuggestion: catalogMatch.supportResources,
    enrichmentFollowupQuestion: ''
  });

  assert.ok(catalogMatch);
  assert.equal(cleaned.documentationSuggestions.length, 0);
  assert.equal(cleaned.supportResourcesSuggestion[0].url, 'https://laigames.com/virtual-rabbids-upgrade-kit');
  assert.equal(cleaned.enrichmentStatus, 'followup_needed');
});



test('repairLegacyAssetEnrichmentRecord strips stale Jurassic generic Raw Thrills service page out of documentation suggestions', async () => {
  const repaired = await repairLegacyAssetEnrichmentRecord({
    asset: {
      name: 'Jurassic Park',
      normalizedName: 'Jurassic Park Arcade',
      enrichmentStatus: 'docs_found',
      documentationSuggestions: [{
        title: 'Jurassic Park service and support',
        url: 'https://rawthrills.com/service/',
        assetName: 'Jurassic Park',
        normalizedName: 'Jurassic Park Arcade',
        sourceType: 'support',
        matchScore: 86,
        exactTitleMatch: true,
        exactManualMatch: true,
        verified: true,
        trustedSource: true,
        verificationKind: 'manual_html',
        verificationStatus: 'verified',
        deadPage: false,
        unreachable: false
      }],
      supportResourcesSuggestion: [{
        title: 'Raw Thrills service',
        url: 'https://rawthrills.com/service/',
        sourceType: 'support',
        matchScore: 60
      }],
      enrichmentFollowupQuestion: ''
    },
    verifySuggestions: async (rows) => rows
  });

  assert.equal(repaired.documentationSuggestions.length, 0);
  assert.equal(repaired.supportResourcesSuggestion.length, 1);
  assert.equal(repaired.supportResourcesSuggestion[0].url, 'https://rawthrills.com/service/');
  assert.equal(repaired.enrichmentStatus, 'followup_needed');
  assert.equal(repaired.reviewState, 'followup_needed');
});
test('repairLegacyAssetEnrichmentRecord reclassifies stale lookup_failed asset with support context', async () => {
  const repaired = await repairLegacyAssetEnrichmentRecord({
    asset: {
      name: 'King Kong',
      enrichmentStatus: 'lookup_failed',
      enrichmentErrorCode: '',
      enrichmentErrorMessage: '',
      documentationSuggestions: [{
        title: 'Dead PDF',
        url: 'https://example.com/king-kong.pdf',
        exactTitleMatch: true,
        exactManualMatch: true
      }],
      supportResourcesSuggestion: [
        { title: 'King Kong support', url: 'https://manufacturer.example.com/king-kong#respond', sourceType: 'support', matchScore: 58 }
      ],
      enrichmentFollowupQuestion: 'Which cabinet version is this?'
    },
    verifySuggestions: async () => [{
      title: 'Dead PDF',
      url: 'https://example.com/king-kong.pdf',
      exactTitleMatch: true,
      exactManualMatch: true,
      verified: false,
      deadPage: true,
      unreachable: false
    }]
  });

  assert.equal(repaired.enrichmentStatus, 'followup_needed');
  assert.equal(repaired.reviewState, 'followup_needed');
  assert.equal(repaired.documentationSuggestions.length, 0);
  assert.deepEqual(repaired.supportResourcesSuggestion.map((entry) => entry.url), ['https://manufacturer.example.com/king-kong']);
  assert.equal(repaired.enrichmentErrorCode, '');
  assert.equal(repaired.enrichmentErrorMessage, '');
});

test('rehydrateSeededManualDocumentationSuggestions reconstructs Jurassic Park direct manual from seeded support metadata', () => {
  const rehydrated = rehydrateSeededManualDocumentationSuggestions({
    asset: {
      name: 'Jurassic Park',
      normalizedName: 'Jurassic Park Arcade',
      manufacturer: 'Raw Thrills',
      enrichmentStatus: 'followup_needed',
      manualLookupCatalogMatch: {
        catalogEntryId: 'raw-thrills-jurassic-park-arcade',
        matchStatus: 'catalog_exact',
        lookupMethod: 'workbook_seed_exact_pdf'
      }
    },
    documentationSuggestions: [],
    supportResourcesSuggestion: [{
      title: 'Jurassic Park source page',
      url: 'https://rawthrills.com/games/jurassic-park-arcade/',
      sourceType: 'support',
      exactTitleMatch: true,
      exactManualMatch: false,
      trustedSource: true,
      matchScore: 84,
      lookupMethod: 'workbook_seed_exact_pdf',
      catalogEntryId: 'raw-thrills-jurassic-park-arcade',
      verificationMetadata: {
        seededFromWorkbook: true,
        hasDirectManual: true
      }
    }],
    normalizedName: 'Jurassic Park Arcade',
    manufacturerSuggestion: 'Raw Thrills'
  });

  assert.equal(rehydrated.length, 1);
  assert.equal(rehydrated[0].url, 'https://rawthrills.com/wp-content/uploads/2015/12/Jurassic-Park-Arcade-Manual.pdf');
  assert.equal(rehydrated[0].catalogEntryId, 'raw-thrills-jurassic-park-arcade');
});

test('repairLegacyAssetEnrichmentRecord rehydrates Jurassic Park live persisted seeded manual evidence into docs_found', async () => {
  const repaired = await repairLegacyAssetEnrichmentRecord({
    asset: {
      name: 'Jurassic Park',
      normalizedName: 'Jurassic Park Arcade',
      manufacturer: 'Raw Thrills',
      enrichmentStatus: 'followup_needed',
      reviewState: 'followup_needed',
      documentationSuggestions: [],
      supportResourcesSuggestion: [{
        title: 'Jurassic Park source page',
        url: 'https://rawthrills.com/games/jurassic-park-arcade/',
        sourceType: 'support',
        exactTitleMatch: true,
        exactManualMatch: false,
        trustedSource: true,
        matchScore: 84,
        lookupMethod: 'workbook_seed_exact_pdf',
        catalogEntryId: 'raw-thrills-jurassic-park-arcade',
        verificationMetadata: {
          seededFromWorkbook: true,
          hasDirectManual: true
        }
      }],
      manualLookupCatalogMatch: {
        catalogEntryId: 'raw-thrills-jurassic-park-arcade',
        matchStatus: 'catalog_exact',
        lookupMethod: 'workbook_seed_exact_pdf'
      },
      enrichmentFollowupQuestion: 'What exact subtitle appears under the logo?'
    },
    verifySuggestions: async (rows) => rows.map((row) => ({
      ...row,
      verified: true,
      deadPage: false,
      unreachable: false,
      verificationStatus: 'seed_verified',
      verificationKind: row.url.endsWith('.pdf') ? 'direct_pdf' : 'support_html',
      contentType: row.url.endsWith('.pdf') ? 'application/pdf' : 'text/html'
    }))
  });

  assert.equal(repaired.enrichmentStatus, 'docs_found');
  assert.equal(repaired.reviewState, 'pending_review');
  assert.equal(repaired.enrichmentFollowupQuestion, '');
  assert.equal(repaired.documentationSuggestions.length, 1);
  assert.equal(repaired.documentationSuggestions[0].url, 'https://rawthrills.com/wp-content/uploads/2015/12/Jurassic-Park-Arcade-Manual.pdf');
  assert.equal(repaired.supportResourcesSuggestion[0].url, 'https://rawthrills.com/games/jurassic-park-arcade/');
});

test('repairLegacyAssetEnrichmentRecord rehydrates Quik Drop live persisted seeded manual evidence into docs_found', async () => {
  const repaired = await repairLegacyAssetEnrichmentRecord({
    asset: {
      name: 'Quik Drop',
      normalizedName: 'Quik Drop',
      manufacturer: 'Bay Tek Games',
      enrichmentStatus: 'followup_needed',
      reviewState: 'followup_needed',
      documentationSuggestions: [],
      supportResourcesSuggestion: [{
        title: 'Quik Drop source page',
        url: 'https://www.baytekent.com/games/quik-drop/',
        sourceType: 'support',
        exactTitleMatch: true,
        exactManualMatch: false,
        trustedSource: true,
        matchScore: 84,
        lookupMethod: 'workbook_seed_exact_pdf',
        catalogEntryId: 'bay-tek-quik-drop',
        verificationMetadata: {
          seededFromWorkbook: true,
          hasDirectManual: true
        }
      }],
      manualLookupCatalogMatch: {
        catalogEntryId: 'bay-tek-quik-drop',
        matchStatus: 'catalog_exact',
        lookupMethod: 'workbook_seed_exact_pdf'
      },
      enrichmentFollowupQuestion: 'What exact subtitle appears under the logo?'
    },
    verifySuggestions: async (rows) => rows.map((row) => ({
      ...row,
      verified: true,
      deadPage: false,
      unreachable: false,
      verificationStatus: 'seed_verified',
      verificationKind: row.url.endsWith('.pdf') ? 'direct_pdf' : 'support_html',
      contentType: row.url.endsWith('.pdf') ? 'application/pdf' : 'text/html'
    }))
  });

  assert.equal(repaired.enrichmentStatus, 'docs_found');
  assert.equal(repaired.reviewState, 'pending_review');
  assert.equal(repaired.enrichmentFollowupQuestion, '');
  assert.equal(repaired.documentationSuggestions.length, 1);
  assert.equal(repaired.documentationSuggestions[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(repaired.supportResourcesSuggestion[0].url, 'https://www.baytekent.com/games/quik-drop/');
});




test('enrichAssetDocumentation attaches acquired manual-library metadata for single-asset title-page acquisitions', async () => {
  const { db, assetWrites, assetState } = createEnrichmentDb({ name: 'Fast & Furious', manufacturer: 'Raw Thrills', companyId: 'company-1' });

  const result = await enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'manual',
    followupAnswer: '',
    traceId: 'trace-single-fast-furious',
    dependencies: {
      runLookupPreview: async () => ({
        confidence: 0.9,
        normalizedName: 'Fast & Furious Arcade',
        likelyManufacturer: 'Raw Thrills',
        documentationSuggestions: [{
          title: 'Fast & Furious Arcade Manual',
          url: 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf',
          sourcePageUrl: 'https://rawthrills.com/games/fast-furious-arcade/',
          sourceType: 'manual_library',
          manualLibraryRef: 'manual-fast-furious',
          manualStoragePath: 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf',
          cachedManual: true,
          matchScore: 99,
          exactTitleMatch: true,
          exactManualMatch: true,
          trustedSource: true,
          verified: true,
        }],
        supportResourcesSuggestion: [{
          title: 'Fast & Furious Arcade title page',
          url: 'https://rawthrills.com/games/fast-furious-arcade/',
          sourceType: 'support',
          matchScore: 62,
        }],
        supportContactsSuggestion: [],
        alternateNames: ['Fast and Furious'],
        searchHints: [],
        likelyCategory: 'video',
        matchType: 'exact_manual',
        manualReady: true,
        manualUrl: 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf',
        manualSourceUrl: 'https://rawthrills.com/games/fast-furious-arcade/',
        supportUrl: 'https://rawthrills.com/games/fast-furious-arcade/',
        manualMatchSummary: {
          matchType: 'exact_manual',
          manualReady: true,
          manualUrl: 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf',
          manualSourceUrl: 'https://rawthrills.com/games/fast-furious-arcade/',
          supportUrl: 'https://rawthrills.com/games/fast-furious-arcade/',
          manualLibraryRef: 'manual-fast-furious',
          manualStoragePath: 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf',
        },
        pipelineMeta: {
          stage1MatchType: 'title_specific_source',
          stage2Ran: true,
          sourcePageExtracted: true,
          acquisitionSucceeded: true,
          manualLibraryRef: 'manual-fast-furious',
          manualStoragePath: 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf',
        },
      }),
      findReusableVerifiedManuals: async () => [],
      verifyDocumentationSuggestions: async (rows) => rows,
    }
  });

  assert.equal(result.status, 'docs_found');
  assert.equal(assetWrites.at(-1).payload.manualLibraryRef, 'manual-fast-furious');
  assert.equal(assetWrites.at(-1).payload.manualStoragePath, 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf');
  assert.deepEqual(assetWrites.at(-1).payload.manualLinks, ['manual-library/raw-thrills/fast-furious-arcade/abc123.pdf']);
  assert.equal(assetWrites.at(-1).payload.manualSourceUrl, 'https://rawthrills.com/games/fast-furious-arcade/');
  assert.equal(assetWrites.at(-1).payload.supportUrl, 'https://rawthrills.com/games/fast-furious-arcade/');
  assert.equal(assetState.manualLibraryRef, 'manual-fast-furious');
});

test('enrichAssetDocumentation keeps source-only single-asset results out of docs_found without acquired manual storage', async () => {
  const { db, assetWrites } = createEnrichmentDb({ name: 'King Kong', manufacturer: 'Raw Thrills', companyId: 'company-1' });

  const result = await enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'manual',
    followupAnswer: '',
    traceId: 'trace-single-king-kong-source',
    dependencies: {
      runLookupPreview: async () => ({
        confidence: 0.71,
        normalizedName: 'King Kong of Skull Island VR',
        likelyManufacturer: 'Raw Thrills',
        documentationSuggestions: [],
        supportResourcesSuggestion: [{
          title: 'King Kong of Skull Island VR title page',
          url: 'https://rawthrills.com/games/king-kong-of-skull-island-vr/',
          sourceType: 'support',
          matchScore: 67,
        }],
        supportContactsSuggestion: [],
        alternateNames: ['King Kong VR'],
        searchHints: [],
        likelyCategory: 'vr',
        matchType: 'title_specific_source',
        manualReady: false,
        manualUrl: '',
        manualSourceUrl: 'https://rawthrills.com/games/king-kong-of-skull-island-vr/',
        supportUrl: 'https://rawthrills.com/games/king-kong-of-skull-island-vr/',
        oneFollowupQuestion: '',
        manualMatchSummary: {
          matchType: 'title_specific_source',
          manualReady: false,
          manualUrl: '',
          manualSourceUrl: 'https://rawthrills.com/games/king-kong-of-skull-island-vr/',
          supportUrl: 'https://rawthrills.com/games/king-kong-of-skull-island-vr/',
        },
        pipelineMeta: {
          stage1MatchType: 'title_specific_source',
          stage2Ran: true,
          sourcePageExtracted: true,
          acquisitionSucceeded: false,
        },
      }),
      findReusableVerifiedManuals: async () => [],
      verifyDocumentationSuggestions: async () => [],
    }
  });

  assert.equal(result.status, 'followup_needed');
  assert.deepEqual(assetWrites.at(-1).payload.manualLinks, []);
  assert.equal(assetWrites.at(-1).payload.manualLibraryRef, '');
  assert.equal(assetWrites.at(-1).payload.manualStoragePath, '');
  assert.equal(assetWrites.at(-1).payload.enrichmentStatus, 'followup_needed');
  assert.equal(assetWrites.at(-1).payload.supportUrl, 'https://rawthrills.com/games/king-kong-of-skull-island-vr/');
});

function createEnrichmentDb(asset = {}) {
  const assetState = { id: 'asset-1', ...asset };
  const assetWrites = [];
  const auditWrites = [];
  const assetRef = {
    async get() {
      return { exists: true, data: () => ({ ...assetState }) };
    },
    async set(payload, options = {}) {
      assetWrites.push({ payload, options });
      Object.assign(assetState, payload);
    }
  };
  return {
    db: {
      collection(name) {
        if (name === 'assets') return { doc: () => assetRef };
        if (name === 'auditLogs') return { add: async (payload) => auditWrites.push(payload) };
        throw new Error(`Unexpected collection ${name}`);
      }
    },
    assetWrites,
    auditWrites,
    assetState
  };
}

test('enrichAssetDocumentation writes lookup_failed when discovery repeatedly fails after searching state', async () => {
  const { db, assetWrites, assetState } = createEnrichmentDb({ name: 'Broken Search', companyId: 'company-1' });

  await assert.rejects(() => enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'manual',
    followupAnswer: '',
    traceId: 'trace-fail',
    dependencies: {
      runLookupPreview: async () => { throw new Error('fetch failed'); }
    }
  }), /fetch failed/);

  assert.equal(assetWrites[0].payload.enrichmentStatus, 'in_progress');
  assert.equal(assetWrites.at(-1).payload.enrichmentStatus, 'lookup_failed');
  assert.equal(assetState.enrichmentErrorCode, 'unknown');
  assert.match(assetState.enrichmentErrorMessage, /fetch failed/);
  assert.ok(assetState.enrichmentFailedAt);
});

test('enrichAssetDocumentation degrades empty discovery results to terminal no_match_yet', async () => {
  const { db, assetWrites } = createEnrichmentDb({ name: 'Missing Manual', companyId: 'company-1' });

  const result = await enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'post_save',
    followupAnswer: '',
    traceId: 'trace-empty',
    dependencies: {
      runLookupPreview: async () => ({
        confidence: 0.2,
        normalizedName: 'Missing Manual',
        likelyManufacturer: 'Unknown',
        documentationSuggestions: [],
        supportResourcesSuggestion: [],
        supportContactsSuggestion: [],
        alternateNames: [],
        searchHints: [],
        oneFollowupQuestion: '',
        likelyCategory: '',
        topMatchReason: ''
      }),
      findReusableVerifiedManuals: async () => [],
      verifyDocumentationSuggestions: async () => []
    }
  });

  assert.equal(result.status, 'no_match_yet');
  assert.equal(assetWrites[0].payload.enrichmentStatus, 'searching_docs');
  assert.equal(assetWrites.at(-1).payload.enrichmentStatus, 'no_match_yet');
});

test('enrichAssetDocumentation marks Fast & Furious support-only result as followup_needed instead of lookup_failed', async () => {
  const { db, assetWrites } = createEnrichmentDb({ name: 'Fast & Furious', manufacturer: 'Raw Thrills', companyId: 'company-1' });

  const result = await enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'manual',
    followupAnswer: '',
    traceId: 'trace-fast-furious',
    dependencies: {
      runLookupPreview: async () => ({
        confidence: 0.62,
        normalizedName: 'Fast and Furious',
        likelyManufacturer: 'Raw Thrills',
        documentationSuggestions: [],
        supportResourcesSuggestion: [{ title: 'Fast & Furious product page', url: 'https://rawthrills.com/games/fast-furious-arcade/#respond', sourceType: 'support', matchScore: 62 }],
        supportContactsSuggestion: [],
        alternateNames: [],
        searchHints: [],
        oneFollowupQuestion: '',
        likelyCategory: 'video',
        topMatchReason: ''
      }),
      findReusableVerifiedManuals: async () => [],
      verifyDocumentationSuggestions: async () => []
    }
  });

  assert.equal(result.status, 'followup_needed');
  assert.equal(assetWrites.at(-1).payload.enrichmentStatus, 'followup_needed');
  assert.deepEqual(assetWrites.at(-1).payload.supportResourcesSuggestion.map((entry) => entry.url), ['https://rawthrills.com/games/fast-furious-arcade/']);
});

test('enrichAssetDocumentation marks follow-up-plus-support cases as followup_needed and not lookup_failed', async () => {
  const { db, assetWrites } = createEnrichmentDb({ name: 'King Kong', companyId: 'company-1' });

  const result = await enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'manual',
    followupAnswer: '',
    traceId: 'trace-king-kong',
    dependencies: {
      runLookupPreview: async () => ({
        confidence: 0.41,
        normalizedName: 'King Kong',
        likelyManufacturer: 'Unknown',
        documentationSuggestions: [],
        supportResourcesSuggestion: [{ title: 'King Kong help', url: 'https://example.com/king-kong-support', sourceType: 'support', matchScore: 55 }],
        supportContactsSuggestion: [],
        alternateNames: [],
        searchHints: [],
        oneFollowupQuestion: 'Which cabinet version is this?',
        likelyCategory: '',
        topMatchReason: ''
      }),
      findReusableVerifiedManuals: async () => [],
      verifyDocumentationSuggestions: async () => []
    }
  });

  assert.equal(result.status, 'followup_needed');
  assert.equal(assetWrites.at(-1).payload.enrichmentStatus, 'followup_needed');
  assert.equal(assetWrites.at(-1).payload.reviewState, 'followup_needed');
});

test('enrichAssetDocumentation keeps Break the Plate unresolved results out of lookup_failed', async () => {
  const { db, assetWrites } = createEnrichmentDb({ name: 'Break the Plate', companyId: 'company-1' });

  const result = await enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'manual',
    followupAnswer: '',
    traceId: 'trace-break-the-plate',
    dependencies: {
      runLookupPreview: async () => ({
        confidence: 0.18,
        normalizedName: 'Break the Plate',
        likelyManufacturer: '',
        documentationSuggestions: [],
        supportResourcesSuggestion: [],
        supportContactsSuggestion: [],
        alternateNames: [],
        searchHints: [],
        oneFollowupQuestion: '',
        likelyCategory: '',
        topMatchReason: ''
      }),
      findReusableVerifiedManuals: async () => [],
      verifyDocumentationSuggestions: async () => []
    }
  });

  assert.equal(result.status, 'no_match_yet');
  assert.equal(assetWrites.at(-1).payload.enrichmentStatus, 'no_match_yet');
  assert.notEqual(assetWrites.at(-1).payload.enrichmentStatus, 'lookup_failed');
});

test('enrichAssetDocumentation writes defensive failure after terminal candidate calculation throws unexpectedly', async () => {
  const { db, assetWrites } = createEnrichmentDb({ name: 'Throw Later', companyId: 'company-1' });

  await assert.rejects(() => enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'manual',
    followupAnswer: '',
    traceId: 'trace-late-throw',
    dependencies: {
      runLookupPreview: async () => ({
        confidence: 0.8,
        normalizedName: 'Throw Later',
        likelyManufacturer: 'Bay Tek Games',
        documentationSuggestions: [{ title: 'Candidate', url: 'https://example.com/manual.pdf', sourceType: 'manufacturer' }],
        supportResourcesSuggestion: [],
        supportContactsSuggestion: [],
        alternateNames: [],
        searchHints: []
      }),
      findReusableVerifiedManuals: async () => [],
      verifyDocumentationSuggestions: async () => { throw new Error('verification exploded'); }
    }
  }), /verification exploded/);

  assert.equal(assetWrites[0].payload.enrichmentStatus, 'in_progress');
  assert.equal(assetWrites.at(-1).payload.enrichmentStatus, 'lookup_failed');
  assert.match(assetWrites.at(-1).payload.enrichmentErrorMessage, /verification exploded/);
});


test('enrichAssetDocumentation rehydrates exact catalog manuals when live preview only persists catalog metadata for Quik Drop', async () => {
  const { db, assetWrites, assetState } = createEnrichmentDb({ name: 'Quik Drop', manufacturer: 'Bay Tek Games', companyId: 'company-1' });

  const result = await enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'manual',
    followupAnswer: '',
    traceId: 'trace-quik-drop-live-regression',
    dependencies: {
      runLookupPreview: async () => ({
        confidence: 0.92,
        normalizedName: 'Quik Drop',
        likelyManufacturer: 'Bay Tek Games',
        documentationSuggestions: [],
        supportResourcesSuggestion: [{
          title: 'Quik Drop source page',
          url: 'https://www.baytekent.com/games/quik-drop/',
          sourceType: 'support',
          exactTitleMatch: true,
          exactManualMatch: false,
          trustedSource: true,
          matchScore: 84
        }],
        supportContactsSuggestion: [],
        alternateNames: ['Quick Drop'],
        searchHints: [],
        likelyCategory: 'redemption',
        catalogMatch: {
          catalogEntryId: 'bay-tek-quik-drop',
          matchStatus: 'catalog_exact',
          confidence: 0.99,
          lookupMethod: 'workbook_seed_exact_pdf',
          notes: 'Workbook exact match'
        }
      }),
      findReusableVerifiedManuals: async () => [],
      verifyDocumentationSuggestions: async (rows) => rows.map((row) => ({
        ...row,
        verified: row.url === 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
        verificationKind: row.url.endsWith('.pdf') ? 'direct_pdf' : 'support_html',
        verificationStatus: row.url.endsWith('.pdf') ? 'seed_verified' : 'verified',
        deadPage: false,
        unreachable: false,
        trustedSource: true,
        exactTitleMatch: row.url.endsWith('.pdf') ? true : row.exactTitleMatch,
        exactManualMatch: row.url.endsWith('.pdf') ? true : row.exactManualMatch
      }))
    }
  });

  assert.equal(result.status, 'docs_found');
  assert.equal(assetWrites.at(-1).payload.enrichmentStatus, 'docs_found');
  assert.equal(assetWrites.at(-1).payload.reviewState, 'pending_review');
  assert.equal(assetState.documentationSuggestions[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(assetState.manualLookupCatalogMatch.matchStatus, 'catalog_exact');
});

test('enrichAssetDocumentation preserves Quik Drop exact manual success path', async () => {
  const { db, assetWrites, assetState } = createEnrichmentDb({ name: 'Quik Drop', manufacturer: 'Bay Tek Games', companyId: 'company-1' });

  const result = await enrichAssetDocumentation({
    db,
    assetId: 'asset-1',
    userId: 'user-1',
    settings: { aiConfidenceThreshold: 0.45 },
    triggerSource: 'manual',
    followupAnswer: '',
    traceId: 'trace-quik-drop',
    dependencies: {
      runLookupPreview: async () => ({
        confidence: 0.92,
        normalizedName: 'Quik Drop',
        likelyManufacturer: 'Bay Tek Games',
        documentationSuggestions: [{
          title: 'Quik Drop Service Manual PDF',
          url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
          sourceType: 'distributor',
          exactTitleMatch: true,
          exactManualMatch: true,
          matchScore: 96,
          trustedSource: true,
          verified: true
        }],
        supportResourcesSuggestion: [],
        supportContactsSuggestion: [],
        alternateNames: [],
        searchHints: [],
        likelyCategory: 'redemption'
      }),
      findReusableVerifiedManuals: async () => [],
      verifyDocumentationSuggestions: async (rows) => rows
    }
  });

  assert.equal(result.status, 'docs_found');
  assert.equal(assetWrites.at(-1).payload.enrichmentStatus, 'docs_found');
  assert.equal(assetState.documentationSuggestions[0].url, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
});
