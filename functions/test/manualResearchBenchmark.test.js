const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execFileAsync = promisify(execFile);

test('manual research benchmark runner emits reliability summary metrics', async () => {
  const script = path.resolve(__dirname, '../scripts/runManualResearchBenchmark.js');
  const { stdout } = await execFileAsync(process.execPath, [script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env },
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(typeof parsed.summary.recallAt1, 'number');
  assert.equal(typeof parsed.summary.anyUsableCandidateRate, 'number');
  assert.equal(typeof parsed.summary.autoAttachedRate, 'number');
  assert.equal(typeof parsed.summary.brochureFalsePositiveRate, 'number');
  assert.equal(typeof parsed.summary.terminalReasonDistribution, 'object');
});
