const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');

const {
  backfillApprovedAssetManualLinkage,
  buildManualStoragePath,
  chunkManualText,
  createAssetManualId,
  extractPdfText,
  extractTextFromBuffer,
  materializeApprovedManualForAsset,
  resolveApprovedManualLibraryForAsset,
  stripHtml,
} = require('../src/services/manualIngestionService');

test('buildManualStoragePath uses company/asset/manual scoped structure', () => {
  assert.equal(
    buildManualStoragePath('company-a', 'asset-9', 'manual-1', 'application/pdf', 'https://example.com/manual.pdf'),
    'companies/company-a/manuals/asset-9/manual-1/source.pdf',
  );
});

test('stripHtml removes tags and normalizes whitespace', () => {
  assert.equal(stripHtml('<html><body><h1>Manual</h1><p>Step&nbsp;1</p></body></html>'), 'Manual Step 1');
});

test('chunkManualText creates ordered chunks with overlap-safe sizing', () => {
  const text = Array.from({ length: 20 }, (_, index) => `Sentence ${index + 1} includes a longer maintenance instruction for the technician.`).join(' ');
  const chunks = chunkManualText(text, { targetSize: 90, overlap: 15 });
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].chunkIndex, 0);
  assert.ok(chunks.every((chunk, index) => chunk.chunkIndex === index));
  assert.ok(chunks.every((chunk) => chunk.text.length > 0));
});

test('extractTextFromBuffer handles html content', () => {
  const text = extractTextFromBuffer(Buffer.from('<p>Operator Manual</p><p>Check fuse F1.</p>'), 'text/html', 'https://example.com/manual');
  assert.equal(text, 'Operator Manual Check fuse F1.');
});

test('extractPdfText extracts simple flate-compressed text operators', () => {
  const stream = Buffer.from('BT /F1 12 Tf 72 712 Td (Operator Manual) Tj ( Check fuse F1.) Tj ET', 'latin1');
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 2 0 R /Filter /FlateDecode >>\nstream\n', 'latin1'),
    deflateSync(stream),
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
  assert.match(extractPdfText(pdf), /Operator Manual/);
  assert.match(extractTextFromBuffer(pdf, 'application/pdf', 'https://example.com/manual.pdf'), /Check fuse F1/);
});

test('approved manual metadata preserves type, variant, family, manufacturer, and confidence fields', async () => {
  const { approveAssetManual } = require('../src/services/manualIngestionService');
  const writes = { manuals: {}, assets: {}, auditLogs: [], chunks: [], manualLibrary: {} };
  const stream = Buffer.from('BT /F1 12 Tf 72 712 Td (Check fuse F1.) Tj ( Inspect coin door switch.) Tj ET', 'latin1');
  const extractablePdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 2 0 R /Filter /FlateDecode >>\nstream\n', 'latin1'),
    deflateSync(stream),
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/pdf' },
    arrayBuffer: async () => extractablePdf
  });
  const savedFiles = {};
  const db = {
    collection(name) {
      return {
        where() { return this; },
        limit() { return this; },
        async get() { return { empty: true, docs: [] }; },
        doc(id) {
          return {
            id,
            set: async (payload, options = {}) => {
              if (!writes[name]) writes[name] = {};
              writes[name][id] = options.merge ? { ...(writes[name][id] || {}), ...payload } : payload;
            },
            collection() {
              return {
                doc(chunkId) {
                  return {
                    id: chunkId,
                    set: async (payload) => {
                      writes.chunks.push({ id: chunkId, payload });
                    }
                  };
                }
              };
            }
          };
        },
        add: async (payload) => { writes.auditLogs.push(payload); }
      };
    },
    batch() {
      const ops = [];
      return { set(ref, payload) { ops.push({ ref, payload }); }, async commit() { writes.chunks = ops; } };
    },
    recursiveDelete: async () => {}
  };
  const storage = {
    bucket() {
      return {
        file(path) {
          return {
            save: async (buffer) => { savedFiles[path] = Buffer.from(buffer); },
            download: async () => [savedFiles[path] || Buffer.from('<html><body>Check fuse F1. Inspect coin door switch.</body></html>')],
          };
        }
      };
    }
  };
  await approveAssetManual({
    db,
    storage,
    asset: {
      id: 'asset1',
      companyId: 'company-a',
      name: 'Fast and Furious Arcade',
      manufacturer: 'Raw Thrills',
      documentationSuggestions: [{
        url: 'https://rawthrills.com/manuals/fast-furious.pdf',
        title: 'Manual',
        manualType: 'operator_manual',
        cabinetVariant: '2 player',
        family: 'Fast and Furious Arcade',
        matchedManufacturer: 'raw thrills',
        confidence: 0.88,
        verified: true,
        exactTitleMatch: true,
        exactManualMatch: true,
        trustedSource: true
      }],
      locationName: 'Front Room'
    },
    userId: 'user1',
    sourceUrl: 'https://rawthrills.com/manuals/fast-furious.pdf'
  });
  const manual = Object.values(writes.manualLibrary)[0];
  assert.equal(manual.variant, '2 player');
  assert.equal(manual.familyTitle, 'Fast and Furious Arcade');
  assert.equal(manual.manufacturer, 'Raw Thrills');
  assert.equal(manual.matchConfidence, 0.88);
  assert.match(manual.storagePath, /^manual-library\/raw-thrills\//);
  assert.equal(writes.assets.asset1.manualLibraryRef?.length > 0, true);
  assert.equal(writes.assets.asset1.manualStatus, 'attached');
  const materializedManual = Object.values(writes.manuals)[0];
  assert.equal(materializedManual.manualLibraryRef, writes.assets.asset1.manualLibraryRef);
  assert.match(materializedManual.storagePath, /^companies\/company-a\/manuals\/asset1\/manual-/);
  assert.ok(writes.chunks.length >= 1);
});


