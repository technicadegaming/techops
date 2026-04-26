const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('manual attach callables use assetDocId alias and clearer not-found/company mismatch messaging', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.match(source, /resolveManualAttachAssetId\(request\.data \|\| \{\}\)/);
  assert.match(source, /Asset not found for manual attachment\. Refresh the asset list and try again\./);
  assert.match(source, /Asset\/company mismatch for manual attachment\./);
});
