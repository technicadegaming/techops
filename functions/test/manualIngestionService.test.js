const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');

const {
  backfillApprovedAssetManualLinkage,
  buildManualStoragePath,
  buildManualErrorCodeIndexFromChunks,
  chunkManualText,
  createAssetManualId,
  extractManualErrorCodeDefinitions,
  extractPdfText,
  extractTextFromBuffer,
  extractTextFromBufferAsync,
  materializeApprovedManualForAsset,
  materializeStoredAssetManual,
  resolveManualStoragePath,
  resolveApprovedManualLibraryForAsset,
  stripHtml,
} = require('../src/services/manualIngestionService');

test('extractManualErrorCodeDefinitions parses multiline table-style error definitions with reset instruction', () => {
  const text = `ERROR 11
CARD DISPENSER ERROR
CARD EMPTY IN THE DISPENSER or CARD JAM or DISPENSING SENSOR PROBLEM.
(AFTER TAKING ACTION, PRESS RESET BUTTON)`;
  const rows = extractManualErrorCodeDefinitions(text);
  assert.equal(rows.length >= 1, true);
  const e11 = rows.find((row) => row.code === 'E11');
  assert.ok(e11);
  assert.equal(e11.title, 'CARD DISPENSER ERROR');
  assert.match(e11.meaning, /CARD EMPTY/i);
  assert.match(e11.meaning, /CARD JAM/i);
  assert.match(e11.meaning, /DISPENSING SENSOR/i);
  assert.match(e11.resetInstruction, /PRESS RESET BUTTON/i);
});

test('extractManualErrorCodeDefinitions parses compact E-code entries', () => {
  const rows = extractManualErrorCodeDefinitions('E10: Out of Balloons\nE11: Balloon Load Error');
  assert.equal(rows.some((row) => row.code === 'E10' && /Out of Balloons/i.test(row.meaning)), true);
  assert.equal(rows.some((row) => row.code === 'E11' && /Balloon Load Error/i.test(row.meaning)), true);
});

test('extractManualErrorCodeDefinitions avoids false positives from plain page numbers', () => {
  const rows = extractManualErrorCodeDefinitions('Page 11\nSection 11.2\nMaintenance schedule every 11 days');
  assert.equal(rows.length, 0);
});

test('buildManualErrorCodeIndexFromChunks deduplicates by code and meaning/title', () => {
  const rows = buildManualErrorCodeIndexFromChunks([
    { text: 'Error 10: Out of Balloons' },
    { text: 'E10 - Out of Balloons' },
    { text: 'Error 11: Card Dispenser Error - Card Jam' }
  ]);
  assert.equal(rows.filter((row) => row.code === 'E10').length, 1);
  assert.equal(rows.some((row) => row.code === 'E11'), true);
});

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

