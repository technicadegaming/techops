const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getManualAttachAssetIds,
  resolveManualAttachAssetId,
  summarizeManualAttachUrl,
  resolveManualAttachAsset,
} = require('../src/lib/manualAttachCallable');

function createDb(assets = []) {
  const docs = new Map((Array.isArray(assets) ? assets : []).map((asset) => [asset.docId, asset]));
  const collection = {
    doc(docId) {
      return {
        id: docId,
        async get() {
          const record = docs.get(docId);
          return { exists: !!record, id: docId, data: () => (record ? { ...(record.data || {}) } : undefined) };
        }
      };
    },
    where(field, _op, value) {
      const filters = [{ field, value }];
      const chain = {
        where(nextField, _nextOp, nextValue) {
          filters.push({ field: nextField, value: nextValue });
          return chain;
        },
        async get() {
          const matches = Array.from(docs.values()).filter((entry) => filters.every((filter) => `${entry.data?.[filter.field] || ''}`.trim() === `${filter.value || ''}`.trim()));
          return {
            size: matches.length,
            docs: matches.map((entry) => ({ id: entry.docId, ref: { id: entry.docId }, data: () => ({ ...(entry.data || {}) }) }))
          };
        }
      };
      return chain;
    }
  };

  return { collection: () => collection };
}

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

test('resolveManualAttachAsset tries requested assetDocId doc first', async () => {
  const db = createDb([{ docId: 'asset-doc-1', data: { companyId: 'company-a', id: 'legacy-1' } }]);
  const calls = [];
  const result = await resolveManualAttachAsset({
    db,
    requestedAssetId: 'legacy-1',
    requestedAssetDocId: 'asset-doc-1',
    requestedCompanyId: 'company-a',
    uid: 'user-1',
    getUserRole: async () => 'manager',
    authorizeAssetEnrichment: async ({ assetId }) => {
      calls.push(assetId);
      if (assetId === 'asset-doc-1') return { allowed: true, scope: 'company_membership', asset: { companyId: 'company-a', id: 'legacy-1' } };
      return { allowed: false, scope: 'asset_not_found' };
    },
    authorizeCompanyMember: async () => ({ allowed: true, scope: 'company_membership' }),
    canRunAssetEnrichment: () => true,
  });

  assert.deepEqual(calls, ['asset-doc-1']);
  assert.equal(result.asset.id, 'asset-doc-1');
  assert.equal(result.resolutionSource, 'docId_assetDocId');
});

test('resolveManualAttachAsset finds exactly one legacy id match scoped to company', async () => {
  const db = createDb([{ docId: 'asset-doc-2', data: { companyId: 'company-a', id: 'legacy-2' } }]);
  const result = await resolveManualAttachAsset({
    db,
    requestedAssetId: 'legacy-2',
    requestedAssetDocId: 'missing-doc',
    requestedCompanyId: 'company-a',
    uid: 'user-1',
    getUserRole: async () => 'manager',
    authorizeAssetEnrichment: async () => ({ allowed: false, scope: 'asset_not_found' }),
    authorizeCompanyMember: async () => ({ allowed: true, scope: 'company_membership' }),
    canRunAssetEnrichment: () => true,
  });

  assert.equal(result.asset.id, 'asset-doc-2');
  assert.equal(result.resolutionSource, 'legacy_id_field');
});

test('resolveManualAttachAsset returns missing when legacy id lookup has zero matches', async () => {
  const db = createDb([]);
  const result = await resolveManualAttachAsset({
    db,
    requestedAssetId: 'legacy-3',
    requestedAssetDocId: 'missing-doc',
    requestedCompanyId: 'company-a',
    uid: 'user-1',
    getUserRole: async () => 'manager',
    authorizeAssetEnrichment: async () => ({ allowed: false, scope: 'asset_not_found' }),
    authorizeCompanyMember: async () => ({ allowed: true, scope: 'company_membership' }),
    canRunAssetEnrichment: () => true,
  });
  assert.equal(result.status, 'missing');
});

test('resolveManualAttachAsset rejects ambiguous legacy id matches', async () => {
  const db = createDb([
    { docId: 'asset-doc-a', data: { companyId: 'company-a', id: 'legacy-4' } },
    { docId: 'asset-doc-b', data: { companyId: 'company-a', id: 'legacy-4' } },
  ]);

  await assert.rejects(
    () => resolveManualAttachAsset({
      db,
      requestedAssetId: 'legacy-4',
      requestedAssetDocId: 'missing-doc',
      requestedCompanyId: 'company-a',
      uid: 'user-1',
      getUserRole: async () => 'manager',
      authorizeAssetEnrichment: async () => ({ allowed: false, scope: 'asset_not_found' }),
      authorizeCompanyMember: async () => ({ allowed: true, scope: 'company_membership' }),
      canRunAssetEnrichment: () => true,
    }),
    (error) => error?.code === 'failed-precondition'
  );
});

test('resolveManualAttachAsset rejects company mismatch', async () => {
  const db = createDb([{ docId: 'asset-doc-5', data: { companyId: 'company-b', id: 'legacy-5' } }]);
  await assert.rejects(
    () => resolveManualAttachAsset({
      db,
      requestedAssetId: 'legacy-5',
      requestedAssetDocId: 'asset-doc-5',
      requestedCompanyId: 'company-a',
      uid: 'user-1',
      getUserRole: async () => 'manager',
      authorizeAssetEnrichment: async () => ({ allowed: true, scope: 'company_membership', asset: { companyId: 'company-b', id: 'legacy-5' } }),
      authorizeCompanyMember: async () => ({ allowed: true, scope: 'company_membership' }),
      canRunAssetEnrichment: () => true,
    }),
    (error) => error?.code === 'permission-denied'
  );
});
