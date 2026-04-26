const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('manual attach callables use resolver with legacy id fallback and safe error messaging', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  const callableSource = fs.readFileSync(path.join(__dirname, '../src/lib/manualAttachCallable.js'), 'utf8');
  assert.match(indexSource, /resolveManualAttachAsset\(\{/);
  assert.match(indexSource, /requestedAssetDocId: requestedIds\.assetDocId/);
  assert.match(indexSource, /Asset not found for manual attachment\. Refresh the asset list and try again\./);
  assert.match(callableSource, /Multiple asset records matched this legacy id\. Open the asset record and try again\./);
  assert.match(indexSource, /Asset\/company mismatch for manual attachment\./);
});
