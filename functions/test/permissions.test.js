const test = require('node:test');
const assert = require('node:assert/strict');
const { canRunAssetEnrichment, canRunManualAi, canAnswerFollowup, canSaveToTroubleshootingLibrary } = require('../src/lib/permissions');

test('permissions by role', () => {
  assert.equal(canAnswerFollowup('staff'), true);
  assert.equal(canRunAssetEnrichment('owner'), true);
  assert.equal(canRunAssetEnrichment('manager'), true);
  assert.equal(canRunAssetEnrichment('lead'), false);
  assert.equal(canRunAssetEnrichment('staff'), false);
  assert.equal(canRunManualAi('staff'), false);
  assert.equal(canRunManualAi('lead'), true);
  assert.equal(canSaveToTroubleshootingLibrary('lead'), true);
  assert.equal(canSaveToTroubleshootingLibrary('staff'), false);
});
