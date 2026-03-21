const test = require('node:test');
const assert = require('node:assert/strict');

const { researchAssetTitles } = require('../src/services/manualResearchService');
const { extractManualLinksFromHtmlPage } = require('../src/services/manualDiscoveryService');

function createDoc(data = {}, id = 'doc-1') {
  return { id, data: () => data };
}

function createDb({ cache = {}, manuals = [], assets = [] } = {}) {
  return {
    collection(name) {
      if (name === 'assetTitleResearchCache') {
        return {
          doc(id) {
            return {
              async get() {
                const value = cache[id];
                return {
                  exists: !!value,
                  data: () => value,
                };
              },
              async set(value) {
                cache[id] = { ...(cache[id] || {}), ...value };
              },
            };
          },
        };
      }
      if (name === 'manuals') {
        return {
          where() { return this; },
          limit() { return this; },
          async get() { return { docs: manuals.map((entry, index) => createDoc(entry, `manual-${index + 1}`)) }; },
        };
      }
      if (name === 'assets') {
        return {
          where() { return this; },
          limit() { return this; },
          async get() { return { docs: assets.map((entry, index) => createDoc(entry, `asset-${index + 1}`)) }; },
        };
      }
      throw new Error(`Unexpected collection ${name}`);
    },
  };
}

function createFetchMock() {
  return async (url, options = {}) => {
    const lowerUrl = `${url}`.toLowerCase();
    if (lowerUrl.endsWith('.pdf')) {
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'application/pdf' },
        text: async () => '',
      };
    }
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/html' },
      text: async () => options.method === 'HEAD'
        ? ''
        : 'Operator manual support page for arcade game with title-specific references and support contacts.',
    };
  };
}

test('researchAssetTitles keeps stage 1 exact manuals without invoking stage 2 fallback', async () => {
  let stageTwoCalls = 0;
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Quick Drop', manufacturerHint: 'Bay Tek Games' }],
    traceId: 'test-quick-drop',
    fetchImpl: createFetchMock(),
    researchFallback: async () => {
      stageTwoCalls += 1;
      throw new Error('stage two should not run for exact catalog manuals');
    },
  });

  assert.equal(stageTwoCalls, 0);
  assert.equal(result.results[0].matchType, 'exact_manual');
  assert.equal(result.results[0].manualReady, true);
  assert.match(result.results[0].manualUrl, /quik-drop-service-manual\.pdf/i);
});

test('researchAssetTitles invokes stage 2 fallback only for unresolved review-required titles', async () => {
  let stageTwoCalls = 0;
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true, manualResearchWebSearchEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'King Kong VR', manufacturerHint: 'Raw Thrills' }],
    traceId: 'test-king-kong',
    fetchImpl: createFetchMock(),
    researchFallback: async () => {
      stageTwoCalls += 1;
      return {
        normalizedTitle: 'King Kong of Skull Island',
        manufacturer: 'Raw Thrills',
        manufacturerInferred: false,
        matchType: 'support_only',
        manualReady: false,
        reviewRequired: true,
        manualUrl: '',
        manualSourceUrl: 'https://rawthrills.com/games/king-kong-of-skull-island/',
        supportUrl: 'https://rawthrills.com/service-support/',
        supportEmail: 'support@rawthrills.com',
        supportPhone: '(847) 459-5000',
        confidence: 0.62,
        matchNotes: 'Found product and support context but no verified manual.',
        citations: [{ url: 'https://rawthrills.com/service-support/', title: 'Raw Thrills Service Support' }],
        rawResearchSummary: 'No downloadable manual located on official sources.',
      };
    },
  });

  assert.equal(stageTwoCalls, 1);
  assert.equal(result.results[0].matchType, 'title_specific_source');
  assert.equal(result.results[0].manualReady, false);
  assert.equal(result.results[0].reviewRequired, true);
  assert.equal(result.results[0].supportUrl, 'https://rawthrills.com/games/king-kong-of-skull-island/');
});

for (const matchType of ['title_specific_source', 'support_only', 'family_match_needs_review', 'unresolved']) {
  test(`researchAssetTitles forces stage 2 fallback when stage 1 resolves as ${matchType}`, async () => {
    let stageTwoCalls = 0;
    const result = await researchAssetTitles({
      db: createDb({
        cache: {
          'company-1-virtual-rabbids-lai-games': {
            updatedAtMs: Date.now(),
            result: {
              normalizedTitle: 'Virtual Rabbids: The Big Ride',
              manufacturer: 'LAI Games',
              manufacturerInferred: false,
              matchType: 'support_only',
              manualReady: false,
              reviewRequired: true,
              manualUrl: '',
              manualSourceUrl: 'https://laigames.com/virtual-rabbids-the-big-ride/',
              supportUrl: 'https://laigames.com/support/',
              confidence: 0.54,
              citations: [],
              rawResearchSummary: 'cached'
            }
          }
        }
      }),
      settings: { aiEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'Virtual Rabbids', manufacturerHint: 'LAI Games' }],
      traceId: `test-${matchType}`,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => ''
      }),
      researchFallback: async ({ context }) => {
        stageTwoCalls += 1;
        return {
          normalizedTitle: context.normalizedTitle,
          manufacturer: 'LAI Games',
          matchType,
          manualReady: false,
          reviewRequired: true,
          manualUrl: '',
          manualSourceUrl: 'https://laigames.com/virtual-rabbids-the-big-ride/',
          supportUrl: 'https://laigames.com/support/',
          supportEmail: '',
          supportPhone: '',
          confidence: 0.54,
          matchNotes: 'No verified manual.',
          citations: [],
          rawResearchSummary: `Result ${matchType}`
        };
      },
    });

    assert.equal(stageTwoCalls, 1);
    assert.equal(result.results[0].manualReady, false);
    assert.equal(result.results[0].reviewRequired, true);
  });
}

