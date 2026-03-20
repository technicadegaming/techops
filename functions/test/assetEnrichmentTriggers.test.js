const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAssetEnrichmentTriggerSource } = require('../src/lib/assetEnrichmentTriggers');

test('normalizeAssetEnrichmentTriggerSource aliases legacy bulk/admin callers onto manual pipeline', () => {
  assert.equal(normalizeAssetEnrichmentTriggerSource('manual'), 'manual');
  assert.equal(normalizeAssetEnrichmentTriggerSource('bulk_admin_review'), 'manual');
  assert.equal(normalizeAssetEnrichmentTriggerSource('onboarding_asset_step'), 'manual');
  assert.equal(normalizeAssetEnrichmentTriggerSource(''), 'manual');
  assert.equal(normalizeAssetEnrichmentTriggerSource('unexpected_new_value'), 'manual');
});