test('approveAssetManual rejects support-only URLs that are not reviewable manual candidates', async () => {
  const { approveAssetManual } = require('../src/services/manualIngestionService');
  const db = {
    collection() {
      return {
        where() { return this; },
        limit() { return this; },
        async get() { return { empty: true, docs: [] }; },
        doc() { return { set: async () => {}, collection() { return { doc() { return { id: '0' }; } }; } }; },
        add: async () => {}
      };
    },
    batch() { return { set() {}, async commit() {} }; },
    recursiveDelete: async () => {}
  };
  const storage = { bucket() { return { file() { return { save: async () => {} }; } }; } };

  await assert.rejects(() => approveAssetManual({
    db,
    storage,
    asset: {
      id: 'asset1',
      companyId: 'company-a',
      name: 'Jurassic Park',
      manufacturer: 'Raw Thrills',
      documentationSuggestions: [{
        url: 'https://rawthrills.com/service-support/',
        title: 'Raw Thrills Service Support',
        sourceType: 'support',
        verified: true,
        exactTitleMatch: false,
        exactManualMatch: false,
        trustedSource: true,
        verificationKind: 'support_html'
      }]
    },
    userId: 'user1',
    sourceUrl: 'https://rawthrills.com/service-support/'
  }), /not a reviewable manual candidate/);
});

test('materializeApprovedManualForAsset reuses stable asset manual identity and creates chunks from shared storage', async () => {
  const writes = { manuals: {}, chunks: [], deleted: [] };
  const sharedPath = 'manual-library/bay-tek/quik-drop/existing.pdf';
  const sharedBuffer = Buffer.from('<html><body>Reset dispenser. Verify ticket sensor. Tighten ramp bolts.</body></html>');
  const db = {
    collection(name) {
      return {
        where() { return this; },
        limit() { return this; },
        async get() { return { docs: [] }; },
        doc(id) {
          return {
            id,
            set: async (payload, options = {}) => {
              if (name === 'manuals') writes.manuals[id] = options.merge ? { ...(writes.manuals[id] || {}), ...payload } : payload;
            },
            collection() {
              return {
                doc(chunkId) {
                  return {
                    id: chunkId,
                    set: async (payload) => writes.chunks.push({ chunkId, payload })
                  };
                }
              };
            }
          };
        }
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, payload) { ops.push({ ref, payload }); },
        async commit() { writes.chunks = ops; }
      };
    },
    recursiveDelete: async (ref) => { writes.deleted.push(ref); }
  };
  const savedFiles = {};
  const storage = {
    bucket() {
      return {
        file(path) {
          return {
            save: async (buffer) => { savedFiles[path] = Buffer.from(buffer); },
            download: async () => [path === sharedPath ? sharedBuffer : (savedFiles[path] || Buffer.alloc(0))],
          };
        }
      };
    }
  };

  const result = await materializeApprovedManualForAsset({
    db,
    storage,
    asset: { id: 'asset1', companyId: 'company-a', name: 'Quik Drop', manufacturer: 'Bay Tek Games' },
    manualLibrary: {
      id: 'manual-quik-drop',
      canonicalTitle: 'Quik Drop Manual',
      manufacturer: 'Bay Tek Games',
      familyTitle: 'Quik Drop',
      variant: 'standard',
      storagePath: sharedPath,
      contentType: 'text/html',
      sha256: 'abc123',
      matchConfidence: 0.95
    },
    userId: 'user-1',
    sourceUrl: 'https://example.com/quik-drop.pdf',
    sourceTitle: 'Quik Drop Manual'
  });

  assert.equal(result.extractionStatus, 'completed');
  assert.ok(result.chunkCount >= 1);
  assert.ok(savedFiles[result.storagePath]);
  assert.equal(writes.manuals[result.manualId].manualLibraryRef, 'manual-quik-drop');
});

