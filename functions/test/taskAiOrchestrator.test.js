const test = require('node:test');
const assert = require('node:assert/strict');
const { gatherContext } = require('../src/services/taskAiOrchestrator');

function buildDb() {
  const store = {
    tasks: { task1: { companyId: 'company-a', assetId: 'asset1', description: 'game down', updatedAt: '2026-03-20T00:00:00.000Z' } },
    assets: { asset1: { companyId: 'company-a', name: 'Quik Drop', manufacturer: 'Bay Tek Games', locationName: 'Arcade Floor', cabinetVariant: 'standard', family: 'Quik Drop', manualLibraryRef: 'shared-manual-1', manualLinks: [], supportResourcesSuggestion: [{ url: 'https://example.com/support', label: 'Support' }] } },
    manuals: { m1: { companyId: 'company-a', assetId: 'asset1', extractionStatus: 'completed', approvedAt: '2026-03-20T00:00:00.000Z', sourceTitle: 'Manual', sourceUrl: 'https://example.com/manual.pdf', contentType: 'application/pdf' } },
    manualLibrary: { 'shared-manual-1': { canonicalTitle: 'Quik Drop Service Manual', manufacturer: 'Bay Tek Games', sourcePageUrl: 'https://example.com/manual-source', storagePath: 'manual-library/bay-tek/quik-drop/existing.pdf', approvalState: 'approved', approved: true } },
    manualChunks: { m1: [{ text: 'Approved manual chunk text', chunkIndex: 0 }] },
    troubleshootingLibrary: {
      l1: { companyId: 'company-a', gameTitle: 'Quik Drop', resolutionSummary: 'Saved fix from prior issue.' },
      l2: { companyId: 'company-a', manufacturer: 'Bay Tek Games', assetType: 'ticket_redemption', assetName: 'Quik Drop Deluxe', successfulFix: 'Adjusted sensor harness.' }
    },
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

test('task AI context prefers approved manual chunks, then linked manualLibrary context, before troubleshooting fixes and support links', async () => {
  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    text: async () => `Support page for ${url}`
  });
  const context = await gatherContext(buildDb(), 'task1');
  const sources = context.documentationContext.items.map((item) => item.sourceType);
  assert.deepEqual(sources.slice(0, 4), ['approved_manual_chunk', 'manual_library_link', 'troubleshooting_fix', 'support']);
  assert.equal(context.documentationContext.mode, 'approved_manual_internal');
  assert.equal(context.assetContext.locationName, 'Arcade Floor');
});

test('task AI degrades gracefully to linked manualLibrary context when no approved chunk exists yet', async () => {
  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    text: async () => `Support page for ${url}`
  });
  const db = buildDb();
  const context = await gatherContext({
    collection(name) {
      if (name === 'manuals') {
        return {
          where() {
            return {
              where() { return this; },
              limit() { return this; },
              async get() { return { docs: [] }; }
            };
          },
          doc(id) {
            return {
              id,
              async get() { return { exists: false, id, data: () => null }; },
              collection() {
                return {
                  orderBy() { return this; },
                  limit() { return this; },
                  async get() { return { docs: [] }; }
                };
              }
            };
          }
        };
      }
      return db.collection(name);
    }
  }, 'task1');
  assert.equal(context.documentationContext.mode, 'manual_library_backed');
  assert.equal(context.documentationContext.items[0].sourceType, 'manual_library_link');
  assert.match(context.documentationContext.items[0].excerpts[0], /Shared manual: Quik Drop Service Manual/);
});

test('task AI context includes troubleshooting records that match by manufacturer or asset metadata', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    text: async () => 'Support fallback'
  });
  const context = await gatherContext(buildDb(), 'task1');
  const troubleshootingEntries = context.troubleshootingLibrary;
  assert.equal(troubleshootingEntries.length >= 2, true);
  assert.equal(troubleshootingEntries.some((row) => row.manufacturer === 'Bay Tek Games'), true);
  assert.equal(context.documentationContext.items.some((item) => item.sourceType === 'troubleshooting_fix'), true);
});
