const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { researchAssetTitles } = require('../src/services/manualResearchService');
const { extractManualLinksFromHtmlPage } = require('../src/services/manualDiscoveryService');
const { normalizeTrustedCatalogRow } = require('../src/services/trustedManualCatalogService');

function createDoc(data = {}, id = 'doc-1') {
  return { id, data: () => data };
}

function createDb({ cache = {}, manuals = [], assets = [], manualLibrary = {}, trustedManualCatalog = {} } = {}) {
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
      if (name === 'trustedManualCatalog') {
        return {
          where(field, op, value) { this._filters = [...(this._filters || []), [field, op, value]]; return this; },
          limit() { return this; },
          async get() {
            const docs = Object.entries(trustedManualCatalog)
              .filter(([, row]) => (this._filters || []).every(([field, op, value]) => {
                const fieldValue = row[field];
                if (op === 'array-contains') return Array.isArray(fieldValue) && fieldValue.includes(value);
                return fieldValue === value;
              }))
              .map(([id, row]) => createDoc(row, id));
            return { empty: docs.length === 0, docs };
          },
          doc(id) { return { async set(value) { trustedManualCatalog[id] = { ...(trustedManualCatalog[id] || {}), ...value }; } }; },
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


function trustedRow(row = {}) {
  return normalizeTrustedCatalogRow({
    assetId: row.assetId,
    'asset name': row.assetName,
    manufacturer: row.manufacturer,
    model: row.model || '',
    originalTitle: row.originalTitle || row.assetName,
    normalizedTitle: row.normalizedTitle || row.assetName,
    normalizedName: row.normalizedName || row.normalizedTitle || row.assetName,
    alternateNames: row.alternateNames || '',
    manualUrl: row.manualUrl || '',
    manualSourceUrl: row.manualSourceUrl || '',
    supportUrl: row.supportUrl || '',
    supportEmail: row.supportEmail || '',
    supportPhone: row.supportPhone || '',
    matchType: row.matchType || 'exact_manual',
    manualReady: row.manualReady,
    reviewRequired: row.reviewRequired,
    matchConfidence: row.matchConfidence,
  });
}

test('researchAssetTitles runs OpenAI first and still resolves durable Quick Drop manuals', async () => {
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
      return {
        normalizedTitle: 'Quik Drop',
        manufacturer: 'Bay Tek Games',
        manufacturerInferred: false,
        matchType: 'support_only',
        manualReady: false,
        reviewRequired: true,
        manualUrl: '',
        manualSourceUrl: 'https://parts.baytekent.com/support/quik-drop',
        supportUrl: 'https://parts.baytekent.com/support/quik-drop',
        supportEmail: '',
        supportPhone: '',
        confidence: 0.42,
        matchNotes: 'OpenAI yielded weak support-only leads; trigger fallback scraping.',
        candidates: [],
        citations: [],
        rawResearchSummary: 'No verified candidate returned from OpenAI.',
      };
    },
  });

  assert.equal(stageTwoCalls, 1);
  assert.equal(result.results[0].matchType, 'exact_manual');
  assert.equal(result.results[0].manualReady, true);
  assert.match(result.results[0].manualUrl, /^manual-library\/bay-tek(?:-games)?\/quik-drop\/.+\.pdf$/i);
  assert.ok(result.results[0].manualLibraryRef);
});

