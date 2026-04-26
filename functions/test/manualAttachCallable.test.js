const test = require('node:test');
const assert = require('node:assert/strict');

const { getManualAttachAssetIds, resolveManualAttachAssetId, summarizeManualAttachUrl } = require('../src/lib/manualAttachCallable');

test('manual attach ids preserve assetDocId and assetId separately', () => {
  assert.deepEqual(getManualAttachAssetIds({ assetId: 'asset-primary', assetDocId: 'asset-doc' }), { assetId: 'asset-primary', assetDocId: 'asset-doc' });
});

test('resolveManualAttachAssetId prefers assetDocId and falls back to assetId alias', () => {
  assert.equal(resolveManualAttachAssetId({ assetId: 'asset-primary', assetDocId: 'asset-doc' }), 'asset-doc');
  assert.equal(resolveManualAttachAssetId({ assetDocId: 'asset-alias' }), 'asset-alias');
  assert.equal(resolveManualAttachAssetId({ assetId: 'asset-primary' }), 'asset-primary');
});

test('summarizeManualAttachUrl avoids logging full URL tokens', () => {
  const summary = summarizeManualAttachUrl('https://example.com/manuals/file.pdf?token=secret');
  assert.equal(summary.host, 'example.com');
  assert.equal(summary.pathLength, '/manuals/file.pdf'.length);
});