test('researchAssetTitles emits explicit stage 2 logs and backend validation can promote a real manual', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args); };
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true, manualResearchModel: 'gpt-5-mini' },
      companyId: 'company-1',
      titles: [{ originalTitle: 'King Kong VR', manufacturerHint: 'Raw Thrills' }],
      traceId: 'test-stage2-logs',
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        headers: { get: () => (String(url).endsWith('.pdf') ? 'application/pdf' : 'text/html') },
        text: async () => '',
      }),
      researchFallback: async () => ({
        normalizedTitle: 'King Kong of Skull Island VR',
        manufacturer: 'Raw Thrills',
        manufacturerInferred: false,
        matchType: 'exact_manual',
        manualReady: true,
        reviewRequired: false,
        manualUrl: 'https://rawthrills.com/wp-content/uploads/king-kong-of-skull-island-vr-operator-manual.pdf',
        manualSourceUrl: 'https://rawthrills.com/games/king-kong-of-skull-island-vr/',
        supportUrl: 'https://rawthrills.com/games/king-kong-of-skull-island-vr/',
        supportEmail: 'support@rawthrills.com',
        supportPhone: '(847) 459-5000',
        confidence: 0.84,
        matchNotes: 'Official operator manual found.',
        citations: [{ url: 'https://rawthrills.com/games/king-kong-of-skull-island-vr/', title: 'King Kong of Skull Island VR' }],
        rawResearchSummary: 'Found official PDF.',
        responseMeta: { model: 'gpt-5-mini' }
      }),
    });

    assert.equal(result.results[0].manualReady, true);
    assert.match(result.results[0].manualUrl, /king-kong-of-skull-island-vr-operator-manual\.pdf/i);
    const markers = logs.map((entry) => entry[0]);
    assert.ok(markers.includes('manualResearch:stage2_start'));
    assert.ok(markers.includes('manualResearch:stage2_prompt_built'));
    assert.ok(markers.includes('manualResearch:stage2_response_received'));
    assert.ok(markers.includes('manualResearch:stage2_candidates_extracted'));
    assert.ok(markers.includes('manualResearch:stage2_result'));
  } finally {
    console.log = originalLog;
  }
});

test('extractManualLinksFromHtmlPage rejects junk chrome/footer/installations links', async () => {
  const result = await extractManualLinksFromHtmlPage({
    pageUrl: 'https://example.com/sink-it-shootout',
    pageTitle: 'Sink-It Shootout',
    manufacturer: 'Bay Tek',
    titleVariants: ['sink it', 'sink it shootout'],
    manufacturerProfile: {
      key: 'bay tek',
      aliases: ['bay tek games'],
      sourceTokens: ['baytekent.com', 'betson.com'],
      preferredSourceTokens: ['baytekent.com']
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => `
        <html><body>
          <a href="/consultative-services/">Consultative Services</a>
          <a href="/installations/">Installations</a>
          <footer><a href="/contact-us/">Contact</a></footer>
          <nav><a href="/search/?s=Sink-It">Search</a></nav>
          <a href="https://www.betson.com/wp-content/uploads/2019/09/Sink-It-Shootout-Operator-Manual.pdf">Sink-It Shootout Operator Manual PDF</a>
        </body></html>
      `
    }),
  });

  assert.deepEqual(result.map((entry) => entry.url), [
    'https://www.betson.com/wp-content/uploads/2019/09/Sink-It-Shootout-Operator-Manual.pdf'
  ]);
});

test('stage 2 support-only context never produces docs_found semantics', async () => {
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'HYPERshoot', manufacturerHint: 'LAI Games' }],
    traceId: 'test-hypershoot-support',
    fetchImpl: createFetchMock(),
    researchFallback: async () => ({
      normalizedTitle: 'HYPERshoot',
      manufacturer: 'LAI Games',
      matchType: 'support_only',
      manualReady: false,
      reviewRequired: true,
      manualUrl: 'https://laigames.com/support/hypershoot/',
      manualSourceUrl: 'https://laigames.com/hypershoot/',
      supportUrl: 'https://laigames.com/support/hypershoot/',
      supportEmail: '',
      supportPhone: '',
      confidence: 0.58,
      matchNotes: 'Support context only.',
      citations: [],
      rawResearchSummary: 'No manual'
    }),
  });

  assert.equal(result.results[0].manualReady, false);
  assert.equal(result.results[0].status, 'followup_needed');
  assert.equal(result.results[0].manualUrl, '');
  assert.notEqual(result.results[0].matchType, 'exact_manual');
  assert.notEqual(result.results[0].status, 'docs_found');
});

test('researchAssetTitles reuses previously approved company manuals before web fallback', async () => {
  let stageTwoCalls = 0;
  const result = await researchAssetTitles({
    db: createDb({
      manuals: [{
        companyId: 'company-1',
        assetId: 'asset-10',
        sourceUrl: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
        sourceTitle: 'Quik Drop Service Manual',
        manufacturer: 'Bay Tek Games',
        matchedManufacturer: 'bay tek',
        assetTitle: 'Quik Drop',
        family: 'Quik Drop',
        manualType: 'operator_manual',
        manualConfidence: 0.95,
      }],
    }),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Quick Drop' }],
    traceId: 'test-reuse',
    fetchImpl: createFetchMock(),
    researchFallback: async () => {
      stageTwoCalls += 1;
      throw new Error('stage two should not run when approved manual reuse resolves the title');
    },
  });

  assert.equal(stageTwoCalls, 0);
  assert.equal(result.results[0].manualReady, true);
  assert.match(result.results[0].manualUrl, /quik-drop-service-manual\.pdf/i);
});