test('researchAssetTitles invokes OpenAI path first for unresolved review-required titles', async () => {
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
        candidates: [
          {
            bucket: 'verified_pdf_candidate',
            url: 'https://rawthrills.com/wp-content/uploads/king-kong-of-skull-island-vr-operator-manual.pdf',
            title: 'King Kong of Skull Island VR Operator Manual',
            sourceDomain: 'rawthrills.com',
            whyMatch: 'Exact title and manufacturer match.',
            confidence: 0.92,
          },
        ],
        selectedCandidate: {
          bucket: 'verified_pdf_candidate',
          url: 'https://rawthrills.com/wp-content/uploads/king-kong-of-skull-island-vr-operator-manual.pdf',
          title: 'King Kong of Skull Island VR Operator Manual',
          sourceDomain: 'rawthrills.com',
          whyMatch: 'Exact title and manufacturer match.',
          confidence: 0.92,
        },
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
  assert.equal(result.results[0].pipelineMeta.selectedCandidate?.bucket, 'verified_pdf_candidate');
  assert.match(result.results[0].pipelineMeta.selectedCandidate?.url || '', /king-kong-of-skull-island-vr-operator-manual\.pdf/i);
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
      titles: [{
        originalTitle: 'Virtual Rabbids',
        manufacturerHint: 'LAI Games',
        deadCandidateUrls: ['https://laigames.com/downloads/virtual-rabbids-the-big-ride-install-guide.pdf'],
      }],
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
        candidates: [{
          bucket: 'verified_pdf_candidate',
          url: 'https://rawthrills.com/wp-content/uploads/king-kong-of-skull-island-vr-operator-manual.pdf',
          title: 'King Kong of Skull Island VR Operator Manual',
          sourceDomain: 'rawthrills.com',
          whyMatch: 'Official PDF on manufacturer domain.',
          confidence: 0.9,
        }],
        selectedCandidate: {
          bucket: 'verified_pdf_candidate',
          url: 'https://rawthrills.com/wp-content/uploads/king-kong-of-skull-island-vr-operator-manual.pdf',
          title: 'King Kong of Skull Island VR Operator Manual',
          sourceDomain: 'rawthrills.com',
          whyMatch: 'Official PDF on manufacturer domain.',
          confidence: 0.9,
        },
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
    assert.ok(markers.includes('manualResearch:openai_candidate_json_returned'));
    assert.ok(markers.includes('manualResearch:OPENAI_SEARCH_STARTED'));
    assert.ok(markers.includes('manualResearch:OPENAI_CANDIDATES_RECEIVED'));
    assert.ok(markers.includes('manualResearch:OPENAI_SELECTED_CANDIDATE'));
    assert.ok(markers.includes('manualResearch:ACQUISITION_RESULT'));
    assert.ok(markers.includes('manualResearch:TERMINAL_STATUS_REASON'));
    assert.ok(markers.includes('manualResearch:stage2_candidates_extracted'));
    assert.ok(markers.includes('manualResearch:final_result'));
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles promotes discovered exact-title manual over dead adapter guess candidate', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args); };
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true, manualResearchWebSearchEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'Virtual Rabbids', manufacturerHint: 'LAI Games' }],
      traceId: 'test-rabbids-candidate-promotion',
      storage: createStorageMock(),
      fetchImpl: async (url, options = {}) => {
        if ((options.method || 'GET').toUpperCase() === 'HEAD' && /install-guide\.pdf/i.test(String(url))) {
          return { ok: false, status: 404, headers: { get: () => 'application/pdf' } };
        }
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => (String(url).endsWith('.pdf') ? 'application/pdf' : 'text/html') },
          text: async () => '',
          arrayBuffer: async () => Buffer.from('%PDF-1.4\nmanual'),
        };
      },
      researchFallback: async () => ({
        normalizedTitle: 'Virtual Rabbids: The Big Ride',
        manufacturer: 'LAI Games',
        matchType: 'support_only',
        manualReady: false,
        reviewRequired: true,
        manualUrl: '',
        manualSourceUrl: 'https://laigames.com/games/virtual-rabbids-the-big-ride/support/',
        supportUrl: 'https://laigames.com/games/virtual-rabbids-the-big-ride/support/',
        confidence: 0.65,
        candidates: [
          { bucket: 'weak_lead', url: 'https://laigames.com/games/', title: 'LAI Games - Games' },
          { bucket: 'verified_pdf_candidate', url: 'https://laigames.com/wp-content/uploads/virtual-rabbids-the-big-ride-operator-manual.pdf', title: 'Virtual Rabbids: The Big Ride Operator Manual', discoverySource: 'exact_pdf', verified: true, exactManualMatch: true },
          { bucket: 'verified_pdf_candidate', url: 'https://laigames.com/wp-content/uploads/virtual-rabbids-install-guide.pdf', title: 'Virtual Rabbids Install Guide', discoverySource: 'adapter:lai_games' },
        ],
      }),
    });
    assert.equal(result.results[0].manualReady, true);
    assert.match(result.results[0].manualUrl || '', /^manual-library\//i);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:candidate_rank_assigned'), true);
    const selectedTierEvent = logs.find((entry) => entry[0] === 'manualResearch:selected_candidate_final_tier');
    assert.equal(selectedTierEvent?.[1]?.candidateTier, 'B_exact_title_validated_manual');
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles forces durable acquisition for direct validated HYPERshoot PDF candidates', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true, manualResearchWebSearchEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'HYPERshoot', manufacturerHint: 'LAI Games' }],
      traceId: 'test-hypershoot-durable-acquisition',
      storage: createStorageMock(),
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: { get: () => (String(url).toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html') },
        text: async () => '',
        arrayBuffer: async () => Uint8Array.from(Buffer.from('%PDF-1.4\nhypershoot')).buffer,
      }),
      researchFallback: async () => ({
        normalizedTitle: 'HYPERshoot',
        manufacturer: 'LAI Games',
        matchType: 'support_only',
        manualReady: false,
        reviewRequired: true,
        manualUrl: '',
        manualSourceUrl: 'https://www.mossdistributing.com/userdocs/documents/',
        supportUrl: 'https://www.mossdistributing.com/userdocs/documents/',
        confidence: 0.77,
        candidates: [{
          bucket: 'verified_pdf_candidate',
          url: 'https://www.mossdistributing.com/userdocs/documents/MS0225_HYPERSHOOT.PDF',
          title: 'HYPERshoot Operator Manual',
          discoverySource: 'reference_row_manual_url',
          verified: true,
          exactManualMatch: true,
        }],
        selectedCandidate: {
          bucket: 'verified_pdf_candidate',
          url: 'https://www.mossdistributing.com/userdocs/documents/MS0225_HYPERSHOOT.PDF',
          title: 'HYPERshoot Operator Manual',
          discoverySource: 'reference_row_manual_url',
          verified: true,
          exactManualMatch: true,
        },
        citations: [],
        rawResearchSummary: 'Direct exact-title manual PDF discovered.',
      }),
    });

    assert.equal(result.results[0].manualReady, true);
    assert.ok(result.results[0].manualLibraryRef);
    assert.match(result.results[0].manualStoragePath, /^manual-library\//i);
    assert.equal(result.results[0].pipelineMeta.acquisitionAttempted, true);
    assert.equal(result.results[0].pipelineMeta.durableStorageCompleted, true);
    assert.equal(result.results[0].pipelineMeta.terminalStateReason, 'docs_found_after_durable_storage');
    assert.ok(`${result.results[0].manualLibraryRef || ''}`.trim());
    assert.match(result.results[0].manualStoragePath || '', /^manual-library\//i);
    const markers = logs.map((entry) => entry[0]);
    assert.equal(markers.includes('manualResearch:acquisition_eligible_candidate_detected'), true);
    assert.equal(markers.includes('manualResearch:acquisition_forced_for_direct_pdf'), true);
    assert.equal(markers.includes('manualResearch:durable_storage_completed'), true);
    assert.equal(markers.includes('manualResearch:durable_storage_completed'), true);
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles short-circuits deterministic StepManiaX workbook-seeded exact PDF into acquisition before provider fallback', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true, manualResearchWebSearchEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'StepManiaX', manufacturerHint: 'Step Revolution' }],
      traceId: 'test-stepmaniax-exact-manual-promote',
      storage: createStorageMock(),
      fetchImpl: createFetchMock(),
      researchFallback: async () => ({
        normalizedTitle: 'StepManiaX',
        manufacturer: 'Step Revolution',
        matchType: 'exact_manual',
        manualReady: false,
        reviewRequired: true,
        manualUrl: 'https://stepmaniax.com/wp-content/uploads/stepmaniax-operator-manual.pdf',
        manualSourceUrl: 'https://stepmaniax.com/support/',
        supportUrl: 'https://stepmaniax.com/support/',
        confidence: 1,
        candidates: [{
          bucket: 'verified_pdf_candidate',
          lookupMethod: 'workbook_seed_exact_pdf',
          exactManualMatch: true,
          url: 'https://stepmaniax.com/wp-content/uploads/stepmaniax-operator-manual.pdf',
          title: 'StepManiaX Operator Manual',
        }],
        selectedCandidate: {
          bucket: 'verified_pdf_candidate',
          lookupMethod: 'workbook_seed_exact_pdf',
          exactManualMatch: true,
          url: 'https://stepmaniax.com/wp-content/uploads/stepmaniax-operator-manual.pdf',
          title: 'StepManiaX Operator Manual',
        },
        citations: [],
        rawResearchSummary: 'Official exact manual URL provided by manufacturer support.',
      }),
    });

    assert.equal(result.results[0].matchType, 'exact_manual');
    assert.equal(result.results[0].status, 'docs_found');
    assert.equal(result.results[0].manualReady, true);
    assert.ok(`${result.results[0].manualLibraryRef || ''}`.trim());
    assert.match(result.results[0].manualStoragePath || '', /^manual-library\//i);
    assert.match(result.results[0].manualUrl || '', /^manual-library\//i);
    assert.equal(result.results[0].pipelineMeta.acquisitionAttempted, true);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:deterministic_candidate_detected' && entry[1]?.deterministicCandidateType === 'workbook_seed_exact_pdf'), true);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:deterministic_candidate_short_circuit_applied'), true);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:provider_fallback_skipped_due_to_deterministic_candidate'), true);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:provider_fallback_used_due_to_no_deterministic_candidate'), false);
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles promotes deterministic direct PDF candidates into acquisition ahead of provider fallback terminalization', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true, manualResearchWebSearchEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'Jurassic Park Arcade', manufacturerHint: 'Raw Thrills' }],
      traceId: 'test-deterministic-direct-pdf-promotion',
      storage: createStorageMock(),
      fetchImpl: async (url, options = {}) => {
        const value = String(url);
        if (value.includes('duckduckgo.com') || value.includes('bing.com/search')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'text/html' },
            text: async () => '<html></html>',
          };
        }
        if (value.toLowerCase().endsWith('.pdf')) {
          return {
            ok: true,
            status: 200,
            url,
            headers: { get: () => 'application/pdf' },
            text: async () => '',
            arrayBuffer: async () => Buffer.from('%PDF-1.4\njurassic'),
          };
        }
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => 'text/html' },
          text: async () => options.method === 'HEAD'
            ? ''
            : '<html><body>Jurassic Park Arcade support page</body></html>',
        };
      },
      researchFallback: async () => {
        const error = new Error('Responses API unavailable');
        error.code = 'openai-temporary';
        throw error;
      },
    });

    assert.equal(result.results[0].status, 'docs_found');
    assert.equal(result.results[0].manualReady, true);
    assert.ok(`${result.results[0].manualLibraryRef || ''}`.trim());
    assert.match(result.results[0].manualStoragePath || '', /^manual-library\//i);
    assert.equal(result.results[0].pipelineMeta.acquisitionAttempted, true);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:deterministic_candidate_detected'), true);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:provider_fallback_skipped_due_to_deterministic_candidate'), true);
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles promotes Willy Crash exact-manual source pages into durable attachment when download links are extractable', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true, manualResearchWebSearchEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'Willy Crash', manufacturerHint: 'Raw Thrills' }],
      traceId: 'test-willy-crash-exact-manual-source-page',
      storage: createStorageMock(),
      fetchImpl: async (url, options = {}) => {
        if (String(url).includes('willy-crash-operator-manual.pdf')) {
          return {
            ok: true,
            status: 200,
            url,
            headers: { get: () => 'application/pdf' },
            text: async () => '',
            arrayBuffer: async () => Buffer.from('%PDF-1.4\nwilly-crash'),
          };
        }
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => 'text/html' },
          text: async () => options.method === 'HEAD'
            ? ''
            : '<html><body><a href="https://rawthrills.com/wp-content/uploads/willy-crash-operator-manual.pdf">Willy Crash Operator Manual PDF</a></body></html>',
          arrayBuffer: async () => Buffer.from('<html></html>'),
        };
      },
      researchFallback: async () => ({
        normalizedTitle: 'Willy Crash',
        manufacturer: 'Raw Thrills',
        matchType: 'exact_manual',
        manualReady: true,
        reviewRequired: false,
        manualUrl: 'https://rawthrills.com/games/willy-crash-support/',
        manualSourceUrl: 'https://rawthrills.com/games/willy-crash-support/',
        supportUrl: 'https://rawthrills.com/games/willy-crash-support/',
        confidence: 1,
        candidates: [{
          bucket: 'verified_pdf_candidate',
          url: 'https://rawthrills.com/wp-content/uploads/willy-crash-operator-manual.pdf',
          title: 'Willy Crash Operator Manual',
          confidence: 0.98,
          exactManualMatch: true,
          verified: true,
        }],
        citations: [],
        rawResearchSummary: 'Official support page contains manual download link.',
      }),
    });

    assert.equal(result.results[0].status, 'docs_found');
    assert.equal(result.results[0].manualReady, true);
    assert.ok(`${result.results[0].manualLibraryRef || ''}`.trim());
    assert.match(result.results[0].manualStoragePath || '', /^manual-library\//i);
    const markers = logs.map((entry) => entry[0]);
    assert.equal(markers.includes('manualResearch:durable_acquisition_attempted'), true);
    assert.equal(markers.includes('manualResearch:durable_storage_completed'), true);
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles logs explicit durable acquisition failure reasons for Down the Clown manual-page-with-download paths', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true, manualResearchWebSearchEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'Down the Clown', manufacturerHint: 'LAI Games' }],
      traceId: 'test-down-the-clown-manual-page-diagnostics',
      storage: createStorageMock(),
      fetchImpl: async (url, options = {}) => {
        if (String(url).includes('down-the-clown-install-guide.pdf')) {
          return {
            ok: false,
            status: 404,
            url,
            headers: { get: () => 'application/pdf' },
            text: async () => '',
            arrayBuffer: async () => Buffer.from(''),
          };
        }
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => 'text/html' },
          text: async () => options.method === 'HEAD'
            ? ''
            : '<html><body><a href="https://laigames.com/downloads/down-the-clown-install-guide.pdf">Down the Clown Install Guide PDF</a></body></html>',
          arrayBuffer: async () => Buffer.from('<html></html>'),
        };
      },
      researchFallback: async () => ({
        normalizedTitle: 'Down the Clown',
        manufacturer: 'LAI Games',
        matchType: 'manual_page_with_download',
        manualReady: false,
        reviewRequired: false,
        manualUrl: 'https://laigames.com/game/down-the-clown/',
        manualSourceUrl: 'https://laigames.com/game/down-the-clown/',
        supportUrl: 'https://laigames.com/game/down-the-clown/',
        confidence: 0.96,
        candidates: [{
          bucket: 'verified_pdf_candidate',
          url: 'https://laigames.com/downloads/down-the-clown-install-guide.pdf',
          title: 'Down the Clown Install Guide PDF',
          confidence: 0.92,
          verified: true,
          exactManualMatch: true,
        }],
        citations: [],
        rawResearchSummary: 'Title-specific page contains install guide download link.',
      }),
    });

    assert.equal(result.results[0].manualReady, false);
    assert.equal(result.results[0].status, 'followup_needed');
    assert.equal(result.results[0].manualLibraryRef, '');
    const markers = logs.map((entry) => entry[0]);
    assert.equal(markers.includes('manualResearch:durable_acquisition_attempted'), true);
    assert.equal(markers.includes('manualResearch:durable_acquisition_failed_reason'), true);
    assert.equal(markers.includes('manualResearch:exact_manual_terminalized_without_attachment'), true);
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles persists/consumes answered follow-up fingerprints and avoids identical follow-up loop', async () => {
  const followupAnswer = 'It says Deluxe on the marquee';
  const followupFingerprint = createHash('sha1').update(followupAnswer.toLowerCase()).digest('hex');
  const firstRun = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{
      originalTitle: 'Unknown Racer DX',
      manufacturerHint: 'Unknown',
    }],
    traceId: 'test-followup-consume',
    fetchImpl: createFetchMock(),
    storage: createStorageMock(),
    researchFallback: async () => ({
      normalizedTitle: 'Unknown Racer DX',
      manufacturer: 'Unknown',
      matchType: 'support_only',
      manualReady: false,
      reviewRequired: true,
      manualUrl: '',
      manualSourceUrl: '',
      supportUrl: 'https://example.com/support/unknown-racer-dx',
      confidence: 0.3,
      candidates: [],
      citations: [],
      rawResearchSummary: 'no manual',
    }),
  });
  const rerun = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{
      originalTitle: 'Unknown Racer DX',
      manufacturerHint: 'Unknown',
      followupQuestionKey: firstRun.results[0].pipelineMeta.followupQuestionKey || 'same-question-key',
      followupAnswer,
      followupAnswerFingerprint: followupFingerprint,
      consumedFollowupAnswerFingerprint: followupFingerprint,
      previousQueryPlanFingerprint: firstRun.results[0].pipelineMeta.queryPlanFingerprint,
      previousCandidateFingerprint: firstRun.results[0].pipelineMeta.candidateFingerprint,
    }],
    traceId: 'test-followup-consume-rerun',
    fetchImpl: createFetchMock(),
    storage: createStorageMock(),
    researchFallback: async () => ({
      normalizedTitle: 'Unknown Racer DX',
      manufacturer: 'Unknown',
      matchType: 'support_only',
      manualReady: false,
      reviewRequired: true,
      manualUrl: '',
      manualSourceUrl: '',
      supportUrl: 'https://example.com/support/unknown-racer-dx',
      confidence: 0.3,
      candidates: [],
      citations: [],
      rawResearchSummary: 'no manual',
    }),
  });
  assert.equal(rerun.results[0].status, 'support_only');
  assert.equal(rerun.results[0].pipelineMeta.followupAnswerConsumed, true);
  assert.equal(typeof rerun.results[0].pipelineMeta.followupAnswerFingerprint, 'string');
});

