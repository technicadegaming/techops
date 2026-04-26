const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('manual attach callables use resolver with legacy id fallback and safe error messaging', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  const callableSource = fs.readFileSync(path.join(__dirname, '../src/lib/manualAttachCallable.js'), 'utf8');
  assert.match(indexSource, /resolveManualAttachAsset\(\{/);
  assert.match(indexSource, /requestedAssetDocId,\s+requestedCompanyId,/);
  assert.match(indexSource, /Manual URL is required for manual attachment\./);
  assert.match(indexSource, /Manual file upload did not produce a storage path\./);
  assert.match(indexSource, /Asset not found for manual attachment\. Refresh the asset list and try again\./);
  assert.match(indexSource, /Asset resolved but missing company context for manual attachment\./);
  assert.match(indexSource, /Manual attachment failed unexpectedly\. Check function logs for details\./);
  assert.match(indexSource, /if \(error instanceof HttpsError\) throw error;/);
  assert.match(indexSource, /docId: resolution\?\.assetDocId \|\| ''/);
  assert.match(indexSource, /assetRecordId: resolution\?\.assetDocId \|\| ''/);
  assert.match(callableSource, /Multiple asset records matched this legacy id\. Open the asset record and try again\./);
  assert.match(callableSource, /id: docId,\s+firestoreDocId: docId/);
  assert.match(indexSource, /Asset\/company mismatch for manual attachment\./);
  assert.doesNotMatch(indexSource, /Missing required inputs for manual attachment\./);
});
