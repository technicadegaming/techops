const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachAssetManualFromStoragePath,
  attachAssetManualFromUrl,
} = require('../src/services/assetManualAttachService');

function createMockDb(asset = {}) {
  const state = { assets: { [asset.id]: { ...asset } }, manuals: {}, manualChunks: {} };
  return {
    state,
    batch() {
      const writes = [];
      return {
        set(ref, payload) { writes.push({ ref, payload }); },
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
    recursiveDelete: async () => {},
    collection(name) {
      return {
        where() { return this; },
        limit() { return this; },
        async get() { return { docs: [] }; },
        doc(id) {
          return {
            async set(payload, options = {}) {
              if (name === 'assets') {
                const existing = state.assets[id] || {};
                state.assets[id] = options.merge ? { ...existing, ...payload } : payload;
              }
              if (name === 'manuals') {
                const existing = state.manuals[id] || {};
                state.manuals[id] = options.merge ? { ...existing, ...payload } : payload;
              }
            },
            collection(subName) {
              if (name !== 'manuals' || subName !== 'chunks') throw new Error('Unexpected subcollection');
              return {
                manualId: id,
                collectionName: 'chunks',
                doc(docId) {
                  return { manualId: id, collectionName: 'chunks', docId };
                }
              };
            },
          };
        }
      };
    }
  };
}

function createMockStorage() {
  const files = new Map();
  return {
    files,
    bucket() {
      return {
        file(path) {
          return {
            async save(buffer, options = {}) { files.set(path, { buffer: Buffer.from(buffer), options }); },
            async download() { return [files.get(path)?.buffer || Buffer.from('Simple manual text for extraction.')]; },
            async getMetadata() {
              const row = files.get(path);
              return [{ contentType: row?.options?.contentType || 'text/plain', size: row?.buffer?.length || 0 }];
            }
          };
        }
      };
    }
  };
}

test('attachAssetManualFromUrl stores file, materializes chunks, and patches asset', async () => {
  const asset = { id: 'asset-1', companyId: 'company-1', name: 'Asset 1', manualLinks: [] };
  const db = createMockDb(asset);
  const storage = createMockStorage();
  const result = await attachAssetManualFromUrl({
    db,
    storage,
    asset,
    userId: 'u1',
    manualUrl: 'https://docs.example.com/manual.txt',
    sourceTitle: 'Asset 1 Manual',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://docs.example.com/manual.txt',
      headers: { get: () => 'text/plain' },
      arrayBuffer: async () => Buffer.from('E10 means out of balloons. Refill hopper.'),
    }),
  });
  assert.equal(result.attached, true);
  assert.equal(result.chunkCount > 0, true);
  assert.equal(result.documentationTextAvailable, true);
  const savedAsset = db.state.assets['asset-1'];
  assert.equal(savedAsset.latestManualId?.startsWith('manual-'), true);
  assert.equal(savedAsset.manualChunkCount > 0, true);
  assert.equal(savedAsset.documentationTextAvailable, true);
  assert.equal(savedAsset.manualStatus, 'manual_attached');
});

test('attachAssetManualFromUrl succeeds with warning when no text is extracted', async () => {
  const asset = { id: 'asset-2', companyId: 'company-1', name: 'Asset 2', manualLinks: [] };
  const db = createMockDb(asset);
  const storage = createMockStorage();
  const result = await attachAssetManualFromUrl({
    db,
    storage,
    asset,
    userId: 'u1',
    manualUrl: 'https://docs.example.com/manual.pdf',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://docs.example.com/manual.pdf',
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => Buffer.from('%PDF-1.7'),
    }),
  });
  assert.equal(result.attached, true);
  assert.equal(result.chunkCount, 0);
  assert.match(result.warning, /no readable text|file type is not text-extractable/i);
});

test('attachAssetManualFromStoragePath rejects paths outside company/asset scope', async () => {
  const asset = { id: 'asset-3', companyId: 'company-1', name: 'Asset 3', manualLinks: [] };
  await assert.rejects(() => attachAssetManualFromStoragePath({
    db: createMockDb(asset),
    storage: createMockStorage(),
    asset,
    userId: 'u1',
    storagePath: 'companies/company-2/manuals/asset-3/manual-uploads/file.pdf',
    contentType: 'application/pdf',
  }), /outside the allowed company\/asset manual scope/i);
});

test('attachAssetManualFromStoragePath materializes valid scoped path and patches asset', async () => {
  const asset = { id: 'asset-4', companyId: 'company-1', name: 'Asset 4', manualLinks: [] };
  const db = createMockDb(asset);
  const storage = createMockStorage();
  const storagePath = 'companies/company-1/manuals/asset-4/manual-uploads/1234-manual.txt';
  storage.files.set(storagePath, { buffer: Buffer.from('Reset breaker then reboot game.'), options: { contentType: 'text/plain' } });
  const result = await attachAssetManualFromStoragePath({
    db,
    storage,
    asset,
    userId: 'u1',
    storagePath,
    contentType: 'text/plain',
  });
  assert.equal(result.attached, true);
  assert.equal(result.chunkCount > 0, true);
  assert.equal(db.state.assets['asset-4'].latestManualId?.startsWith('manual-'), true);
});
