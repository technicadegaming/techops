const OpenAI = require('openai');
const { defineSecret } = require('firebase-functions/params');
const { validateAiResultShape, validateAssetLookupResultShape } = require('../lib/validators');

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

function getClient() {
  const apiKey = OPENAI_API_KEY.value();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAI({ apiKey });
}

function buildSystemInstructions(settings) {
  return [
    'You are an arcade operations troubleshooting assistant.',
    'Prioritize practical diagnostics and operational safety.',
    'Do not invent manuals, part numbers, or procedures.',
    'If confidence is low or data is incomplete, state this clearly.',
    'Respond in strict JSON only matching the provided schema.',
    settings.aiShortResponseMode ? 'Short frontline summaries should be compact.' : '',
    settings.aiVerboseManagerMode ? 'Detailed manager summaries can be verbose and include reasoning.' : ''
  ].filter(Boolean).join('\n');
}

function buildSchemaPrompt() {
  return JSON.stringify({
    conciseIssueSummary: 'string',
    probableCauses: ['string ranked most likely first'],
    immediateChecks: ['string'],
    diagnosticSteps: ['string'],
    recommendedFixes: ['string'],
    toolsNeeded: ['string'],
    partsPossiblyNeeded: ['string'],
    safetyNotes: ['string'],
    escalationSignals: ['string'],
    confidence: 0.0,
    shortFrontlineVersion: 'string',
    detailedManagerVersion: 'string',
    citations: ['string']
  });
}

function buildAssetLookupInstructions() {
  return [
    'You identify arcade/FEC equipment and return pre-save documentation/support lookup suggestions.',
    'Focus on exact equipment identification (cabinet, model, revision/version) and documentation/support lookup, not troubleshooting.',
    'Use the provided asset fields as the source context: name, manufacturer, serial, and asset ID.',
    'If followupAnswer is provided, treat it as high-signal disambiguation context for title/version/manufacturer matching.',
    'Prioritize official manufacturer docs/support/contact/parts pages first.',
    'Use distributor or manual-library links only when relevant and useful.',
    'Avoid generic homepages unless that is the best official support entry point.',
    'Provide one short actionable follow-up question only if needed to disambiguate the exact model/version.',
    'Bias search intent toward arcade game manual, operator manual, service manual, parts manual, and manufacturer documentation.',
    'Return strict JSON only; do not include markdown or explanatory prose.',
    'Never fabricate manuals, contact details, or URLs. Omit uncertain data.'
  ].join('\n');
}

function buildAssetLookupSchemaPrompt() {
  return JSON.stringify({
    normalizedName: 'string',
    likelyManufacturer: 'string',
    likelyCategory: 'string',
    confidence: 0.0,
    oneFollowupQuestion: 'string or empty string',
    documentationLinks: [
      {
        title: 'string',
        url: 'https://...',
        sourceType: 'manufacturer|manual_library|distributor|other'
      }
    ],
    supportResources: [
      {
        label: 'string',
        url: 'https://...',
        resourceType: 'official_site|support|parts|contact|distributor|manual_library|other'
      }
    ],
    supportContacts: [
      {
        label: 'string',
        value: 'string',
        contactType: 'phone|email|form|other'
      }
    ],
    alternateNames: ['string'],
    searchHints: ['string'],
    topMatchReason: 'string'
  });
}

async function requestFollowupQuestions({ model, traceId, context }) {
  const client = getClient();
  const prompt = `Determine if follow-up questions are needed. Return JSON: {"needsFollowup":boolean, "questions": string[]} with 2-5 concise practical questions max. Context: ${JSON.stringify(context)}`;
  const response = await client.responses.create({
    model,
    metadata: { traceId, flow: 'followup-detection' },
    input: [{ role: 'system', content: 'Return strict JSON.' }, { role: 'user', content: prompt }]
  });
  const text = response.output_text || '{}';
  const parsed = JSON.parse(text);
  return {
    needsFollowup: !!parsed.needsFollowup,
    questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 5).map((q) => String(q).trim()).filter(Boolean) : [],
    responseId: response.id
  };
}

async function requestTroubleshootingPlan({ model, traceId, settings, context }) {
  const client = getClient();
  const response = await client.responses.create({
    model,
    metadata: { traceId, flow: 'task-troubleshooting' },
    input: [
      { role: 'system', content: buildSystemInstructions(settings) },
      { role: 'developer', content: `Output strict JSON schema: ${buildSchemaPrompt()}` },
      { role: 'user', content: `Use this structured context: ${JSON.stringify(context)}` }
    ]
  });
  const parsed = validateAiResultShape(JSON.parse(response.output_text || '{}'));
  return {
    parsed,
    responseMeta: { responseId: response.id, model: response.model }
  };
}

async function requestAssetDocumentationLookup({ model, traceId, context }) {
  const client = getClient();
  const response = await client.responses.create({
    model,
    metadata: { traceId, flow: 'asset-documentation-lookup' },
    input: [
      { role: 'system', content: buildAssetLookupInstructions() },
      { role: 'developer', content: `Output strict JSON schema: ${buildAssetLookupSchemaPrompt()}` },
      { role: 'user', content: `Use this structured lookup context: ${JSON.stringify(context)}` }
    ]
  });

  const parsed = validateAssetLookupResultShape(JSON.parse(response.output_text || '{}'));
  return {
    parsed,
    responseMeta: { responseId: response.id, model: response.model }
  };
}

module.exports = {
  OPENAI_API_KEY,
  requestFollowupQuestions,
  requestTroubleshootingPlan,
  requestAssetDocumentationLookup
};
