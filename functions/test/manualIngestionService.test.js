const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');

const {
  buildManualStoragePath,
  chunkManualText,
  extractPdfText,
  extractTextFromBuffer,
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
  const writes = { manuals: {}, assets: {}, auditLogs: [], chunks: [] };
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/pdf' },
    arrayBuffer: async () => Buffer.from('%PDF-1.4\n')
  });
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
              writes[name][id] = options.merge ? { ...(writes[name][id] || {}), ...payload } : payload;
            },
            collection() {
              return { doc(chunkId) { return { id: chunkId }; } };
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
  const storage = { bucket() { return { file() { return { save: async () => {} }; } }; } };
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
  const manual = Object.values(writes.manuals)[0];
  assert.equal(manual.manualType, 'operator_manual');
  assert.equal(manual.cabinetVariant, '2 player');
  assert.equal(manual.family, 'Fast and Furious Arcade');
  assert.equal(manual.manufacturer, 'Raw Thrills');
  assert.equal(manual.manualConfidence, 0.88);
  assert.equal(manual.assetLocationName, 'Front Room');
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
