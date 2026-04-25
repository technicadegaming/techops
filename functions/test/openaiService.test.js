const test = require('node:test');
const assert = require('node:assert/strict');

function loadServiceWithMockedOpenAI(createImpl) {
  const openaiPath = require.resolve('openai');
  const servicePath = require.resolve('../src/services/openaiService');
  const originalOpenAiModule = require.cache[openaiPath];

  class FakeOpenAI {
    constructor() {
      this.responses = {
        create: createImpl
      };
    }
  }

  require.cache[openaiPath] = {
    id: openaiPath,
    filename: openaiPath,
    loaded: true,
    exports: FakeOpenAI
  };
  delete require.cache[servicePath];

  const service = require('../src/services/openaiService');
  return {
    service,
    restore() {
      delete require.cache[servicePath];
      if (originalOpenAiModule) require.cache[openaiPath] = originalOpenAiModule;
      else delete require.cache[openaiPath];
    }
  };
}

test('requestTroubleshootingPlan uses structured json_schema output', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  let createArgs;
  const fixture = {
    conciseIssueSummary: 'Ticket jam near sensor',
    probableCauses: ['Sensor blockage'],
    immediateChecks: ['Inspect sensor'],
    diagnosticSteps: ['Clear obstruction'],
    recommendedFixes: ['Re-seat sensor cable'],
    toolsNeeded: ['Phillips screwdriver'],
    partsPossiblyNeeded: ['Sensor board'],
    safetyNotes: ['Power down before opening panel'],
    escalationSignals: ['No sensor signal after reset'],
    confidence: 0.8,
    shortFrontlineVersion: 'Clear ticket path and reset sensor.',
    detailedManagerVersion: 'Likely sensor blockage with harness drift.',
    citations: ['Provided task history']
  };
  const { service, restore } = loadServiceWithMockedOpenAI(async (args) => {
    createArgs = args;
    return { id: 'resp_123', model: 'gpt-test', output_parsed: fixture };
  });

  try {
    const result = await service.requestTroubleshootingPlan({
      model: 'gpt-test',
      traceId: 'trace-1',
      settings: { aiShortResponseMode: false, aiVerboseManagerMode: false },
      context: { task: { description: 'game down' } }
    });
    assert.equal(createArgs.text.format.type, 'json_schema');
    assert.equal(createArgs.text.format.name, 'task_troubleshooting_plan');
    assert.equal(createArgs.text.format.strict, true);
    assert.equal(result.responseMeta.responseId, 'resp_123');
    assert.equal(result.parsed.conciseIssueSummary, fixture.conciseIssueSummary);
  } finally {
    restore();
  }
});

test('requestTroubleshootingPlan maps JSON parse failures to stable failureCode', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  const { service, restore } = loadServiceWithMockedOpenAI(async () => ({
    id: 'resp_bad_json',
    model: 'gpt-test',
    output_text: '{"broken":'
  }));
  try {
    await assert.rejects(
      () => service.requestTroubleshootingPlan({
        model: 'gpt-test',
        traceId: 'trace-2',
        settings: { aiShortResponseMode: false, aiVerboseManagerMode: false },
        context: { task: { description: 'broken' } }
      }),
      (error) => {
        assert.equal(error.code, 'ai_json_parse_failed');
        assert.match(error.message, /invalid/i);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('requestTroubleshootingPlan maps validation failures to stable failureCode', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  const { service, restore } = loadServiceWithMockedOpenAI(async () => ({
    id: 'resp_bad_shape',
    model: 'gpt-test',
    output_parsed: { conciseIssueSummary: 'Incomplete payload' }
  }));
  try {
    await assert.rejects(
      () => service.requestTroubleshootingPlan({
        model: 'gpt-test',
        traceId: 'trace-3',
        settings: { aiShortResponseMode: false, aiVerboseManagerMode: false },
        context: { task: { description: 'broken' } }
      }),
      (error) => {
        assert.equal(error.code, 'ai_result_validation_failed');
        assert.match(error.message, /validation/i);
        return true;
      }
    );
  } finally {
    restore();
  }
});

