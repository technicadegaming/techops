const test = require('node:test');
const assert = require('node:assert/strict');

const {
  queueManualAttachJob,
  processManualAttachJob,
  validateStoragePathForAsset,
} = require('../src/services/assetManualAttachService');

function createMockDb(seedAssets = []) {
  const state = {
    assets: Object.fromEntries(seedAssets.map((asset) => [asset.id, { ...asset }])),
    manualAttachJobs: {},
    manuals: {},
    manualChunks: {},
    manualCodeDefinitions: {},
  };

  function buildDocRef(name, id) {
    return {
      id,
      async get() {
        const row = state[name][id];
        return { exists: !!row, id, data: () => (row ? { ...row } : undefined) };
      },
      async set(payload, options = {}) {
        const existing = state[name][id] || {};
        state[name][id] = options.merge ? { ...existing, ...payload } : { ...payload };
      },
      collection(subName) {
        if (name !== 'manuals') throw new Error('Unsupported subcollection');
        return {
          doc(subId) {
            return {
              async set(payload) {
                if (subName === 'chunks') {
                  if (!state.manualChunks[id]) state.manualChunks[id] = {};
                  state.manualChunks[id][subId] = payload;
                }
                if (subName === 'codeDefinitions') {
                  if (!state.manualCodeDefinitions[id]) state.manualCodeDefinitions[id] = {};
                  state.manualCodeDefinitions[id][subId] = payload;
                }
              }
            };
          }
        };
      },
    };
  }

  return {
    state,
    batch() {
      const writes = [];
      return {
        set(ref, payload) { writes.push({ ref, payload }); },
        async commit() {
          for (const write of writes) {
            if (write.ref && typeof write.ref.set === 'function') {
              await write.ref.set(write.payload, { merge: false });
            }
          }
        }
      };
    },
    recursiveDelete: async () => {},
    collection(name) {
      return {
        doc(id = '') {
          if (!id) {
            const generatedId = `job-${Object.keys(state.manualAttachJobs).length + 1}`;
            return buildDocRef(name, generatedId);
          }
          return buildDocRef(name, id);
        },
        where() { return this; },
        limit() { return this; },
        async get() { return { docs: [] }; },
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
            async save(buffer, options = {}) {
              files.set(path, { buffer: Buffer.from(buffer), options });
            },
            async download() {
              return [files.get(path)?.buffer || Buffer.from('Simple manual text for extraction.')];
            },
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

test('queueManualAttachJob returns queued response quickly and writes job + asset queued state', async () => {
  const db = createMockDb([{ id: 'asset-1', companyId: 'company-1', name: 'Asset 1', firestoreDocId: 'asset-1' }]);
  const result = await queueManualAttachJob({
    db,
    asset: { id: 'asset-1', firestoreDocId: 'asset-1', companyId: 'company-1', name: 'Asset 1' },
    userId: 'u1',
    mode: 'url_attach',
    manualUrl: 'https://docs.example.com/manual.txt',
    sourceTitle: 'Asset 1 Manual',
  });

  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.ok(result.jobId);
  assert.equal(db.state.manualAttachJobs[result.jobId].status, 'queued');
  assert.equal(db.state.assets['asset-1'].manualAttachStatus, 'queued');
});

test('processManualAttachJob url mode downloads, materializes, and patches asset and job', async () => {
  const db = createMockDb([{ id: 'asset-2', companyId: 'company-1', name: 'Asset 2', firestoreDocId: 'asset-2', manualLinks: [] }]);
  const storage = createMockStorage();
  const queued = await queueManualAttachJob({
    db,
    asset: { id: 'asset-2', firestoreDocId: 'asset-2', companyId: 'company-1', name: 'Asset 2' },
    userId: 'u1',
    mode: 'url_attach',
    manualUrl: 'https://docs.example.com/manual.txt',
    sourceTitle: 'Asset 2 Manual',
  });

  const job = { id: queued.jobId, ...db.state.manualAttachJobs[queued.jobId] };
  const result = await processManualAttachJob({
    db,
    storage,
    job,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://docs.example.com/manual.txt',
      headers: { get: () => 'text/plain' },
      arrayBuffer: async () => Buffer.from('E10 means out of balloons. Refill hopper.'),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(db.state.manualAttachJobs[queued.jobId].status, 'completed');
  assert.equal(db.state.assets['asset-2'].manualAttachStatus, 'completed');
  assert.equal(db.state.assets['asset-2'].manualStatus, 'manual_attached');
  assert.equal(db.state.assets['asset-2'].documentationTextAvailable, true);
  assert.equal(Number(db.state.assets['asset-2'].manualChunkCount) > 0, true);
});

test('processManualAttachJob failure writes classified code and asset failed state', async () => {
  const db = createMockDb([{ id: 'asset-3', companyId: 'company-1', name: 'Asset 3', firestoreDocId: 'asset-3' }]);
  const storage = createMockStorage();
  const queued = await queueManualAttachJob({
    db,
    asset: { id: 'asset-3', firestoreDocId: 'asset-3', companyId: 'company-1', name: 'Asset 3' },
    userId: 'u1',
    mode: 'url_attach',
    manualUrl: 'https://docs.example.com/manual.pdf',
  });

  const job = { id: queued.jobId, ...db.state.manualAttachJobs[queued.jobId] };
  const result = await processManualAttachJob({
    db,
    storage,
    job,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://docs.example.com/manual.unsupported',
      headers: { get: () => 'application/octet-stream' },
      arrayBuffer: async () => Buffer.from('random-bytes'),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(db.state.manualAttachJobs[queued.jobId].status, 'failed');
  assert.equal(db.state.manualAttachJobs[queued.jobId].errorCode, 'unsupported_file_type');
  assert.equal(db.state.assets['asset-3'].manualAttachStatus, 'failed');
});

test('queueManualAttachJob supports storage path mode and validates path helper', async () => {
  const db = createMockDb([{ id: 'asset-4', companyId: 'company-1', name: 'Asset 4', firestoreDocId: 'asset-4' }]);
  const result = await queueManualAttachJob({
    db,
    asset: { id: 'asset-4', firestoreDocId: 'asset-4', companyId: 'company-1', name: 'Asset 4' },
    userId: 'u1',
    mode: 'storage_attach',
    storagePath: 'companies/company-1/manuals/asset-4/manual-uploads/manual.txt',
    contentType: 'text/plain',
  });

  assert.equal(result.queued, true);
  assert.equal(db.state.manualAttachJobs[result.jobId].mode, 'storage_attach');
  assert.equal(
    validateStoragePathForAsset({ companyId: 'company-1', assetId: 'asset-4', storagePath: 'companies/company-2/manuals/asset-4/file.pdf' }).valid,
    false,
  );
});

test('processManualAttachJob completes with warnings when text extraction fails after storage succeeds', async () => {
  const db = createMockDb([{ id: 'asset-5', companyId: 'company-1', name: 'Asset 5', firestoreDocId: 'asset-5', manualLinks: [] }]);
  const storage = createMockStorage();
  const queued = await queueManualAttachJob({
    db,
    asset: { id: 'asset-5', firestoreDocId: 'asset-5', companyId: 'company-1', name: 'Asset 5' },
    userId: 'u1',
    mode: 'url_attach',
    manualUrl: 'https://docs.example.com/manual.pdf',
    sourceTitle: 'Asset 5 Manual',
  });

  const job = { id: queued.jobId, ...db.state.manualAttachJobs[queued.jobId] };
  const result = await processManualAttachJob({
    db,
    storage,
    job,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://docs.example.com/manual.pdf',
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => Buffer.from('%PDF-1.4\n...'),
    }),
    materializeStoredAssetManualImpl: async () => ({
      ok: true,
      manualId: 'manual-asset-5',
      extractionStatus: 'failed',
      extractionReason: 'text_extraction_failed',
      extractionFailureCode: 'text_extraction_failed',
      extractionError: 'Maximum call stack size exceeded',
      chunkCount: 0,
      codeDefinitionCount: 0,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.warning, true);
  assert.equal(db.state.manualAttachJobs[queued.jobId].status, 'completed_with_warnings');
  assert.equal(db.state.manualAttachJobs[queued.jobId].errorCode, 'text_extraction_failed');
  assert.equal(db.state.assets['asset-5'].manualAttachStatus, 'completed');
  assert.equal(db.state.assets['asset-5'].manualStatus, 'manual_attached');
  assert.equal(db.state.assets['asset-5'].documentationTextAvailable, false);
  assert.equal(db.state.assets['asset-5'].manualTextExtractionStatus, 'failed');
  assert.equal(db.state.assets['asset-5'].manualChunkCount, 0);
  assert.equal(db.state.assets['asset-5'].latestManualTextExtractionCode, 'text_extraction_failed');
});

test('processManualAttachJob classifies thrown range error as text_extraction_failed', async () => {
  const db = createMockDb([{ id: 'asset-6', companyId: 'company-1', name: 'Asset 6', firestoreDocId: 'asset-6', manualLinks: [] }]);
  const storage = createMockStorage();
  const queued = await queueManualAttachJob({
    db,
    asset: { id: 'asset-6', firestoreDocId: 'asset-6', companyId: 'company-1', name: 'Asset 6' },
    userId: 'u1',
    mode: 'url_attach',
    manualUrl: 'https://docs.example.com/manual.pdf',
  });

  const job = { id: queued.jobId, ...db.state.manualAttachJobs[queued.jobId] };
  const result = await processManualAttachJob({
    db,
    storage,
    job,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://docs.example.com/manual.pdf',
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => Buffer.from('%PDF-1.4\n...'),
    }),
    materializeStoredAssetManualImpl: async () => {
      throw new RangeError('Maximum call stack size exceeded');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'text_extraction_failed');
  assert.equal(db.state.manualAttachJobs[queued.jobId].status, 'failed');
  assert.equal(db.state.manualAttachJobs[queued.jobId].errorCode, 'text_extraction_failed');
});
