const test = require('node:test');
const assert = require('node:assert/strict');
const { toMillis } = require('../src/lib/rateLimit');

test('toMillis handles Timestamp-like, ISO string, Date, numeric, and invalid values', () => {
  assert.equal(toMillis({ toMillis: () => 1700000000123 }), 1700000000123);
  assert.equal(toMillis('2026-04-20T12:34:56.000Z'), Date.parse('2026-04-20T12:34:56.000Z'));
  assert.equal(toMillis(new Date('2026-04-20T12:34:56.000Z')), Date.parse('2026-04-20T12:34:56.000Z'));
  assert.equal(toMillis(1700000000456), 1700000000456);
  assert.equal(toMillis('not-a-date'), 0);
  assert.equal(toMillis(null), 0);
});
