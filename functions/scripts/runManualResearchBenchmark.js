#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { researchAssetTitles } = require('../src/services/manualResearchService');

function loadFixture() {
  const fixturePath = path.resolve(__dirname, '../src/data/manualResearchBenchmarks/manualEnrichmentReliability.fixture.json');
  const parsed = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  return { fixturePath, scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios : [] };
}

function createDbStub() {
  const emptyDoc = { exists: false, data: () => ({}) };
  const query = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    get: async () => ({ docs: [] }),
  };
  return {
    collection: () => ({
      doc: () => ({ get: async () => emptyDoc, set: async () => null }),
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      get: async () => ({ docs: [] }),
    }),
  };
}

function createStorageStub() {
  return {
    bucket: () => ({
      file: () => ({
        save: async () => null,
        makePublic: async () => null,
      }),
    }),
  };
}

function createFetchStub() {
  return async () => ({
    ok: false,
    status: 404,
    headers: { get: () => '' },
    text: async () => '',
    arrayBuffer: async () => Buffer.from(''),
  });
}

function buildSyntheticResult(scenario = {}) {
  const id = `${scenario.id || ''}`.toLowerCase();
  if (id.includes('willy')) {
    return {
      manualReady: false,
      reviewRequired: true,
      matchType: 'support_only',
      manualUrl: '',
      candidates: [{
        title: 'Willy Crash Sell Sheet',
        url: 'https://rawthrills.com/wp-content/uploads/willy-crash-sell-sheet.pdf',
        bucket: 'brochure_or_spec_doc',
      }],
    };
  }
  if (id.includes('stepmaniax')) {
    return {
      manualReady: true,
      reviewRequired: false,
      matchType: 'exact_manual',
      manualUrl: 'https://steprevolution.com/manuals/stepmaniax-operator-manual.pdf',
      candidates: [{
        title: 'StepManiaX Operator Manual',
        url: 'https://steprevolution.com/manuals/stepmaniax-operator-manual.pdf',
        bucket: 'verified_pdf_candidate',
      }],
    };
  }
  return {
    manualReady: true,
    reviewRequired: false,
    matchType: 'exact_manual',
    manualUrl: `https://example.com/manuals/${encodeURIComponent(scenario.title || 'manual')}.pdf`,
    candidates: [{
      title: `${scenario.title || 'Game'} Operator Manual`,
      url: `https://example.com/manuals/${encodeURIComponent(scenario.title || 'manual')}.pdf`,
      bucket: 'verified_pdf_candidate',
    }],
  };
}

async function run() {
  const originalConsoleLog = console.log;
  console.log = () => {};
  const { scenarios } = loadFixture();
  const db = createDbStub();
  const summary = {
    total: scenarios.length,
    recallAt1: 0,
    anyUsableCandidateRate: 0,
    autoAttachedRate: 0,
    brochureFalsePositiveRate: 0,
    terminalReasonDistribution: {},
  };

  for (const scenario of scenarios) {
    const result = await researchAssetTitles({
      db,
      settings: { aiEnabled: true },
      companyId: 'benchmark-company',
      titles: [{ originalTitle: scenario.title, manufacturerHint: scenario.manufacturer }],
      fetchImpl: createFetchStub(),
      storage: createStorageStub(),
      researchFallback: async () => buildSyntheticResult(scenario),
    });
    const entry = result.results[0] || {};
    const terminal = `${entry?.pipelineMeta?.terminalStateReason || ''}`;
    summary.terminalReasonDistribution[terminal] = (summary.terminalReasonDistribution[terminal] || 0) + 1;
    if (entry.manualReady) summary.recallAt1 += 1;
    if ((entry.pipelineMeta?.returnedCandidates || []).length > 0) summary.anyUsableCandidateRate += 1;
    if (entry.manualReady && entry.reviewRequired !== true) summary.autoAttachedRate += 1;
    const selected = entry.pipelineMeta?.selectedCandidate || entry.pipelineMeta?.returnedCandidates?.[0] || {};
    const brochureLike = /(brochure|sell\s*sheet|flyer|catalog|spec)/i.test(`${selected.title || ''} ${selected.url || ''}`);
    if (brochureLike && entry.manualReady) summary.brochureFalsePositiveRate += 1;
  }

  const denominator = summary.total || 1;
  summary.recallAt1 = Number((summary.recallAt1 / denominator).toFixed(4));
  summary.anyUsableCandidateRate = Number((summary.anyUsableCandidateRate / denominator).toFixed(4));
  summary.autoAttachedRate = Number((summary.autoAttachedRate / denominator).toFixed(4));
  summary.brochureFalsePositiveRate = Number((summary.brochureFalsePositiveRate / denominator).toFixed(4));

  console.log = originalConsoleLog;
  process.stdout.write(`${JSON.stringify({ ok: true, summary }, null, 2)}\n`);
}

run().catch((error) => {
  console.log = () => {};
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
