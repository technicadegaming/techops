const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveManualAttachAssetId, summarizeManualAttachUrl } = require('../src/lib/manualAttachCallable');

test('resolveManualAttachAssetId prefers assetId and falls back to assetDocId alias', () => {
  assert.equal(resolveManualAttachAssetId({ assetId: 'asset-primary', assetDocId: 'asset-alias' }), 'asset-primary');
  assert.equal(resolveManualAttachAssetId({ assetDocId: 'asset-alias' }), 'asset-alias');
  assert.equal(resolveManualAttachAssetId({ assetId: '   ', assetDocId: 'asset-alias' }), 'asset-alias');
});

test('summarizeManualAttachUrl avoids logging full URL tokens', () => {
  const summary = summarizeManualAttachUrl('https://example.com/manuals/file.pdf?token=secret');
  assert.equal(summary.host, 'example.com');
  assert.equal(summary.pathLength, '/manuals/file.pdf'.length);
});