test('researchAssetTitles treats manufacturer-only follow-up replies as non-new evidence when manufacturer is already known', async () => {
  const followupAnswer = 'LAI Games';
  const followupFingerprint = createHash('sha1').update(followupAnswer.toLowerCase()).digest('hex');
  const unresolvedFetch = async (url, options = {}) => {
    if (String(url).toLowerCase().endsWith('.pdf')) {
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => options.method === 'HEAD' ? '' : 'Support page only. No downloadable manual available.',
    };
  };
  const firstRun = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{
      originalTitle: 'Virtual Rabbids',
      manufacturerHint: 'LAI Games',
    }],
    traceId: 'test-followup-manufacturer-only-first',
    fetchImpl: unresolvedFetch,
    storage: createStorageMock(),
    researchFallback: async () => ({
      normalizedTitle: 'Virtual Rabbids: The Big Ride',
      manufacturer: 'LAI Games',
      matchType: 'support_only',
      manualReady: false,
      reviewRequired: true,
      manualUrl: '',
      manualSourceUrl: '',
      supportUrl: 'https://laigames.com/virtual-rabbids-the-big-ride/',
      confidence: 0.41,
      candidates: [],
      citations: [],
      rawResearchSummary: 'No downloadable manual found.',
    }),
  });
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{
      originalTitle: 'Virtual Rabbids',
      manufacturerHint: 'LAI Games',
      followupQuestionKey: firstRun.results[0].pipelineMeta.followupQuestionKey || 'same-followup-question',
      followupAnswer,
      followupAnswerFingerprint: followupFingerprint,
      consumedFollowupAnswerFingerprint: followupFingerprint,
      previousQueryPlanFingerprint: firstRun.results[0].pipelineMeta.queryPlanFingerprint,
      previousCandidateFingerprint: firstRun.results[0].pipelineMeta.candidateFingerprint,
    }],
    traceId: 'test-followup-manufacturer-only',
    fetchImpl: unresolvedFetch,
    storage: createStorageMock(),
    researchFallback: async () => ({
      normalizedTitle: 'Virtual Rabbids: The Big Ride',
      manufacturer: 'LAI Games',
      matchType: 'support_only',
      manualReady: false,
      reviewRequired: true,
      manualUrl: '',
      manualSourceUrl: '',
      supportUrl: 'https://laigames.com/virtual-rabbids-the-big-ride/',
      confidence: 0.41,
      candidates: [],
      citations: [],
      rawResearchSummary: 'No downloadable manual found.',
    }),
  });

  assert.equal(result.results[0].pipelineMeta.followupAnswerConsumed, true);
  assert.equal(result.results[0].pipelineMeta.queryPlanChanged, false);
  assert.equal(result.results[0].pipelineMeta.candidateDelta, false);
  assert.equal(result.results[0].status, 'followup_needed');
  assert.match(result.results[0].pipelineMeta.followupQuestion, /exact model|title|version|nameplate/i);
  assert.notEqual(result.results[0].pipelineMeta.followupQuestionKey, firstRun.results[0].pipelineMeta.followupQuestionKey);
});

