const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAiResultShape, sanitizeFollowupAnswers, validateAssetLookupResultShape } = require('../src/lib/validators');

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


test('validate asset lookup schema backward compatible', () => {
  const parsed = validateAssetLookupResultShape({
    normalizedName: 'Fast & Furious',
    likelyManufacturer: 'Raw Thrills',
    likelyCategory: 'video',
    confidence: 0.6,
    documentationLinks: [{ title: 'Manual', url: 'https://rawthrills.com/manual.pdf', sourceType: 'manufacturer' }]
  });
  assert.equal(parsed.supportResources.length, 0);
  assert.equal(parsed.supportContacts.length, 0);
});

test('validate asset lookup schema with preview fields and malformed urls filtered', () => {
  const parsed = validateAssetLookupResultShape({
    normalizedName: 'Monopoly Roll N Go',
    likelyManufacturer: 'Bay Tek',
    likelyCategory: 'redemption',
    confidence: 0.33,
    oneFollowupQuestion: 'Is it Deluxe?',
    documentationLinks: [{ title: 'bad', url: 'notaurl', sourceType: 'other' }, { title: 'ok', url: 'https://baytekent.com/manuals/monopoly', sourceType: 'manufacturer' }],
    supportResources: [{ label: 'Support', url: 'https://baytekent.com/support', resourceType: 'support' }, { label: 'bad', url: 'not-a-url' }],
    supportContacts: [{ label: 'Main', value: 'support@baytekent.com', contactType: 'email' }, { label: 'Empty', value: '' }],
    alternateNames: ['Monopoly Roll-N-Go', '   '],
    searchHints: ['bay tek redemption manual', ''],
    topMatchReason: 'Manufacturer + model token overlap'
  });
  assert.equal(parsed.documentationLinks.length, 1);
  assert.equal(parsed.supportResources.length, 1);
  assert.equal(parsed.supportContacts.length, 1);
  assert.equal(parsed.alternateNames.length, 1);
  assert.equal(parsed.searchHints.length, 1);
});
