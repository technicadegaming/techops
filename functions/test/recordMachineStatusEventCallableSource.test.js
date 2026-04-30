const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');

test('recordMachineStatusEvent callable is exported and updates status history + asset', () => {
  assert.match(source, /exports\.recordMachineStatusEvent = onCall/);
  assert.match(source, /db\.collection\('machineStatusEvents'\)\.doc\(\)/);
  assert.match(source, /await assetRef\.set\(\{ status: nextStatus/);
  assert.match(source, /db\.collection\('auditLogs'\)\.add\(/);
});