test('resolveApprovedManualLibraryForAsset matches approved records by exact shared storage path or download URL', async () => {
  const db = {
    collection() {
      return {
        doc(id) {
          return {
            async get() { return { exists: false, id, data: () => null }; }
          };
        },
        limit() { return this; },
        async get() {
          return {
            docs: [{
              id: 'manual-quik-drop',
              data: () => ({
                approved: true,
                approvalState: 'approved',
                storagePath: 'manual-library/bay-tek/quik-drop/existing.pdf',
                originalDownloadUrl: 'https://example.com/quik-drop.pdf',
                resolvedDownloadUrl: 'https://cdn.example.com/quik-drop.pdf',
              })
            }]
          };
        }
      };
    }
  };
  const matched = await resolveApprovedManualLibraryForAsset({
    db,
    asset: {
      id: 'asset1',
      companyId: 'company-a',
      manualLinks: ['https://example.com/quik-drop.pdf']
    }
  });
  assert.equal(matched.manualLibrary.id, 'manual-quik-drop');
  assert.equal(matched.evidence, 'exact_path_or_url_match');
});

test('backfillApprovedAssetManualLinkage is additive in dry-run mode and skips conflicting existing linkage', async () => {
  const sharedPath = 'manual-library/bay-tek/quik-drop/existing.pdf';
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (name === 'manualLibrary' && id === 'manual-quik-drop') {
                return {
                  exists: true,
                  id,
                  data: () => ({
                    approved: true,
                    approvalState: 'approved',
                    storagePath: sharedPath,
                    originalDownloadUrl: 'https://example.com/quik-drop.pdf',
                    contentType: 'text/html',
                    canonicalTitle: 'Quik Drop Manual'
                  })
                };
              }
              return { exists: false, id, data: () => null };
            }
          };
        },
        where() { return this; },
        limit() { return this; },
        async get() {
          if (name === 'manualLibrary') {
            return {
              docs: [{
                id: 'manual-quik-drop',
                data: () => ({
                  approved: true,
                  approvalState: 'approved',
                  storagePath: sharedPath,
                  originalDownloadUrl: 'https://example.com/quik-drop.pdf',
                  contentType: 'text/html',
                  canonicalTitle: 'Quik Drop Manual'
                })
              }]
            };
          }
          return { docs: [] };
        }
      };
    }
  };
  const dryRun = await backfillApprovedAssetManualLinkage({
    db,
    storage: { bucket() { return { file() { return { save: async () => {}, download: async () => [Buffer.from('Reset game.')] }; } }; } },
    asset: {
      id: 'asset1',
      companyId: 'company-a',
      name: 'Quik Drop',
      manualLinks: ['https://example.com/quik-drop.pdf'],
      manualLibraryRef: '',
      manualStoragePath: ''
    },
    userId: 'user-1',
    dryRun: true
  });
  assert.equal(dryRun.linked, true);
  assert.equal(dryRun.patchedAsset, true);
  assert.equal(dryRun.materializedManual, true);
  assert.equal(dryRun.patchedAsset, true);
  assert.equal(dryRun.manualId, createAssetManualId({
    companyId: 'company-a',
    assetId: 'asset1',
    manualLibraryRef: 'manual-quik-drop',
    storagePath: sharedPath,
  }));

  const conflict = await backfillApprovedAssetManualLinkage({
    db,
    storage: { bucket() { return { file() { return { save: async () => {}, download: async () => [Buffer.from('Reset game.')] }; } }; } },
    asset: {
      id: 'asset1',
      companyId: 'company-a',
      name: 'Quik Drop',
      manualLinks: ['https://example.com/quik-drop.pdf'],
      manualLibraryRef: 'different-manual',
      manualStoragePath: 'manual-library/other/title.pdf'
    },
    userId: 'user-1',
    dryRun: true
  });
  assert.equal(conflict.skipped, true);
  assert.equal(conflict.reason, 'existing_manual_linkage_conflict');
});