test('extractTextFromBufferAsync uses robust PDF extraction path and preserves troubleshooting code phrases', async () => {
  const stream = Buffer.from('BT /F1 12 Tf 72 712 Td (ERROR CODES AND TROUBLESHOOTING GUIDE) Tj ( E10: Out of Balloons.) Tj ET', 'latin1');
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 2 0 R /Filter /FlateDecode >>\nstream\n', 'latin1'),
    deflateSync(stream),
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
  const extracted = await extractTextFromBufferAsync(pdf, 'application/pdf', 'https://example.com/manual.pdf');
  assert.match(extracted.text, /E10:\s*Out of Balloons/i);
  assert.match(extracted.text, /ERROR CODES AND TROUBLESHOOTING GUIDE/i);
  assert.equal(['pdf-parse', 'legacy_pdf_operator_parser'].includes(extracted.extractionEngine), true);
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
  assert.equal(writes.assets.asset1.manualStatus, 'manual_attached');
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

test('materializeStoredAssetManual creates deterministic manual doc and chunks from tenant storage path', async () => {
  const writes = { manuals: {}, chunks: [], codeDefinitions: [] };
  const storagePath = 'companies/company-a/asset-manual-bootstrap/asset1/manual.txt';
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            id,
            set: async (payload, options = {}) => {
              if (name === 'manuals') writes.manuals[id] = options.merge ? { ...(writes.manuals[id] || {}), ...payload } : payload;
            },
            collection(subName) {
              if (!['chunks', 'codeDefinitions'].includes(subName)) throw new Error('unexpected');
              return {
                manualId: id,
                doc(rowId) {
                  return {
                    id: rowId,
                    set: async (payload) => {
                      if (subName === 'chunks') writes.chunks.push({ id: rowId, payload });
                      if (subName === 'codeDefinitions') writes.codeDefinitions.push({ id: rowId, payload });
                    }
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
    recursiveDelete: async () => {}
  };
  const storage = {
    bucket() {
      return {
        file(path) {
          return {
            async download() {
              assert.equal(path, storagePath);
              return [Buffer.from('Error 10 / E10: Out of balloons. Refill balloons and retry.')];
            },
            async getMetadata() {
              return [{ contentType: 'text/plain', size: 62 }];
            }
          };
        }
      };
    }
  };
  const result = await materializeStoredAssetManual({
    db,
    storage,
    asset: { id: 'asset1', companyId: 'company-a', name: 'Pop It & Win', manufacturer: 'Sega' },
    userId: 'u-1',
    storagePath,
    sourceUrl: 'https://example.com/pop-it-manual',
    sourceTitle: 'Pop It Manual',
    sourceType: 'csv_direct_bootstrap_manual',
    manualType: 'csv_direct_bootstrap_manual',
    contentType: 'text/plain',
    attachmentMode: 'csv_direct_bootstrap',
    manualProvenance: 'csv_direct_manual_import',
  });
  assert.equal(result.extractionStatus, 'completed');
  assert.ok(result.chunkCount > 0);
  assert.ok(writes.manuals[result.manualId]);
  assert.equal(writes.manuals[result.manualId].storagePath, storagePath);
  assert.equal(['text', 'pdf-parse', 'legacy_pdf_operator_parser'].includes(writes.manuals[result.manualId].extractionEngine), true);
  assert.ok(Number(writes.manuals[result.manualId].extractedTextLength || 0) > 0);
  assert.ok(writes.chunks.length > 0);
  assert.ok(Array.isArray(writes.manuals[result.manualId].extractedCodeDefinitions));
  assert.ok(Number(writes.manuals[result.manualId].extractedCodeCount || 0) >= 1);
  assert.equal(writes.codeDefinitions.some((row) => row.id === 'E10'), true);
  const chunkTexts = writes.chunks.map((entry) => entry.payload?.text || entry.text || '').join('\n');
  assert.match(chunkTexts, /E10:\s*Out of balloons/i);
});

test('resolveManualStoragePath normalizes plain path, gs url, and firebase download url while rejecting external urls', () => {
  assert.deepEqual(resolveManualStoragePath('companies/company-a/asset-manual-bootstrap/asset1/file.pdf'), {
    storagePath: 'companies/company-a/asset-manual-bootstrap/asset1/file.pdf',
    sourceKind: 'bucket_path',
    errorCode: ''
  });
  assert.deepEqual(resolveManualStoragePath('gs://bucket/companies/company-a/manuals/asset1/source.pdf'), {
    storagePath: 'companies/company-a/manuals/asset1/source.pdf',
    sourceKind: 'gs_url',
    errorCode: ''
  });
  const firebaseResolved = resolveManualStoragePath('https://firebasestorage.googleapis.com/v0/b/example/o/companies%2Fcompany-a%2Fasset-manual-bootstrap%2Fasset1%2Ffile.pdf?alt=media&token=abc');
  assert.equal(firebaseResolved.storagePath, 'companies/company-a/asset-manual-bootstrap/asset1/file.pdf');
  assert.equal(firebaseResolved.sourceKind, 'firebase_download_url');
  assert.equal(firebaseResolved.errorCode, '');
  const external = resolveManualStoragePath('https://example.com/manual.pdf');
  assert.equal(external.storagePath, '');
  assert.equal(external.errorCode, 'unsupported_external_url');
});

test('materializeStoredAssetManual classifies missing storage object without generic extraction failure', async () => {
  const storagePath = 'companies/company-a/asset-manual-bootstrap/asset1/missing.pdf';
  const result = await materializeStoredAssetManual({
    db: { collection() { throw new Error('should not write when download fails'); } },
    storage: {
      bucket() {
        return {
          file(path) {
            return {
              async download() {
                assert.equal(path, storagePath);
                const error = new Error('No such object');
                error.code = 404;
                throw error;
              }
            };
          }
        };
      }
    },
    asset: { id: 'asset1', companyId: 'company-a', name: 'Asset One' },
    storagePath,
    sourceUrl: storagePath,
  });
  assert.equal(result.ok, false);
  assert.equal(result.extractionStatus, 'storage_object_missing');
  assert.equal(result.extractionReason, 'storage_object_not_found');
});

test('materializeStoredAssetManual classifies no readable text extraction', async () => {
  const writes = { manuals: {} };
  const storagePath = 'companies/company-a/asset-manual-bootstrap/asset1/manual.pdf';
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            id,
            set: async (payload, options = {}) => {
              if (name === 'manuals') writes.manuals[id] = options.merge ? { ...(writes.manuals[id] || {}), ...payload } : payload;
            },
            collection() { return { doc() { return { set: async () => {} }; } }; }
          };
        }
      };
    },
    batch() { return { set() {}, async commit() {} }; },
    recursiveDelete: async () => {}
  };
  const storage = {
    bucket() {
      return {
        file() {
          return {
            async download() { return [Buffer.from('%PDF-1.4\n% empty-ish')]; },
            async getMetadata() { return [{ contentType: 'application/pdf', size: 20 }]; }
          };
        }
      };
    }
  };
  const result = await materializeStoredAssetManual({
    db,
    storage,
    asset: { id: 'asset1', companyId: 'company-a', name: 'Asset One' },
    storagePath,
    sourceUrl: storagePath
  });
  assert.equal(result.extractionStatus, 'no_text_extracted');
  assert.equal(result.extractionReason, 'no_readable_text_found');
  assert.equal(result.chunkCount, 0);
});

test('materializeStoredAssetManual classifies unsupported docx file type', async () => {
  const writes = { manuals: {} };
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            id,
            set: async (payload, options = {}) => {
              if (name === 'manuals') writes.manuals[id] = options.merge ? { ...(writes.manuals[id] || {}), ...payload } : payload;
            },
            collection() { return { doc() { return { set: async () => {} }; } }; }
          };
        }
      };
    },
    batch() { return { set() {}, async commit() {} }; },
    recursiveDelete: async () => {}
  };
  const storage = {
    bucket() {
      return {
        file() {
          return {
            async download() { return [Buffer.from('docx-binary')]; },
            async getMetadata() { return [{ contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 11 }]; }
          };
        }
      };
    }
  };
  const result = await materializeStoredAssetManual({
    db,
    storage,
    asset: { id: 'asset1', companyId: 'company-a', name: 'Asset One' },
    storagePath: 'companies/company-a/asset-manual-bootstrap/asset1/manual.docx',
    sourceUrl: 'companies/company-a/asset-manual-bootstrap/asset1/manual.docx'
  });
  assert.equal(result.extractionStatus, 'unsupported_file_type');
  assert.equal(result.extractionReason, 'unsupported_docx_binary');
  assert.equal(result.chunkCount, 0);
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
