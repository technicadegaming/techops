const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrapAttachManualFromCsvHint } = require('../src/services/csvBootstrapManualAttachService');

function createDb(seed = {}) {
  const state = {
    assets: seed.assets || {},
  };
  return {
    state,
    collection(name) {
      const bucket = state[name];
      if (!bucket) throw new Error(`Unexpected collection ${name}`);
      return {
        doc(id) {
          return {
            async get() {
              const row = bucket[id];
              return { exists: !!row, data: () => row };
            },
            async set(payload, options = {}) {
              const existing = bucket[id] || {};
              bucket[id] = options.merge ? { ...existing, ...payload } : payload;
            },
          };
        },
      };
    },
  };
}

test('bootstrap attach writes durable manual fields and provenance when acquisition succeeds', async () => {
  const db = createDb({
    assets: {
      'quick-drop': { id: 'quick-drop', name: 'Quick Drop', manufacturer: 'Bay Tek Games' },
    },
  });

  const result = await bootstrapAttachManualFromCsvHint({
    db,
    storage: {},
    assetId: 'quick-drop',
    userId: 'admin-1',
    manualHintUrl: 'https://manuals.example/quick-drop.pdf',
    manualSourceHintUrl: 'https://manuals.example/quick-drop',
    acquireManual: async () => ({
      manualReady: true,
      manualUrl: 'manual-library/bay-tek-games/quick-drop/abc123.pdf',
      manualSourceUrl: 'https://manuals.example/quick-drop',
      manualLibrary: { id: 'ml-quick-drop', storagePath: 'manual-library/bay-tek-games/quick-drop/abc123.pdf' },
    }),
    now: () => 'ts',
  });

  assert.equal(result.attached, true);
  const asset = db.state.assets['quick-drop'];
  assert.equal(asset.manualLibraryRef, 'ml-quick-drop');
  assert.equal(asset.manualStoragePath, 'manual-library/bay-tek-games/quick-drop/abc123.pdf');
  assert.equal(asset.attachmentMode, 'csv_bootstrap');
  assert.equal(asset.manualProvenance, 'csv_manual_hint_direct_attach');
  assert.equal(asset.manualReviewState, 'manual_attached_bootstrap');
  assert.equal(asset.manualMatchSummary?.attachmentMode, 'csv_bootstrap');
  assert.equal(asset.csvBootstrapManualAttach?.manualHintUrl, 'https://manuals.example/quick-drop.pdf');
});

test('bootstrap attach returns non-blocking failure when acquisition fails validation', async () => {
  const db = createDb({
    assets: {
      'asset-1': { id: 'asset-1', name: 'Asset One', manufacturer: 'Raw Thrills' },
    },
  });

  const result = await bootstrapAttachManualFromCsvHint({
    db,
    storage: {},
    assetId: 'asset-1',
    manualHintUrl: 'https://manuals.example/not-a-manual.pdf',
    acquireManual: async () => ({ manualReady: false }),
  });

  assert.equal(result.attached, false);
  assert.equal(result.status, 'bootstrap_attach_failed_validation');
  assert.equal(db.state.assets['asset-1'].manualLibraryRef, undefined);
});
