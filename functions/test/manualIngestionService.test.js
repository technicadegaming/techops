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