test('Virtual Rabbids dead selected candidate is excluded from candidate delta and refines follow-up instead of looping', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  const deadInstallGuideUrl = 'https://laigames.com/downloads/virtual-rabbids-the-big-ride-install-guide.pdf';
  try {
    const unresolvedFetch = async (url, options = {}) => {
      if (String(url).toLowerCase().endsWith('.pdf')) {
        return {
          ok: false,
          status: 404,
          url,
          headers: { get: () => 'application/pdf' },
          arrayBuffer: async () => Buffer.from(''),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'text/html' },
        text: async () => options.method === 'HEAD' ? '' : 'Support page only. No downloadable manual available.',
      };
    };
    const firstRun = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'Virtual Rabbids', manufacturerHint: 'LAI Games' }],
      traceId: 'test-rabbids-dead-candidate-first',
      fetchImpl: unresolvedFetch,
      storage: createStorageMock(),
      researchFallback: async () => ({
        normalizedTitle: 'Virtual Rabbids: The Big Ride',
        manufacturer: 'LAI Games',
        matchType: 'support_only',
        manualReady: false,
        reviewRequired: true,
        manualUrl: deadInstallGuideUrl,
        manualSourceUrl: 'https://laigames.com/virtual-rabbids-the-big-ride/',
        supportUrl: 'https://laigames.com/virtual-rabbids-the-big-ride/',
        confidence: 0.41,
        selectedCandidate: { bucket: 'likely_install_or_service_doc', url: deadInstallGuideUrl, title: 'Virtual Rabbids Install Guide' },
        candidates: [{ bucket: 'likely_install_or_service_doc', url: deadInstallGuideUrl, title: 'Virtual Rabbids Install Guide', confidence: 0.62 }],
        citations: [],
        rawResearchSummary: 'Install guide URL surfaced but is dead.',
      }),
    });
    const followupAnswer = 'LAI Games';
    const followupFingerprint = createHash('sha1').update(followupAnswer.toLowerCase()).digest('hex');
    const secondRun = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true },
      companyId: 'company-1',
      titles: [{
        originalTitle: 'Virtual Rabbids',
        manufacturerHint: 'LAI Games',
        followupQuestionKey: firstRun.results[0].pipelineMeta.followupQuestionKey || 'same-followup-question',
        followupAnswer,
        followupAnswerFingerprint: followupFingerprint,
        consumedFollowupAnswerFingerprint: followupFingerprint,
        previousQueryPlanFingerprint: firstRun.results[0].pipelineMeta.queryPlanFingerprint,
        previousCandidateFingerprint: firstRun.results[0].pipelineMeta.candidateFingerprint,
        deadCandidateUrls: firstRun.results[0].pipelineMeta.deadCandidateUrls || [],
      }],
      traceId: 'test-rabbids-dead-candidate-followup',
      fetchImpl: unresolvedFetch,
      storage: createStorageMock(),
      researchFallback: async () => ({
        normalizedTitle: 'Virtual Rabbids: The Big Ride',
        manufacturer: 'LAI Games',
        matchType: 'support_only',
        manualReady: false,
        reviewRequired: true,
        manualUrl: deadInstallGuideUrl,
        manualSourceUrl: 'https://laigames.com/virtual-rabbids-the-big-ride/',
        supportUrl: 'https://laigames.com/virtual-rabbids-the-big-ride/',
        confidence: 0.41,
        selectedCandidate: { bucket: 'likely_install_or_service_doc', url: deadInstallGuideUrl, title: 'Virtual Rabbids Install Guide' },
        candidates: [{ bucket: 'likely_install_or_service_doc', url: deadInstallGuideUrl, title: 'Virtual Rabbids Install Guide', confidence: 0.62 }],
        citations: [],
        rawResearchSummary: 'Install guide URL surfaced but is dead.',
      }),
    });

    assert.equal(firstRun.results[0].pipelineMeta.deadCandidateUrls.includes(deadInstallGuideUrl), true);
    assert.equal(secondRun.results[0].pipelineMeta.followupAnswerConsumed, true);
    assert.equal(secondRun.results[0].pipelineMeta.queryPlanChanged, false);
    assert.equal(secondRun.results[0].pipelineMeta.candidateDelta, false);
    assert.equal(secondRun.results[0].status, 'followup_needed');
    assert.match(secondRun.results[0].pipelineMeta.followupQuestion, /exact model|title|version|nameplate/i);
    assert.equal(secondRun.results[0].documentationSuggestions.some((entry) => entry.url === deadInstallGuideUrl), false);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:followup_answer_manufacturer_only_no_new_evidence'), true);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:followup_question_refined'), true);
    assert.equal(
      logs.some((entry) => entry[0] === 'manualResearch:selected_candidate_rejected_unvalidated')
      || logs.some((entry) => entry[0] === 'manualResearch:candidate_validation_tier'),
      true
    );
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:followup_delta_dead_candidates_ignored'), true);
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles prefers discovered validated candidate over persisted dead guessed vendor url', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args); };
  try {
    const deadGuessedUrl = 'https://laigames.com/downloads/virtual-rabbids-the-big-ride-install-guide.pdf';
    const discoveredUrl = 'https://manuals.example.com/lai-games/virtual-rabbids-operator-manual.pdf';
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true },
      companyId: 'company-1',
      titles: [{
        originalTitle: 'Virtual Rabbids',
        manufacturerHint: 'LAI Games',
        deadCandidateUrls: [deadGuessedUrl],
      }],
      traceId: 'test-dead-guessed-demotion',
      storage: createStorageMock(),
      fetchImpl: async (url, options = {}) => {
        const method = options?.method || 'GET';
        if (url === deadGuessedUrl) {
          return { ok: false, status: 404, url, headers: { get: () => 'application/pdf' }, text: async () => '' };
        }
        if (url === discoveredUrl) {
          if (method === 'HEAD') return { ok: true, status: 200, url, headers: { get: () => 'application/pdf' } };
          return {
            ok: true,
            status: 200,
            url,
            headers: { get: () => 'application/pdf' },
            text: async () => '',
            arrayBuffer: async () => Buffer.from('%PDF-1.4\nmanual'),
          };
        }
        return { ok: true, status: 200, url, headers: { get: () => 'text/html' }, text: async () => '' };
      },
      researchFallback: async () => ({
        normalizedTitle: 'Virtual Rabbids: The Big Ride',
        manufacturer: 'LAI Games',
        manufacturerInferred: false,
        matchType: 'support_only',
        manualReady: false,
        reviewRequired: true,
        manualUrl: deadGuessedUrl,
        manualSourceUrl: 'https://laigames.com/virtual-rabbids-the-big-ride/',
        supportUrl: 'https://laigames.com/virtual-rabbids-the-big-ride/',
        confidence: 0.72,
        selectedCandidate: { bucket: 'verified_pdf_candidate', url: deadGuessedUrl, title: 'Virtual Rabbids Install Guide' },
        candidates: [
          { bucket: 'verified_pdf_candidate', url: deadGuessedUrl, title: 'Virtual Rabbids Install Guide', confidence: 0.95 },
          { bucket: 'verified_pdf_candidate', url: discoveredUrl, title: 'Virtual Rabbids Operator Manual', confidence: 0.87 },
        ],
        citations: [],
        rawResearchSummary: 'Discovered stronger third-party manual candidate.',
      }),
    });

    assert.equal(result.results[0].manualReady, true);
    assert.equal(result.results[0].documentationSuggestions[0]?.url, result.results[0].manualUrl);
    assert.equal(result.results[0].documentationSuggestions.some((entry) => entry.url === deadGuessedUrl), false);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:stale_candidate_pre_demoted'), true);
    assert.equal(
      logs.some((entry) => entry[0] === 'manualResearch:dead_candidate_skipped_before_selection')
      || logs.some((entry) => entry[0] === 'manualResearch:stale_candidate_pre_demoted'),
      true
    );
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:alternate_candidate_selected_due_to_dead_cache'), true);
    assert.equal(
      logs.some((entry) => entry[0] === 'manualResearch:candidate_replaced_due_to_better_exact_match')
      || logs.some((entry) => entry[0] === 'manualResearch:weak_candidate_demoted'),
      true,
    );
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles keeps exact-title 404 candidates unvalidated and prefers alternate Betson PDF on dead-cache rerun', async () => {
  const deadLaiUrl = 'https://laigames.com/wp-content/uploads/virtual-rabbids-install-guide.pdf';
  const betsonUrl = 'https://www.betson.com/wp-content/uploads/2020/01/VirtualRabbidsTheBigRideManual16.pdf';
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true },
      companyId: 'company-1',
      titles: [{
        originalTitle: 'Virtual Rabbids',
        manufacturerHint: 'LAI Games',
        deadCandidateUrls: [deadLaiUrl],
      }],
      traceId: 'test-rabbids-dead-cache-betson',
      storage: createStorageMock(),
      fetchImpl: async (url, options = {}) => {
        if (url === deadLaiUrl) return { ok: false, status: 404, url, headers: { get: () => 'application/pdf' }, text: async () => '' };
        if ((options.method || 'GET').toUpperCase() === 'HEAD') return { ok: true, status: 200, url, headers: { get: () => 'application/pdf' } };
        return { ok: true, status: 200, url, headers: { get: () => 'application/pdf' }, text: async () => '', arrayBuffer: async () => Buffer.from('%PDF-1.4\nmanual') };
      },
      researchFallback: async () => ({
        normalizedTitle: 'Virtual Rabbids: The Big Ride',
        manufacturer: 'LAI Games',
        matchType: 'support_only',
        manualReady: false,
        reviewRequired: true,
        manualUrl: '',
        manualSourceUrl: 'https://laigames.com/games/virtual-rabbids-the-big-ride/',
        supportUrl: 'https://laigames.com/games/virtual-rabbids-the-big-ride/',
        confidence: 0.7,
        candidates: [
          { bucket: 'verified_pdf_candidate', url: deadLaiUrl, title: 'Virtual Rabbids Install Guide' },
          { bucket: 'verified_pdf_candidate', url: betsonUrl, title: 'Virtual Rabbids Operator Manual', verified: true, exactManualMatch: true },
        ],
      }),
    });
    assert.equal(result.results[0].manualReady, true);
    assert.equal(result.results[0].documentationSuggestions.some((entry) => entry.url === deadLaiUrl), false);
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:candidate_rank_assigned' && entry[1]?.candidateUrl === deadLaiUrl && entry[1]?.candidateRankTier === 'B_exact_title_unvalidated_candidate'), true);
    assert.equal(
      logs.some((entry) => entry[0] === 'manualResearch:dead_candidate_skipped_before_selection' && entry[1]?.candidateUrl === deadLaiUrl)
      || logs.some((entry) => entry[0] === 'manualResearch:stale_candidate_pre_demoted' && entry[1]?.candidateUrl === deadLaiUrl),
      true
    );
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:alternate_candidate_selected_due_to_dead_cache'), true);
  } finally {
    console.log = originalLog;
  }
});

