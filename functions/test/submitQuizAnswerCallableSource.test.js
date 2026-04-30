const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');

test('submitQuizAnswer callable is exported with duplicate prevention and generic pin errors', () => {
  assert.match(source, /exports\.submitQuizAnswer = onCall/);
  assert.match(source, /duplicateKey = `\$\{companyId\}_\$\{locationId\}_\$\{workerId\}_\$\{questionId\}_\$\{businessDate\}`/);
  assert.match(source, /PIN could not be verified\./);
  assert.match(source, /already-exists', 'Quiz answer already submitted for this business date\./);
});

test('submitQuizAnswer does not store raw PIN and writes audit + submission docs', () => {
  assert.match(source, /txn\.set\(auditRef/);
  assert.match(source, /txn\.set\(submissionRef/);
  const callableSource = source.slice(source.indexOf('exports.submitQuizAnswer'), source.indexOf('exports.analyzeTaskTroubleshooting'));
  assert.doesNotMatch(callableSource, /pin:\s*pin/);
});
