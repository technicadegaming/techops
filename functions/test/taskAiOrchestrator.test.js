const test = require('node:test');
const assert = require('node:assert/strict');
const { gatherContext } = require('../src/services/taskAiOrchestrator');

function buildDb() {
  const store = {
    tasks: { task1: { companyId: 'company-a', assetId: 'asset1', description: 'game down', updatedAt: '2026-03-20T00:00:00.000Z' } },
    assets: { asset1: { companyId: 'company-a', name: 'Quik Drop', manufacturer: 'Bay Tek Games', locationName: 'Arcade Floor', cabinetVariant: 'standard', family: 'Quik Drop', manualLinks: [], supportResourcesSuggestion: [{ url: 'https://example.com/support', label: 'Support' }] } },
    manuals: { m1: { companyId: 'company-a', assetId: 'asset1', extractionStatus: 'completed', approvedAt: '2026-03-20T00:00:00.000Z', sourceTitle: 'Manual', sourceUrl: 'https://example.com/manual.pdf', contentType: 'application/pdf' } },
    manualChunks: { m1: [{ text: 'Approved manual chunk text', chunkIndex: 0 }] },
    troubleshootingLibrary: { l1: { companyId: 'company-a', gameTitle: 'Quik Drop', resolutionSummary: 'Saved fix from prior issue.' } },
    notes: {}
  };

  function queryDocs(name, clauses) {
    const entries = Object.entries(store[name] || {}).map(([id, data]) => ({ id, data: () => data }));
    return entries.filter((doc) => clauses.every(({ field, value }) => (doc.data()[field] || null) === value));
  }

  function buildQuery(name, clauses = []) {
    return {
      where(field, _op, value) { return buildQuery(name, [...clauses, { field, value }]); },
      orderBy() { return this; },
      limit() { return this; },
      async get() { return { docs: queryDocs(name, clauses) }; }
    };
  }

  return {
    collection(name) {
      return {
        doc(id) {
          return {
            id,
            async get() { const row = store[name][id]; return { exists: !!row, id, data: () => row }; },
            collection() {
              return {
                orderBy() { return this; },
                limit() { return this; },
                async get() { return { docs: (store.manualChunks[id] || []).map((row, index) => ({ id: `${index}`, data: () => row })) }; }
              };
            }
          };
        },
        where(field, op, value) { return buildQuery(name, [{ field, value }]); }
      };
    }
  };
}

test('task AI context prefers approved manual chunks before troubleshooting fixes and support links', async () => {
  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    text: async () => `Support page for ${url}`
  });
  const context = await gatherContext(buildDb(), 'task1');
  const sources = context.documentationContext.items.map((item) => item.sourceType);
  assert.deepEqual(sources.slice(0, 3), ['approved_manual_chunk', 'troubleshooting_fix', 'support']);
  assert.equal(context.assetContext.locationName, 'Arcade Floor');
});
