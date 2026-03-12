const test = require('node:test');
const assert = require('node:assert/strict');
const { isWeakTaskDescription } = require('../src/lib/followup');

test('weak description detection', () => {
  assert.equal(isWeakTaskDescription({ title: 'help', notes: '' }), true);
  assert.equal(isWeakTaskDescription({ title: 'Pinball table left flipper sticks after 20 minutes', notes: 'intermittent with heat' }), false);
});