test.skip('researchAssetTitles logs extracted title-page promotion and demotes guessed/generic candidates', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args); };
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'Jurassic Park Arcade', manufacturerHint: 'Raw Thrills' }],
      traceId: 'test-title-page-promotion',
      storage: createStorageMock(),
      fetchImpl: async (url, options = {}) => {
        if ((options?.method || 'GET').toUpperCase() === 'HEAD' && /jurassic-park-arcade-operator-manual\.pdf$/i.test(url)) {
          return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
        }
        return { ok: true, status: 200, url, headers: { get: () => 'text/html' }, text: async () => '' };
      },
      researchFallback: async () => ({
        normalizedTitle: 'Jurassic Park Arcade',
        manufacturer: 'Raw Thrills',
        matchType: 'support_only',
        manualReady: false,
        reviewRequired: true,
        manualUrl: 'https://rawthrills.com/wp-content/uploads/jurassic-park-manual.pdf',
        manualSourceUrl: 'https://rawthrills.com/games/jurassic-park-arcade/',
        supportUrl: 'https://rawthrills.com/support/',
        confidence: 0.68,
        selectedCandidate: { bucket: 'weak_lead', url: 'https://rawthrills.com/support/', title: 'Raw Thrills Support' },
        candidates: [
          { bucket: 'weak_lead', url: 'https://rawthrills.com/support/', title: 'Raw Thrills Support' },
          { bucket: 'verified_pdf_candidate', url: 'https://rawthrills.com/wp-content/uploads/jurassic-park-manual.pdf', title: 'Jurassic Park Manual', discoverySource: 'adapter:raw_thrills' },
          { bucket: 'verified_pdf_candidate', url: 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf', title: 'Jurassic Park Arcade Operator Manual', discoverySource: 'html_followup', exactManualMatch: true, verified: true },
        ],
        citations: [],
        rawResearchSummary: 'title page includes a manual anchor',
      }),
    });
    assert.equal(result.results[0].manualReady, true);
    assert.match(result.results[0].manualUrl, /jurassic-park-arcade-operator-manual\.pdf$/i);
    assert.equal(
      logs.some((entry) => entry[0] === 'manualResearch:final_candidate_selected_from_extracted_title_page')
      || logs.some((entry) => entry[0] === 'manualResearch:final_candidate_selected_from_discovery'),
      true
    );
    assert.equal(
      logs.some((entry) => entry[0] === 'manualResearch:guessed_candidate_demoted')
      || logs.some((entry) => entry[0] === 'manualResearch:candidate_replaced_due_to_better_exact_match'),
      true
    );
    assert.equal(
      logs.some((entry) => entry[0] === 'manualResearch:generic_candidate_demoted')
      || logs.some((entry) => entry[0] === 'manualResearch:weak_candidate_demoted'),
      true
    );
    assert.equal(logs.some((entry) => entry[0] === 'manualResearch:best_exact_title_candidate_found'), true);
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles global-first reuses approved shared manual across alias title variants', async () => {
  const manualLibrary = {
    'shared-manual-1': {
      canonicalTitle: 'King Kong of Skull Island VR',
      canonicalTitleNormalized: 'king kong of skull island vr',
      familyTitle: 'King Kong VR',
      familyTitleNormalized: 'king kong vr',
      normalizedManufacturer: 'raw thrills',
      manufacturer: 'Raw Thrills',
      aliasKeys: ['king kong vr', 'king kong'],
      alternateTitleKeys: ['king kong vr', 'king kong'],
      approved: true,
      approvalState: 'approved',
      storagePath: 'manual-library/raw-thrills/king-kong-of-skull-island-vr/reused.pdf',
      sourcePageUrl: 'https://rawthrills.com/support/king-kong'
    }
  };
  const result = await researchAssetTitles({
    db: createDb({ manualLibrary }),
    settings: { aiEnabled: true },
    companyId: 'company-b',
    titles: [{ originalTitle: 'King Kong VR', manufacturerHint: 'Raw Thrills' }],
    traceId: 'test-shared-reuse',
    fetchImpl: createFetchMock(),
    storage: createStorageMock(),
    researchFallback: async () => ({
      normalizedTitle: 'King Kong VR',
      manufacturer: 'Raw Thrills',
      matchType: 'support_only',
      manualReady: false,
      manualUrl: '',
      supportUrl: '',
      candidates: [],
      citations: [],
      rawResearchSummary: 'fallback should not be needed for durable manual attach',
    }),
  });
  assert.equal(result.results[0].manualLibraryRef, 'shared-manual-1');
  assert.equal(result.results[0].manualStoragePath, 'manual-library/raw-thrills/king-kong-of-skull-island-vr/reused.pdf');
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
  assert.ok(['failed', 'skipped'].includes(result.results[0].pipelineMeta.acquisitionState));
  if (result.results[0].pipelineMeta.acquisitionState === 'failed') {
    assert.match(result.results[0].pipelineMeta.acquisitionError, /storage upload blew up/);
  }
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
  assert.ok(['no_manual', 'skipped'].includes(result.results[0].pipelineMeta.acquisitionState));
});

