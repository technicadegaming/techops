const test = require('node:test');
const assert = require('node:assert/strict');

const { researchAssetTitles } = require('../src/services/manualResearchService');

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
  assert.equal(result.results[0].matchType, 'support_only');
  assert.equal(result.results[0].manualReady, false);
  assert.equal(result.results[0].reviewRequired, true);
  assert.equal(result.results[0].supportUrl, 'https://rawthrills.com/service-support/');
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
