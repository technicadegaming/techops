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
  const pdfHeaders = { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/pdf' : '') };
  const htmlHeaders = { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : '') };
  return async (input) => {
    const url = `${input || ''}`.toLowerCase();
    if (url.includes('/manuals/') && url.endsWith('.pdf')) {
      return {
        ok: true,
        status: 200,
        headers: pdfHeaders,
        text: async () => '',
        arrayBuffer: async () => Buffer.from('%PDF-1.4 benchmark fake manual'),
      };
    }
    if (url.includes('steprevolution.com/manuals/stepmaniax-operator-manual.pdf')) {
      return {
        ok: true,
        status: 200,
        headers: pdfHeaders,
        text: async () => '',
        arrayBuffer: async () => Buffer.from('%PDF-1.4 stepmaniax manual'),
      };
    }
    if (url.includes('rawthrills.com/wp-content/uploads/willy-crash-sell-sheet.pdf')) {
      return {
        ok: true,
        status: 200,
        headers: pdfHeaders,
        text: async () => '',
        arrayBuffer: async () => Buffer.from('%PDF-1.4 brochure'),
      };
    }
    if (url.includes('/support') || url.includes('/help')) {
      return {
        ok: true,
        status: 200,
        headers: htmlHeaders,
        text: async () => '<html><body><a href="https://example.com/manuals/hypershoot-operator.pdf">Operator Manual</a></body></html>',
        arrayBuffer: async () => Buffer.from(''),
      };
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => '' },
      text: async () => '',
      arrayBuffer: async () => Buffer.from(''),
    };
  };
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
  if (id.includes('angry')) {
    return {
      manualReady: true,
      reviewRequired: false,
      matchType: 'exact_manual',
      manualUrl: 'https://example.com/manuals/angry-birds-coin-crash-operator.pdf',
      candidates: [{
        title: 'Angry Birds Coin Crash Operator Manual',
        url: 'https://example.com/manuals/angry-birds-coin-crash-operator.pdf',
        bucket: 'verified_pdf_candidate',
      }],
    };
  }
  if (id.includes('hypershoot')) {
    return {
      manualReady: true,
      reviewRequired: false,
      matchType: 'manual_page_with_download',
      manualUrl: 'https://example.com/manuals/hypershoot-operator.pdf',
      manualSourceUrl: 'https://example.com/support/hypershoot',
      candidates: [{
        title: 'HYPERshoot Operator Manual',
        url: 'https://example.com/manuals/hypershoot-operator.pdf',
        bucket: 'verified_pdf_candidate',
      }],
    };
  }
  if (id.includes('ambiguous')) {
    return {
      manualReady: false,
      reviewRequired: true,
      matchType: 'support_only',
      manualUrl: '',
      candidates: [{
        title: 'Generic Support Landing',
        url: 'https://example.com/support/unknown-prototype',
        bucket: 'title_specific_support_page',
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

function evaluateScenario({ scenario, entry }) {
  const expected = scenario.expected || {};
  const terminalReason = `${entry?.pipelineMeta?.terminalStateReason || ''}`.trim();
  const documentationSuggestions = Array.isArray(entry?.documentationSuggestions) ? entry.documentationSuggestions : [];
  const hasUsableCandidate = documentationSuggestions.some((row) => `${row?.url || ''}`.trim());
  const selected = entry?.pipelineMeta?.selectedCandidate || entry?.pipelineMeta?.returnedCandidates?.[0] || {};
  const selectedText = `${selected.title || ''} ${selected.url || ''}`;
  const brochureWinner = /(brochure|sell\s*sheet|flyer|catalog|spec)/i.test(selectedText);
  const checks = {
    manualReady: typeof expected.manualReady !== 'boolean' ? true : entry.manualReady === expected.manualReady,
    terminalReason: !Array.isArray(expected.allowedTerminalReasons) || !expected.allowedTerminalReasons.length
      ? true
      : expected.allowedTerminalReasons.includes(terminalReason),
    forbiddenTerminalReason: !Array.isArray(expected.forbiddenTerminalReasons) || !expected.forbiddenTerminalReasons.length
      ? true
      : !expected.forbiddenTerminalReasons.includes(terminalReason),
    continuationCandidates: expected.mustHaveContinuationCandidates === true
      ? Number(entry?.pipelineMeta?.pipelineTrace?.stages?.continuation_candidates_after_failure_or_rejection?.continuationCandidateCount || 0) > 0
      : true,
    hintHydration: expected.mustLoadReferenceHints === true
      ? `${entry?.pipelineMeta?.referenceHintSource || 'none'}` !== 'none'
      : true,
    minReferenceProbeCount: Number(expected.minReferenceProbeCount || 0) > 0
      ? Number(entry?.pipelineMeta?.pipelineTrace?.diagnostics?.referenceProbeCount || 0) >= Number(expected.minReferenceProbeCount)
      : true,
    titlePageExtraction: expected.mustHaveTitlePageExtraction === true
      ? entry?.pipelineMeta?.sourcePageExtracted === true
      : true,
    brochureWinner: expected.allowBrochureWinner === false ? !brochureWinner : true,
    anyUsableCandidate: hasUsableCandidate,
  };
  return {
    id: scenario.id,
    set: scenario.set || 'default',
    title: scenario.title,
    manufacturer: scenario.manufacturer,
    manualReady: entry.manualReady === true,
    reviewRequired: entry.reviewRequired === true,
    terminalReason,
    selectedUrl: `${selected.url || ''}`,
    selectedTitle: `${selected.title || ''}`,
    brochureWinner,
    hasUsableCandidate,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

async function run() {
  const originalConsoleLog = console.log;
  console.log = () => {};
  const { scenarios } = loadFixture();
  const db = createDbStub();
  const scenarioResults = [];
  const summary = {
    total: scenarios.length,
    recallAt1: 0,
    recallAt5: 0,
    anyUsableCandidateRate: 0,
    autoAttachedRate: 0,
    brochureFalsePositiveRate: 0,
    hintHydrationSuccessRate: 0,
    titlePageExtractionSuccessRate: 0,
    acquisitionSuccessAfterManualGradeSelectionRate: 0,
    terminalReasonDistribution: {},
    scenarioPassRate: 0,
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
    const evaluated = evaluateScenario({ scenario, entry });
    scenarioResults.push(evaluated);

    summary.terminalReasonDistribution[evaluated.terminalReason] = (summary.terminalReasonDistribution[evaluated.terminalReason] || 0) + 1;
    if (evaluated.manualReady) summary.recallAt1 += 1;
    if ((entry.pipelineMeta?.returnedCandidates || []).slice(0, 5).length > 0 || evaluated.hasUsableCandidate) summary.recallAt5 += 1;
    if (evaluated.hasUsableCandidate) summary.anyUsableCandidateRate += 1;
    if (evaluated.manualReady && evaluated.reviewRequired !== true) summary.autoAttachedRate += 1;
    if (evaluated.brochureWinner && evaluated.manualReady) summary.brochureFalsePositiveRate += 1;
    if (`${entry?.pipelineMeta?.referenceHintSource || 'none'}` !== 'none') summary.hintHydrationSuccessRate += 1;
    if (entry?.pipelineMeta?.sourcePageExtracted === true) summary.titlePageExtractionSuccessRate += 1;
    if (entry?.pipelineMeta?.acquisitionEligible && entry?.pipelineMeta?.acquisitionSucceeded) summary.acquisitionSuccessAfterManualGradeSelectionRate += 1;
    if (evaluated.passed) summary.scenarioPassRate += 1;
  }

  const denominator = summary.total || 1;
  ['recallAt1', 'recallAt5', 'anyUsableCandidateRate', 'autoAttachedRate', 'brochureFalsePositiveRate', 'hintHydrationSuccessRate', 'titlePageExtractionSuccessRate', 'acquisitionSuccessAfterManualGradeSelectionRate', 'scenarioPassRate']
    .forEach((metric) => {
      summary[metric] = Number((summary[metric] / denominator).toFixed(4));
    });

  console.log = originalConsoleLog;
  process.stdout.write(`${JSON.stringify({ ok: true, summary, scenarioResults }, null, 2)}\n`);
}

run().catch((error) => {
  console.log = () => {};
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