test('Connect 4 brochure/spec PDFs remain support_product_page candidates and never claim durable manual attachment', async () => {
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Connect 4 Hoops', manufacturerHint: 'Bay Tek Games' }],
    traceId: 'test-connect-4-brochure-spec',
    storage: createStorageMock(),
    fetchImpl: async (url, options = {}) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => options.method === 'HEAD' ? 'application/pdf' : 'text/html' },
      text: async () => '<html><body>Product brochure and specs only.</body></html>',
      arrayBuffer: async () => Buffer.from('<html><body>Not a manual</body></html>'),
    }),
    researchFallback: async () => ({
      normalizedTitle: 'Connect 4 Hoops',
      manufacturer: 'Bay Tek Games',
      matchType: 'title_specific_source',
      manualReady: false,
      reviewRequired: true,
      manualUrl: 'https://www.betson.com/wp-content/uploads/connect-4-hoops-brochure.pdf',
      manualSourceUrl: 'https://www.betson.com/amusement-products/connect-4-hoops/',
      supportUrl: 'https://www.betson.com/amusement-products/connect-4-hoops/',
      confidence: 0.58,
      matchNotes: 'Brochure/spec links found; no install/service manual.',
      candidates: [{
        bucket: 'brochure_or_spec_doc',
        url: 'https://www.betson.com/wp-content/uploads/connect-4-hoops-brochure.pdf',
        title: 'Connect 4 Hoops Brochure',
        sourceDomain: 'betson.com',
        whyMatch: 'Product brochure; no service/operator language.',
        confidence: 0.72,
      }],
      citations: [],
      rawResearchSummary: 'Connect 4 brochure and spec docs.',
    }),
  });

  assert.equal(result.results[0].manualReady, false);
  assert.equal(result.results[0].status, 'followup_needed');
  assert.equal(result.results[0].manualLibraryRef, '');
  assert.equal(result.results[0].manualStoragePath, '');
  assert.equal(result.results[0].pipelineMeta.acquisitionState, 'skipped');
  assert.equal(result.results[0].pipelineMeta.terminalStateReason, 'docs_discovered_candidate_only');
  assert.equal(result.results[0].pipelineMeta.returnedCandidates[0]?.bucket, 'brochure_or_spec_doc');
  assert.equal(result.results[0].documentationSuggestions[0].candidateBucket, 'support_product_page');
});

test('Betson sell sheet links stay support/review only and never become manual candidates', async () => {
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Willy Crash', manufacturerHint: 'Raw Thrills' }],
    traceId: 'test-willy-crash-betson-sell-sheet',
    storage: createStorageMock(),
    fetchImpl: async (url, options = {}) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => options.method === 'HEAD' ? 'application/pdf' : 'text/html' },
      text: async () => '<html><body>Sell sheet marketing collateral.</body></html>',
      arrayBuffer: async () => Buffer.from('<html><body>Sell sheet only</body></html>'),
    }),
    researchFallback: async () => ({
      normalizedTitle: 'Willy Crash',
      manufacturer: 'Raw Thrills',
      matchType: 'support_only',
      manualReady: false,
      reviewRequired: true,
      manualUrl: 'https://www.betson.com/wp-content/uploads/2024/06/willy-crash-sell-sheet.pdf',
      manualSourceUrl: 'https://www.betson.com/amusement-products/willy-crash/',
      supportUrl: 'https://www.betson.com/amusement-products/willy-crash/',
      confidence: 0.53,
      matchNotes: 'Sell sheet discovered; no manual.',
      candidates: [{
        bucket: 'brochure_or_spec_doc',
        url: 'https://www.betson.com/wp-content/uploads/2024/06/willy-crash-sell-sheet.pdf',
        title: 'Willy Crash Sell Sheet',
        sourceDomain: 'betson.com',
        whyMatch: 'Marketing collateral only',
        confidence: 0.71,
      }],
      citations: [],
      rawResearchSummary: 'Only Betson sell sheet and product page were discovered.',
    }),
  });

  assert.equal(result.results[0].manualReady, false);
  assert.equal(result.results[0].status, 'followup_needed');
  assert.equal(result.results[0].manualUrl, '');
  assert.equal(result.results[0].manualLibraryRef, '');
  assert.equal(result.results[0].pipelineMeta.acquisitionState, 'skipped');
  assert.equal(result.results[0].documentationSuggestions[0]?.candidateBucket, 'support_product_page');
});

