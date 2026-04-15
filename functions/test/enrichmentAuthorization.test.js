const test = require('node:test');
const assert = require('node:assert/strict');
const { hasCompanyEnrichmentRole, isGlobalAdminRole } = require('../src/lib/enrichmentAuthorization');

test('company enrichment roles include owner/admin/manager only', () => {
  assert.equal(hasCompanyEnrichmentRole('owner'), true);
  assert.equal(hasCompanyEnrichmentRole('admin'), true);
  assert.equal(hasCompanyEnrichmentRole('manager'), true);
  assert.equal(hasCompanyEnrichmentRole('staff'), false);
});

test('global admin role normalizes owner/admin behavior correctly', () => {
  assert.equal(isGlobalAdminRole('admin'), true);
  assert.equal(isGlobalAdminRole('owner'), true);
  assert.equal(isGlobalAdminRole('manager'), false);
});
const firestoreIndexes = require('../../firestore.indexes.json');
const { getMembershipLookupIndexFields } = require('../src/lib/enrichmentAuthorization');

test('company membership fallback lookup index is defined for companyId/userId/status', () => {
  const expectedFields = [
    { fieldPath: 'companyId', order: 'ASCENDING' },
    { fieldPath: 'userId', order: 'ASCENDING' },
    { fieldPath: 'status', order: 'ASCENDING' },
    { fieldPath: '__name__', order: 'ASCENDING' },
  ];
  assert.deepEqual(getMembershipLookupIndexFields(), ['companyId', 'userId', 'status']);
  assert.equal(
    firestoreIndexes.indexes.some((index) => index.collectionGroup === 'companyMemberships'
      && index.queryScope === 'COLLECTION'
      && JSON.stringify(index.fields) === JSON.stringify(expectedFields)),
    true,
  );
});
