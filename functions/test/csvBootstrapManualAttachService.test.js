const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrapAttachManualFromCsvHint } = require('../src/services/csvBootstrapManualAttachService');

function createDb(seed = {}) {
  const state = {
    assets: seed.assets || {},
    manuals: seed.manuals || {},
    manualChunks: seed.manualChunks || {},
  };
  return {
    state,
    recursiveDelete: async (collectionRef) => {
      const manualId = collectionRef?.manualId || '';
      if (manualId) state.manualChunks[manualId] = {};
    },
    batch() {
      const writes = [];
      return {
        set(ref, payload) {
          writes.push({ ref, payload });
        },
        async commit() {
          writes.forEach(({ ref, payload }) => {
            if (ref?.collectionName === 'chunks') {
              if (!state.manualChunks[ref.manualId]) state.manualChunks[ref.manualId] = {};
              state.manualChunks[ref.manualId][ref.docId] = payload;
            }
          });
        }
      };
    },
    collection(name) {
      if (name === 'assets' || name === 'manuals') {
        const bucket = state[name];
        return {
          doc(id) {
            return {
              id,
              async get() {
                const row = bucket[id];
                return { exists: !!row, id, data: () => row };
              },
              async set(payload, options = {}) {
                const existing = bucket[id] || {};
                bucket[id] = options.merge ? { ...existing, ...payload } : payload;
              },
              collection(subName) {
                if (name !== 'manuals' || subName !== 'chunks') throw new Error('Unexpected subcollection');
                return {
                  manualId: id,
                  collectionName: 'chunks',
                  doc(docId) {
                    return {
                      manualId: id,
                      collectionName: 'chunks',
                      docId,
                      async set(payload) {
                        if (!state.manualChunks[id]) state.manualChunks[id] = {};
                        state.manualChunks[id][docId] = payload;
                      }
                    };
                  },
                  limit() { return this; },
                  async get() {
                    const docs = Object.entries(state.manualChunks[id] || {}).map(([docId, payload]) => ({ id: docId, data: () => payload }));
                    return { docs };
                  }
                };
              }
            };
          },
          where() { return this; },
          limit() { return this; },
          async get() {
            const docs = Object.entries(bucket).map(([id, payload]) => ({ id, data: () => payload }));
            return { docs };
          }
        };
      }
      throw new Error(`Unexpected collection ${name}`);
    },
  };
}

test('bootstrap attach writes durable manual fields and classifies unsupported doc extraction outcomes', async () => {
  const db = createDb({
    assets: {
      'quick-drop': { id: 'quick-drop', name: 'Quick Drop', manufacturer: 'Bay Tek Games', companyId: 'company-1' },
    },
  });

  const savedFiles = [];
  const fileMap = new Map();
  const storage = {
    bucket() {
      return {
        file(path) {
          return {
            async save(buffer, options = {}) {
              const stored = Buffer.from(buffer);
              fileMap.set(path, { buffer: stored, options });
              savedFiles.push({ path, size: stored.length, options });
            },
            async download() {
              const row = fileMap.get(path);
              if (!row) throw new Error('missing_file');
              return [row.buffer];
            },
            async getMetadata() {
              const row = fileMap.get(path);
              return [{ contentType: row?.options?.contentType || 'text/plain', size: row?.buffer?.length || 0 }];
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
    manualHintUrl: 'https://manuals.example/quick-drop.doc',
    manualSourceHintUrl: 'https://manuals.example/quick-drop',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://manuals.example/quick-drop.doc',
      headers: { get: (name) => (name === 'content-type' ? 'text/plain' : '') },
      arrayBuffer: async () => Buffer.from('Error 10 / E10 means out of balloons. Refill balloon hopper.'),
    }),
    now: () => 'ts',
  });

  assert.equal(result.attached, true);
  assert.equal(savedFiles.length, 1);
  assert.equal(result.extractionStatus, 'unsupported_file_type');
  assert.equal(result.chunkCount, 0);
  assert.ok(result.manualId);
  const asset = db.state.assets['quick-drop'];
  assert.equal(asset.latestManualId, result.manualId);
  assert.equal(asset.manualChunkCount, 0);
  assert.equal(asset.documentationTextAvailable, false);
  const manual = db.state.manuals[result.manualId];
  assert.equal(manual.extractionStatus, 'unsupported_file_type');
  assert.equal(Object.keys(db.state.manualChunks[result.manualId] || {}).length, 0);
});

test('direct bootstrap attach remains successful even when extraction yields no text', async () => {
  const db = createDb({
    assets: {
      'asset-1': { id: 'asset-1', name: 'Asset One', manufacturer: 'Raw Thrills', companyId: 'company-1' },
    },
  });

  const fileMap = new Map();
  const storage = {
    bucket() {
      return {
        file(path) {
          return {
            async save(buffer, options = {}) {
              fileMap.set(path, { buffer: Buffer.from(buffer), options });
            },
            async download() {
              const row = fileMap.get(path);
              return [row?.buffer || Buffer.alloc(0)];
            },
            async getMetadata() {
              const row = fileMap.get(path);
              return [{ contentType: row?.options?.contentType || 'application/octet-stream', size: row?.buffer?.length || 0 }];
            }
          };
        }
      };
    }
  };

  const result = await bootstrapAttachManualFromCsvHint({
    db,
    storage,
    assetId: 'asset-1',
    manualHintUrl: 'https://manuals.example/opaque.bin.pdf',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://manuals.example/opaque.bin.pdf',
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => Buffer.from('%PDF-1.7'),
    }),
  });

  assert.equal(result.attached, true);
  assert.equal(result.status, 'docs_found');
  assert.ok(['no_text_extracted', 'failed'].includes(result.extractionStatus));
  assert.equal(db.state.assets['asset-1'].manualLibraryRef, '');
});

test('bootstrap attach returns non-blocking failure when acquisition fails validation', async () => {
  const db = createDb({
    assets: {
      'asset-2': { id: 'asset-2', name: 'Asset Two', manufacturer: 'Raw Thrills', companyId: 'company-1' },
    },
  });

  const result = await bootstrapAttachManualFromCsvHint({
    db,
    storage: { bucket: () => ({ file: () => ({ save: async () => {} }) }) },
    assetId: 'asset-2',
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
  assert.equal(db.state.assets['asset-2'].manualLibraryRef, undefined);
});