test('OpenAI auth/config failures are logged and fall back to scraping without throwing', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    const result = await researchAssetTitles({
      db: createDb(),
      settings: { aiEnabled: true },
      companyId: 'company-1',
      titles: [{ originalTitle: 'Willy Crash', manufacturerHint: 'Raw Thrills' }],
      traceId: 'test-openai-auth-config-fail',
      fetchImpl: createFetchMock(),
      storage: createStorageMock(),
      researchFallback: async () => {
        const error = new Error('OpenAI authentication failed for manual research. Verify OPENAI_API_KEY secret binding.');
        error.code = 'openai-auth-invalid';
        throw error;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    const failureLog = logs.find((entry) => entry[0] === 'manualResearch:stage2_validation_failed');
    assert.ok(failureLog);
    assert.equal(failureLog[1]?.reasonCode, 'openai-auth-invalid');
    const authFallbackLog = logs.find((entry) => entry[0] === 'manualResearch:stage2_auth_invalid_fallback');
    assert.ok(authFallbackLog);
    assert.equal(
      [
        'no_durable_manual:skipped',
        'title_page_found_manual_probe_failed',
        'deterministic-search-no-results',
        'guessed-pdf-404-no-better-candidate',
        'manufacturer-adapter-no-better-candidate'
      ].includes(result.results[0].pipelineMeta.terminalStateReason),
      true
    );
  } finally {
    console.log = originalLog;
  }
});

test('researchAssetTitles reports site_timeout terminal reason when fallback search providers time out', async () => {
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'King Kong VR', manufacturerHint: 'Raw Thrills' }],
    traceId: 'test-fallback-site-timeout',
    storage: createStorageMock(),
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.code = 'aborted';
      throw error;
    },
    researchFallback: async () => {
      const error = new Error('Responses API unavailable');
      error.code = 'openai-temporary';
      throw error;
    },
  });

  assert.equal(result.results[0].pipelineMeta.terminalStateReason, 'site_timeout');
});

test('researchAssetTitles reports deterministic-search-no-results terminal reason when fallback search returns nothing', async () => {
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'King Kong VR', manufacturerHint: 'Raw Thrills' }],
    traceId: 'test-fallback-no-results',
    storage: createStorageMock(),
    fetchImpl: async (url) => {
      if (String(url).includes('/search?') || String(url).includes('duckduckgo.com') || String(url).includes('bing.com/search')) {
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
      }
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    },
    researchFallback: async () => {
      const error = new Error('Responses API unavailable');
      error.code = 'openai-temporary';
      throw error;
    },
  });

  assert.equal(result.results[0].pipelineMeta.terminalStateReason, 'deterministic-search-no-results');
});

test('researchAssetTitles reports title_page_found_manual_probe_failed when fallback finds exact-title support page but no manual extraction', async () => {
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Jurassic Park Arcade', manufacturerHint: 'Raw Thrills' }],
    traceId: 'test-fallback-title-page-probe-failed',
    storage: createStorageMock(),
    fetchImpl: async (url) => {
      if (String(url).includes('duckduckgo.com') || String(url).includes('bing.com/search')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'text/html' },
          text: async () => '<a class="result__a" href="https://rawthrills.com/games/jurassic-park-arcade-support/">Jurassic Park Arcade Support</a>',
        };
      }
      if (String(url).includes('rawthrills.com/games/jurassic-park-arcade-support')) {
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<a href="/support">Support</a>' };
      }
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    },
    researchFallback: async () => {
      const error = new Error('Responses API unavailable');
      error.code = 'openai-temporary';
      throw error;
    },
  });

  assert.ok(['title_page_found_manual_probe_failed', 'candidate_validated_but_not_stored'].includes(result.results[0].pipelineMeta.terminalStateReason));
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
      return {
        normalizedTitle: 'Quik Drop',
        manufacturer: 'Bay Tek Games',
        manufacturerInferred: false,
        matchType: 'support_only',
        manualReady: false,
        reviewRequired: true,
        manualUrl: '',
        manualSourceUrl: 'https://www.betson.com/amusement-products/quik-drop/',
        supportUrl: 'https://www.betson.com/amusement-products/quik-drop/',
        supportEmail: '',
        supportPhone: '',
        confidence: 0.39,
        matchNotes: 'No manual candidate from OpenAI.',
        candidates: [],
        citations: [],
        rawResearchSummary: 'OpenAI returned no viable candidates.',
      };
    },
  });

  assert.equal(stageTwoCalls, 1);
  assert.equal(result.results[0].manualReady, true);
  assert.match(result.results[0].manualUrl, /^manual-library\/bay-tek(?:-games)?\/quik-drop\/.+\.pdf$/i);
  assert.ok(result.results[0].manualLibraryRef);
});


