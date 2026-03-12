const test = require('node:test');
const assert = require('node:assert/strict');
const { canRunManualAi, canAnswerFollowup, canSaveToTroubleshootingLibrary } = require('../src/lib/permissions');

test('permissions by role', () => {
  assert.equal(canAnswerFollowup('staff'), true);
  assert.equal(canRunManualAi('staff'), false);
  assert.equal(canRunManualAi('lead'), true);
  assert.equal(canSaveToTroubleshootingLibrary('lead'), true);
  assert.equal(canSaveToTroubleshootingLibrary('staff'), false);
});
