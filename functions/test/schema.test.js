const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAiResultShape, sanitizeFollowupAnswers } = require('../src/lib/validators');

test('validate AI response schema', () => {
  const parsed = validateAiResultShape({
    conciseIssueSummary: 'Issue',
    probableCauses: ['A'],
    immediateChecks: ['B'],
    diagnosticSteps: ['C'],
    recommendedFixes: ['D'],
    toolsNeeded: ['E'],
    partsPossiblyNeeded: ['F'],
    safetyNotes: ['G'],
    escalationSignals: ['H'],
    confidence: 1.5,
    shortFrontlineVersion: 'Short',
    detailedManagerVersion: 'Long',
    citations: ['manual x']
  });
  assert.equal(parsed.confidence, 1);
});

test('sanitize followup answers', () => {
  const answers = sanitizeFollowupAnswers([
    { question: 'Q1', answer: 'A1' },
    { question: '  ', answer: 'A2' },
    { nope: true }
  ]);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].question, 'Q1');
});