test('trusted catalog rows are reference-only by default and do not short-circuit stage2 for difficult titles', async () => {
  let stageTwoCalls = 0;
  const trustedManualCatalog = {
    'jurassic-park-arcade-01': trustedRow({
      assetId: 'jurassic-park-arcade-01',
      assetName: 'Jurassic Park Arcade (2-Player)',
      manufacturer: 'Raw Thrills',
      normalizedTitle: 'Jurassic Park Arcade',
      normalizedName: 'Jurassic Park Arcade',
      alternateNames: 'Jurassic Park',
      manualUrl: 'https://rawthrills.com/wp-content/uploads/2020/01/JP-Manual-r09.pdf',
      manualSourceUrl: 'https://rawthrills.com/games/jurassic-park-arcade/',
      manualReady: true,
      reviewRequired: false,
      matchConfidence: 0.98,
    }),
    'king-kong-of-skull-island-vr-01': trustedRow({
      assetId: 'king-kong-of-skull-island-vr-01',
      assetName: 'King Kong of Skull Island VR (2-Player)',
      manufacturer: 'Raw Thrills',
      normalizedTitle: 'King Kong of Skull Island VR',
      normalizedName: 'King Kong of Skull Island VR',
      alternateNames: 'King Kong VR',
      manualUrl: 'https://rawthrills.com/wp-content/uploads/2021/03/040-00078-01_King_Kong_of_Skull_Island_Manual_REV6.pdf',
      manualReady: true,
      reviewRequired: false,
      matchConfidence: 0.97,
    }),
    hypershoot: trustedRow({
      assetId: 'hypershoot-01',
      assetName: 'HYPERshoot (2-Player)',
      manufacturer: 'LAI Games',
      normalizedTitle: 'HYPERshoot',
      normalizedName: 'HYPERshoot',
      alternateNames: 'HyperShoot',
      manualUrl: 'https://www.mossdistributing.com/userdocs/documents/MS0225_HYPERSHOOT.PDF',
      manualReady: true,
      reviewRequired: false,
      matchConfidence: 0.97,
    }),
    rabbits: trustedRow({
      assetId: 'virtual-rabbids-the-big-ride-01',
      assetName: 'Virtual Rabbids: The Big Ride (2-Player)',
      manufacturer: 'LAI Games',
      normalizedTitle: 'Virtual Rabbids: The Big Ride',
      normalizedName: 'Virtual Rabbids: The Big Ride',
      alternateNames: 'Virtual Rabbids',
      manualUrl: 'https://www.betson.com/wp-content/uploads/2020/01/VirtualRabbidsTheBigRideManual16.pdf',
      manualReady: true,
      reviewRequired: false,
      matchConfidence: 0.96,
    }),
    sinkit: trustedRow({
      assetId: 'sink-it-01',
      assetName: 'Sink It (2-Player)',
      manufacturer: 'Bay Tek Games',
      normalizedTitle: 'Sink It',
      normalizedName: 'Sink It',
      manualUrl: 'https://www.mossdistributing.com/userdocs/documents/MS0078_SINK%20IT.pdf',
      manualReady: true,
      reviewRequired: false,
      matchConfidence: 0.97,
    }),
    wizard: trustedRow({
      assetId: 'wizard-of-oz-coin-pusher-01',
      assetName: 'Wizard of Oz Coin Pusher',
      manufacturer: 'Elaut / Coastal Amusements',
      normalizedTitle: 'Wizard of Oz Coin Pusher',
      normalizedName: 'Wizard of Oz Coin Pusher',
      alternateNames: 'Wizard of Oz',
      manualUrl: 'https://www.betson.com/wp-content/uploads/2025/02/040-00094-01_Wizard-of-Oz_REV-05.pdf',
      manualReady: true,
      reviewRequired: false,
      matchConfidence: 0.91,
    }),
  };

  const result = await researchAssetTitles({
    db: createDb({ trustedManualCatalog }),
    settings: { aiEnabled: true, manualResearchWebSearchEnabled: true },
    companyId: 'company-1',
    titles: [
      { originalTitle: 'Jurassic Park Arcade', manufacturerHint: 'Raw Thrills' },
      { originalTitle: 'King Kong VR', manufacturerHint: 'Raw Thrills' },
      { originalTitle: 'HYPERshoot', manufacturerHint: 'LAI Games' },
      { originalTitle: 'Virtual Rabbids', manufacturerHint: 'LAI Games' },
      { originalTitle: 'Sink It', manufacturerHint: 'Bay Tek Games' },
      { originalTitle: 'Wizard of Oz', manufacturerHint: 'Elaut / Coastal Amusements' },
    ],
    traceId: 'trusted-short-circuit',
    fetchImpl: createFetchMock(),
    storage: createStorageMock(),
    researchFallback: async () => {
      stageTwoCalls += 1;
      return { manualReady: false, reviewRequired: true, matchType: 'support_only', manualUrl: '' };
    },
  });

  assert.equal(stageTwoCalls, 6);
  assert.equal(result.results.every((entry) => entry.pipelineMeta.trustedCatalogSelected === false), true);
  assert.equal(result.results.every((entry) => entry.pipelineMeta.discoverySkippedBecauseTrustedCatalogMatched === false), true);
  assert.equal(result.results.every((entry) => entry.pipelineMeta.trustedCatalogHit === false), true);
  assert.equal(result.results.every((entry) => !entry.pipelineMeta.trustedCatalogCandidateUrl), true);
});

test('trusted catalog review-only rows become strong candidates without auto-attach', async () => {
  let stageTwoCalls = 0;
  const result = await researchAssetTitles({
    db: createDb({
      trustedManualCatalog: {
        review_only: trustedRow({
          assetId: 'duck-derby-01',
          assetName: 'Duck Derby (2-Player)',
          manufacturer: 'Adrenaline Amusements',
          normalizedTitle: 'Duck Derby',
          normalizedName: 'Duck Derby',
          manualUrl: '',
          manualSourceUrl: 'https://www.betson.com/amusement-products/duck-derby/',
          supportUrl: 'https://adrenalineamusements.com/',
          manualReady: false,
          reviewRequired: true,
          matchConfidence: 0.78,
          matchType: 'no_manual',
        }),
      },
    }),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Duck Derby', manufacturerHint: 'Adrenaline Amusements' }],
    traceId: 'trusted-review-only',
    fetchImpl: createFetchMock(),
    storage: createStorageMock(),
    researchFallback: async () => {
      stageTwoCalls += 1;
      return {
        normalizedTitle: 'Duck Derby',
        manufacturer: 'Adrenaline Amusements',
        manualReady: false,
        reviewRequired: true,
        matchType: 'support_only',
        manualUrl: '',
      };
    },
  });

  assert.equal(stageTwoCalls, 1);
  assert.equal(result.results[0].manualReady, false);
  assert.equal(result.results[0].reviewRequired, true);
  assert.equal(result.results[0].pipelineMeta.trustedCatalogHit, false);
  assert.equal(result.results[0].pipelineMeta.trustedCatalogSelected, false);
});

test('trusted catalog short-circuit remains available only when explicitly enabled', async () => {
  let stageTwoCalls = 0;
  const result = await researchAssetTitles({
    db: createDb({
      trustedManualCatalog: {
        jp: trustedRow({
          assetId: 'jurassic-park-arcade-01',
          assetName: 'Jurassic Park Arcade (2-Player)',
          manufacturer: 'Raw Thrills',
          normalizedTitle: 'Jurassic Park Arcade',
          normalizedName: 'Jurassic Park Arcade',
          alternateNames: 'Jurassic Park',
          manualUrl: 'https://rawthrills.com/wp-content/uploads/2020/01/JP-Manual-r09.pdf',
          manualReady: true,
          reviewRequired: false,
          matchConfidence: 0.98,
        }),
      },
    }),
    settings: { aiEnabled: true, manualResearchEnableTrustedCatalogShortCircuit: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Jurassic Park Arcade', manufacturerHint: 'Raw Thrills' }],
    traceId: 'trusted-opt-in',
    fetchImpl: createFetchMock(),
    storage: createStorageMock(),
    researchFallback: async () => {
      stageTwoCalls += 1;
      return { manualReady: false, reviewRequired: true, matchType: 'support_only', manualUrl: '' };
    },
  });

  assert.equal(stageTwoCalls, 0);
  assert.equal(result.results[0].pipelineMeta.trustedCatalogSelected, true);
  assert.equal(result.results[0].pipelineMeta.discoverySkippedBecauseTrustedCatalogMatched, true);
});

test('researchAssetTitles loads reference hints from json index and reports reference summary metadata', async () => {
  const result = await researchAssetTitles({
    db: createDb(),
    settings: { aiEnabled: true },
    companyId: 'company-1',
    titles: [{ originalTitle: 'Jurassic Park Arcade', manufacturerHint: 'Raw Thrills' }],
    traceId: 'reference-json-index-hit',
    fetchImpl: createFetchMock(),
    storage: createStorageMock(),
    researchFallback: async () => ({
      normalizedTitle: 'Jurassic Park Arcade',
      manufacturer: 'Raw Thrills',
      confidence: 0.55,
      matchType: 'support_only',
      manualReady: false,
      reviewRequired: true,
      manualUrl: '',
      supportUrl: 'https://rawthrills.com/games/jurassic-park-arcade/',
      candidates: [
        { bucket: 'weak_lead', title: 'Raw Thrills Support', url: 'https://rawthrills.com/support/' },
        { bucket: 'verified_pdf_candidate', title: 'Jurassic Park Arcade Manual', url: 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-manual.pdf' },
      ],
      selectedCandidate: { bucket: 'weak_lead', title: 'Raw Thrills Support', url: 'https://rawthrills.com/support/' },
      citations: [{ url: 'https://rawthrills.com/games/jurassic-park-arcade/', title: 'Jurassic Park Arcade' }],
    }),
  });

  assert.equal(result.results[0].pipelineMeta.referenceHintSource, 'json_index');
  assert.equal(typeof result.results[0].pipelineMeta.referenceHit, 'boolean');
  assert.equal(typeof result.results[0].pipelineMeta.referenceEntryKey, 'string');
  assert.equal(typeof result.results[0].pipelineMeta.titlePageFirstApplied, 'boolean');
});
