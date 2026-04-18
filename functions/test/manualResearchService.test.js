const test = require('node:test');
const assert = require('node:assert/strict');

const { researchAssetTitles } = require('../src/services/manualResearchService');
const { extractManualLinksFromHtmlPage } = require('../src/services/manualDiscoveryService');

function createDoc(data = {}, id = 'doc-1') {
  return { id, data: () => data };
}

function createDb({ cache = {}, manuals = [], assets = [], manualLibrary = {} } = {}) {
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
      if (name === 'manualLibrary') {
        return {
          where(field, op, value) { this._filters = [...(this._filters || []), [field, value]]; return this; },
          limit() { return this; },
          async get() {
            const docs = Object.entries(manualLibrary)
              .filter(([, row]) => (this._filters || []).every(([field, value]) => row[field] === value))
              .map(([id, row]) => createDoc(row, id));
            return { empty: docs.length === 0, docs };
          },
          doc(id) { return { async set(value) { manualLibrary[id] = { ...(manualLibrary[id] || {}), ...value }; } }; },
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

function createStorageMock() { return { bucket() { return { file() { return { save: async () => {} }; } }; } }; }

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
        arrayBuffer: async () => Buffer.from('%PDF-1.4\nmanual'),
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
    storage: createStorageMock(),
    researchFallback: async () => {
      stageTwoCalls += 1;
      throw new Error('stage two should not run for exact catalog manuals');
    },
  });

  assert.equal(stageTwoCalls, 0);
  assert.equal(result.results[0].matchType, 'exact_manual');
  assert.equal(result.results[0].manualReady, true);
  assert.match(result.results[0].manualUrl, /^manual-library\/bay-tek\/quik-drop\/.+\.pdf$/i);
  assert.ok(result.results[0].manualLibraryRef);
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
    storage: createStorageMock(),
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
  assert.equal(result.results[0].matchType, 'exact_manual');
  assert.equal(result.results[0].manualReady, true);
  assert.match(result.results[0].manualUrl, /^manual-library\/raw-thrills\/king-kong-of-skull-island-vr\/.+\.pdf$/i);
  assert.equal(result.results[0].supportUrl, 'https://rawthrills.com/games/king-kong-of-skull-island/');
  assert.equal(result.results[0].manualMatchSummary.matchType, result.results[0].matchType);
  assert.equal(result.results[0].manualMatchSummary.supportUrl, result.results[0].supportUrl);
  assert.ok(Array.isArray(result.results[0].pipelineMeta.searchEvidence));
  assert.ok(result.results[0].documentationSuggestions.every((entry) => typeof entry.candidateBucket === 'string' && entry.candidateBucket));
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
      storage: createStorageMock(),
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


test('researchAssetTitles rejects Sink-It junk manual urls from stage 2 fallback everywhere', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args); };
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true, manualResearchWebSearchEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'Willy Wonka Mystery', manufacturerHint: 'Unknown' }],
      traceId: 'test-sink-it-junk',
      fetchImpl: createFetchMock(),
      storage: createStorageMock(),
      researchFallback: async () => ({
        normalizedTitle: 'Willy Wonka Mystery',
        manufacturer: 'Bay Tek Games',
        manufacturerInferred: false,
        matchType: 'exact_manual',
        manualReady: true,
        reviewRequired: false,
        manualUrl: 'https://baytekent.com/office-coffee-machines/willy-wonka-mystery/',
        manualSourceUrl: 'https://baytekent.com/financial-services/willy-wonka-mystery/',
        supportUrl: 'https://baytekent.com/installations/willy-wonka-mystery/',
        confidence: 0.83,
        matchNotes: 'junk links should be rejected',
        citations: [],
        rawResearchSummary: 'junk links only',
      }),
    });

    assert.equal(result.results[0].manualReady, false);
    assert.equal(result.results[0].manualUrl, '');
    assert.equal(result.results[0].supportUrl, '');
    assert.deepEqual(result.results[0].documentationSuggestions, []);
    assert.deepEqual(result.results[0].supportResourcesSuggestion, []);
    assert.ok(logs.some((entry) => entry[0] === 'manualResearch:candidate_rejected'));
  } finally {
    console.log = originalLog;
  }
});
test('researchAssetTitles emits explicit logs and backend validation can promote a real manual', async () => {
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
      storage: createStorageMock(),
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        headers: { get: () => (String(url).endsWith('.pdf') ? 'application/pdf' : 'text/html') },
        text: async () => '',
        arrayBuffer: async () => Buffer.from('%PDF-1.4\nmanual'),
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
    assert.match(result.results[0].manualUrl, /^manual-library\/raw-thrills\/king-kong-of-skull-island-vr\/.+\.pdf$/i);
    const markers = logs.map((entry) => entry[0]);
    assert.ok(markers.includes('manualResearch:stage2_start'));
    assert.ok(markers.includes('manualResearch:stage2_prompt_built'));
    assert.ok(markers.includes('manualResearch:stage2_response_received'));
    assert.ok(markers.includes('manualResearch:stage2_candidates_extracted'));
    assert.ok(markers.includes('manualResearch:final_result'));
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles degrades stalled Quick Drop acquisition to terminal followup_needed', async () => {
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Quick Drop', manufacturerHint: 'Bay Tek Games' }],
    traceId: 'test-quick-drop-timeout',
    storage: createStorageMock(),
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith('.pdf')) {
        return new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html' },
        text: async () => '',
      };
    },
  });

  assert.equal(result.results[0].manualReady, false);
  assert.equal(result.results[0].status, 'followup_needed');
  assert.equal(result.results[0].manualLibraryRef, '');
  assert.equal(result.results[0].pipelineMeta.acquisitionState, 'timed_out');
});

