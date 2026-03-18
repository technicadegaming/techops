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
    'You are an arcade/FEC operations troubleshooting assistant for redemption, crane/prize, video arcade, pinball, kiosk, VR, air hockey, jukebox, photo booth, and related equipment.',
    'Use user-provided facts and stored asset/task context as highest-priority evidence.',
    'If supplied context includes manual links, documentationSuggestions, supportResourcesSuggestion, manufacturerSuggestion, prior issues, or follow-up answers, treat them as context signals only; do not claim external verification unless explicitly present in the supplied context.',
    'If supplied context includes approved manual text excerpts/chunks, you may use that text as provided internal evidence and should cite it as supplied manual context rather than as live web verification.',
    'Prefer asset-specific reasoning over generic advice.',
    'Clearly separate observed symptoms, probable causes, checks to perform, recommended fixes, and escalation conditions.',
    'Prioritize safest and least-invasive checks first.',
    'Consider practical arcade/FEC failure buckets when relevant: power/basic state, interlocks/doors, jams/obstructions, sensors/switches, harness/connectors, settings/menu config, ticket/prize feed, coin/card/reader, network/comms, mechanical wear, display/input/calibration.',
    'Do not invent manuals, procedures, measurements, part numbers, or vendor statements.',
    'If exact model identification is uncertain, reduce confidence and use cautious wording.',
    'Keep frontline output concise and actionable.',
    'Keep manager output reasoning-rich but not verbose.',
    'Citations must reference supplied context only unless external evidence is explicitly supplied in context.',
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
    'Focus on exact cabinet/model/version/series identification and documentation/support lookup, not troubleshooting.',
    'Treat asset name, manufacturer, serial number, asset ID, followupAnswer, and obvious title/model clues as primary evidence.',
    'Normalize noisy names into the most likely canonical market-facing title.',
    'Prefer exact equipment matches over loose thematic matches.',
    'Use categories carefully: redemption, crane/prize, video arcade, pinball, air hockey, jukebox, photo booth, kiosk, VR, or other.',
    'Use manufacturer ecosystems, cabinet variants, subtitle/version text, sequel numbering, and product family clues.',
    'Treat followupAnswer as high-signal disambiguation input.',
    'Serial number and asset ID can support identification, but are not authoritative unless clearly meaningful.',
    'Search explicitly as if the query were: "arcade manual for [exact title] by [exact manufacturer]".',
    'Also search explicitly for: "operator manual for [exact title] by [exact manufacturer]", "service manual for [exact title] by [exact manufacturer]", "parts manual for [exact title] by [exact manufacturer]", and "install manual for [exact title] by [exact manufacturer]".',
    'Prioritize exact title + exact manufacturer operator/service/install/parts manuals first.',
    'Prefer exact title PDF/manual download pages and exact title official support/product pages over generic manufacturer hubs.',
    'Require exact title evidence before suggesting a manual link; if the page does not clearly reference the exact title, omit it.',
    'Require exact manufacturer or known manufacturer alias match before suggesting a manual; if manufacturer alignment is weak, omit it.',
    'Trusted manual libraries and reputable distributors are secondary sources only when exact-title and manufacturer-matched official sources are unavailable or incomplete.',
    'Manufacturer-specific parts/support domains are preferred over generic manufacturer homepages and over distributors/manual hubs when they clearly match the exact machine.',
    'Strongly demote generic homepages/manual hubs/distributor listings unless they explicitly reference the exact title and exact manufacturer.',
    'Treat distributor pages such as Betson as weak evidence unless they clearly represent the exact machine manual or exact machine support document.',
    'Never fabricate URLs, contacts, document titles, manufacturers, source types, or confidence.',
    'Omit weak links instead of guessing.',
    'If identity is ambiguous, ask exactly one high-value follow-up question for exact-title disambiguation (exact nameplate text, subtitle/version under the logo, exact model text near monitor/marquee, or whether the suggested title is correct).',
    'Do not ask the user to provide a manual URL.',
    'Confidence must reflect identification certainty, not model familiarity.',
    'Keep documentationLinks and supportResources focused on exact-title matches; do not pad with generic manufacturer pages.',
    'supportContacts are optional; include only clearly trustworthy contact paths.',
    'Return strict JSON only; do not include markdown or explanatory prose.',
    'Return JSON that matches the schema exactly.'
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
