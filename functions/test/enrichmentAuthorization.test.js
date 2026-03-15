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
