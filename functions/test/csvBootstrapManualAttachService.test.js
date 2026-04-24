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
      'quick-drop': { id: 'quick-drop', name: 'Quick Drop', manufacturer: 'Bay Tek Games', companyId: 'company-1' },
    },
  });

  const savedFiles = [];
  const storage = {
    bucket() {
      return {
        file(path) {
          return {
            async save(buffer, options = {}) {
              savedFiles.push({ path, size: buffer.length, options });
            }
          };
        }
      };
    }
  };

  const result = await bootstrapAttachManualFromCsvHint({
    db,
    storage,
    assetId: 'quick-drop',
    userId: 'admin-1',
    manualHintUrl: 'https://manuals.example/quick-drop.pdf',
    manualSourceHintUrl: 'https://manuals.example/quick-drop',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://manuals.example/quick-drop.pdf',
      headers: { get: (name) => (name === 'content-type' ? 'application/pdf' : '') },
      arrayBuffer: async () => Buffer.from('%PDF-1.7 bootstrap manual'),
    }),
    now: () => 'ts',
  });

  assert.equal(result.attached, true);
  assert.equal(savedFiles.length, 1);
  const asset = db.state.assets['quick-drop'];
  assert.equal(asset.manualLibraryRef, '');
  assert.match(asset.manualStoragePath, /^companies\/company-1\/asset-manual-bootstrap\/quick-drop\/.+\.pdf$/);
  assert.equal(asset.attachmentMode, 'csv_direct_bootstrap');
  assert.equal(asset.manualProvenance, 'csv_direct_manual_import');
  assert.equal(asset.manualReviewState, 'manual_attached_bootstrap');
  assert.equal(asset.manualMatchSummary?.attachmentMode, 'csv_direct_bootstrap');
  assert.equal(asset.csvBootstrapManualAttach?.manualHintUrl, 'https://manuals.example/quick-drop.pdf');
});

test('bootstrap attach returns non-blocking failure when acquisition fails validation', async () => {
  const db = createDb({
    assets: {
      'asset-1': { id: 'asset-1', name: 'Asset One', manufacturer: 'Raw Thrills', companyId: 'company-1' },
    },
  });

  const result = await bootstrapAttachManualFromCsvHint({
    db,
    storage: { bucket: () => ({ file: () => ({ save: async () => {} }) }) },
    assetId: 'asset-1',
    manualHintUrl: 'https://manuals.example/not-a-manual.pdf',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://manuals.example/not-a-manual.pdf',
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => Buffer.from('<html>not a manual</html>'),
    }),
  });

  assert.equal(result.attached, false);
  assert.equal(result.status, 'bootstrap_attach_failed_validation');
  assert.equal(db.state.assets['asset-1'].manualLibraryRef, undefined);
});
