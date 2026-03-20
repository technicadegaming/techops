const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeStructuredTask, buildAssetHistoryCloseout, detectRepeatIssues, parseDeepLink } = require('../src/lib/workflow');

test('structured task normalization builds fallback description', () => {
  const row = normalizeStructuredTask({
    id: 't-1',
    title: 'Flipper issue',
    assetId: 'asset-22',
    issueCategory: 'controls',
    symptomTagsText: 'left flipper, intermittent',
    assignedWorkers: 'u1, u2, u1'
  }, { defaultTaskSeverity: 'high' });
  assert.equal(row.severity, 'high');
  assert.equal(row.symptomTags.length, 2);
  assert.equal(row.assignedWorkers.length, 2);
  assert.match(row.description, /asset-22/);
});

test('closeout history entry shape', () => {
  const evt = buildAssetHistoryCloseout('task-9', { rootCause: 'Fuse', fixPerformed: 'Replaced fuse', timeSpentMinutes: '18' });
  assert.equal(evt.type, 'task_closeout');
  assert.equal(evt.timeSpentMinutes, 18);
});

test('repeat issue detection helper', () => {
  const rows = detectRepeatIssues([
    { assetId: 'a1', issueCategory: 'sensor', symptomTags: ['coin'] },
    { assetId: 'a1', issueCategory: 'sensor', symptomTags: ['coin'] },
    { assetId: 'a2', issueCategory: 'display', symptomTags: ['flicker'] }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assetId, 'a1');
});


test('deep-link selection parsing', () => {
  const route = parseDeepLink('https://portal.scootbusiness.com/?tab=operations&taskId=t7');
  assert.equal(route.tab, 'operations');
  assert.equal(route.taskId, 't7');
});
