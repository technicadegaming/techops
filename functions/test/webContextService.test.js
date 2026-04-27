const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWebContextForTask, buildTargetedQueries, extractCodeDefinitionFromSource } = require('../src/services/webContextService');

function buildDb() {
  const cache = new Map();
  return {
    collection(name) {
      assert.equal(name, 'aiWebContextCache');
      return {
        doc(id) {
          return {
            async get() {
              const row = cache.get(id);
              return { exists: !!row, data: () => row };
            },
            async set(payload) {
              cache.set(id, { ...(cache.get(id) || {}), ...payload });
            }
          };
        }
      };
    }
  };
}

test('buildTargetedQueries builds operations-style targeted code lookups', () => {
  const queries = buildTargetedQueries({ asset: { name: 'Arcade Deluxe', manufacturer: 'Scoot' }, task: {}, codeTokens: ['E11'] });
  assert.deepEqual(queries, [
    'Arcade Deluxe Scoot E11 manual',
    'Arcade Deluxe error 11',
    'Arcade Deluxe card dispenser error'
  ]);
});

test('extractCodeDefinitionFromSource detects code meaning snippets', () => {
  const match = extractCodeDefinitionFromSource({ title: 'Manual', snippet: 'ERROR 11 = CARD DISPENSER ERROR and sensor path blocked.' }, ['E11']);
  assert.equal(match.code, 'E11');
  assert.match(match.meaning, /CARD DISPENSER ERROR/i);
});

test('fetchWebContextForTask reports not configured provider when enabled without search implementation', async () => {
  const result = await fetchWebContextForTask({
    db: buildDb(),
    taskId: 'task-1',
    settings: { aiUseWebSearch: true },
    traceId: 'trace-1',
    task: { assetName: 'Arcade Deluxe' },
    asset: { name: 'Arcade Deluxe' },
    taskTokens: { codeTokens: ['E11'] }
  });
  assert.equal(result.configured, false);
  assert.match(result.summary, /not configured/i);
});

test('fetchWebContextForTask captures web_code_definition candidates from search results', async () => {
  const result = await fetchWebContextForTask({
    db: buildDb(),
    taskId: 'task-2',
    settings: { aiUseWebSearch: true },
    traceId: 'trace-2',
    task: { assetName: 'Arcade Deluxe' },
    asset: { name: 'Arcade Deluxe', manufacturer: 'Scoot' },
    taskTokens: { codeTokens: ['E11'] },
    searchWeb: async () => ({
      summary: 'Found one official support reference.',
      sources: [{ title: 'Manufacturer support', url: 'https://example.com/manual', snippet: 'ERROR 11: CARD DISPENSER ERROR. Press reset after repair.' }]
    })
  });
  assert.equal(result.configured, true);
  assert.equal(result.sources.length, 1);
  assert.equal(result.codeDefinitions.length, 1);
  assert.equal(result.codeDefinitions[0].sourceType, 'web_code_definition');
  assert.match(result.codeDefinitions[0].excerpt, /CARD DISPENSER ERROR/i);
});