test('researchAssetTitles degrades thrown Fast & Furious acquisition errors to a terminal followup result', async () => {
  const failingStorage = {
    bucket() {
      return {
        file() {
          return {
            async save() {
              throw new Error('storage upload blew up');
            }
          };
        }
      };
    }
  };
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Fast & Furious', manufacturerHint: 'Raw Thrills' }],
    traceId: 'test-fast-furious-acquire-fail',
    storage: failingStorage,
    fetchImpl: async (url) => {
      if (String(url).endsWith('.pdf')) {
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => 'application/pdf' },
          arrayBuffer: async () => Buffer.from('%PDF-1.4\nmanual'),
        };
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html' },
        text: async () => '',
      };
    },
  });

  assert.equal(result.results[0].manualReady, false);
  assert.equal(result.results[0].status, 'followup_needed');
  assert.equal(result.results[0].pipelineMeta.acquisitionState, 'failed');
  assert.match(result.results[0].pipelineMeta.acquisitionError, /storage upload blew up/);
});

test('researchAssetTitles logs candidate_rejected when stage 2 returns support-only junk manual urls', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args); };
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'Sink-It', manufacturerHint: 'Bay Tek Games' }],
      traceId: 'test-sink-it-candidate-rejected',
      storage: createStorageMock(),
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html' },
        text: async () => 'Bay Tek Sink It support resources and installations services',
      }),
      researchFallback: async () => ({
        normalizedTitle: 'Willy Wonka Mystery',
        manufacturer: 'Bay Tek Games',
        matchType: 'title_specific_source',
        manualReady: false,
        reviewRequired: true,
        manualUrl: 'https://baytekent.com/installations/sink-it-shootout/',
        manualSourceUrl: 'https://baytekent.com/games/sink-it-shootout/',
        supportUrl: 'https://baytekent.com/support/sink-it-shootout/',
        confidence: 0.41,
        matchNotes: 'Found only source/support context.',
        citations: [],
        rawResearchSummary: 'No actual manual.',
      }),
    });

    assert.equal(result.results[0].manualReady, false);
    assert.equal(result.results[0].manualUrl, '');
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:candidate_rejected'), true);
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
    storage: createStorageMock(),
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

test('manual-like candidate URL that is dead never promotes docs_found and remains followup_needed', async () => {
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Dead Link Racer', manufacturerHint: 'Raw Thrills' }],
    traceId: 'test-dead-manual-url',
    storage: createStorageMock(),
    fetchImpl: async (url) => {
      if (String(url).endsWith('.pdf')) {
        return {
          ok: false,
          status: 404,
          url,
          headers: { get: () => 'application/pdf' },
          arrayBuffer: async () => Buffer.from(''),
        };
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html' },
        text: async () => 'Support page only',
      };
    },
    researchFallback: async () => ({
      normalizedTitle: 'Dead Link Racer',
      manufacturer: 'Raw Thrills',
      matchType: 'exact_manual',
      manualReady: true,
      reviewRequired: false,
      manualUrl: 'https://rawthrills.com/manuals/dead-link-racer-operator-manual.pdf',
      manualSourceUrl: 'https://rawthrills.com/games/dead-link-racer/',
      supportUrl: 'https://rawthrills.com/service-support/',
      confidence: 0.79,
      matchNotes: 'Manual-looking URL found but inaccessible.',
      citations: [],
      rawResearchSummary: 'Dead PDF URL.',
    }),
  });

  assert.equal(result.results[0].manualReady, false);
  assert.equal(result.results[0].status, 'followup_needed');
  assert.equal(result.results[0].manualLibraryRef, '');
  assert.equal(result.results[0].manualStoragePath, '');
  assert.equal(result.results[0].manualUrl, '');
  assert.equal(result.results[0].pipelineMeta.acquisitionState, 'no_manual');
});

test('source page that exists but has no downloadable manual stays support/followup and never attaches', async () => {
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Support Hub Deluxe', manufacturerHint: 'Bay Tek Games' }],
    traceId: 'test-source-without-download',
    storage: createStorageMock(),
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/html' },
      text: async () => '<html><body><a href="/support">Support</a><a href="/contact">Contact</a></body></html>',
    }),
    researchFallback: async () => ({
      normalizedTitle: 'Support Hub Deluxe',
      manufacturer: 'Bay Tek Games',
      matchType: 'manual_page_with_download',
      manualReady: true,
      reviewRequired: false,
      manualUrl: 'https://baytekent.com/games/support-hub-deluxe/',
      manualSourceUrl: 'https://baytekent.com/games/support-hub-deluxe/',
      supportUrl: 'https://baytekent.com/support/',
      confidence: 0.66,
      matchNotes: 'Page is reachable but no downloadable document.',
      citations: [],
      rawResearchSummary: 'No PDF link present.',
    }),
  });

  assert.equal(result.results[0].manualReady, false);
  assert.equal(result.results[0].status, 'followup_needed');
  assert.equal(result.results[0].manualUrl, '');
  assert.equal(result.results[0].manualLibraryRef, '');
  assert.equal(result.results[0].pipelineMeta.acquisitionState, 'no_manual');
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
    storage: createStorageMock(),
    researchFallback: async () => {
      stageTwoCalls += 1;
      throw new Error('stage two should not run when approved manual reuse resolves the title');
    },
  });

  assert.equal(stageTwoCalls, 0);
  assert.equal(result.results[0].manualReady, true);
  assert.match(result.results[0].manualUrl, /^manual-library\/bay-tek\/quik-drop\/.+\.pdf$/i);
  assert.ok(result.results[0].manualLibraryRef);
});
