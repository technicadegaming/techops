const OpenAI = require('openai');
const { defineSecret } = require('firebase-functions/params');
const {
  validateAiResultShape,
  validateAssetLookupResultShape,
  validateManualResearchResultShape,
} = require('../lib/validators');

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

function resolveApiKey(override = '') {
  const normalizedOverride = `${override || ''}`.trim();
  if (normalizedOverride) return { apiKey: normalizedOverride, source: 'override' };
  const secretValue = `${OPENAI_API_KEY.value() || ''}`.trim();
  if (secretValue) return { apiKey: secretValue, source: 'firebase_secret' };
  const envValue = `${process.env.OPENAI_API_KEY || ''}`.trim();
  if (envValue) return { apiKey: envValue, source: 'process_env' };
  return { apiKey: '', source: 'missing' };
}

function getClient({ apiKeyOverride = '' } = {}) {
  const { apiKey } = resolveApiKey(apiKeyOverride);
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY is not configured');
    error.code = 'openai-config-missing';
    throw error;
  }
  return new OpenAI({ apiKey });
}

function buildSystemInstructions(settings) {
  return [
    'You are an arcade/FEC operations troubleshooting assistant for redemption, crane/prize, video arcade, pinball, kiosk, VR, air hockey, jukebox, photo booth, and related equipment.',
    'Use user-provided facts and stored asset/task context as highest-priority evidence.',
    'If supplied context includes manual links, documentationSuggestions, supportResourcesSuggestion, manufacturerSuggestion, prior issues, or follow-up answers, treat them as context signals only; do not claim external verification unless explicitly present in the supplied context.',
    'If supplied context includes approved manual text excerpts/chunks, you may use that text as provided internal evidence and should cite it as supplied manual context rather than as live web verification.',
    'If supplied context includes approved_manual_code_definition for the observed task code, state that code definition in the first sentence.',
    'When approved_manual_code_definition includes reset instructions, include that reset step after the corrective action.',
    'Do not claim "meaning not provided" when approved_manual_code_definition exists.',
    'If multiple approved manual code definitions conflict for the same code, explicitly call out the conflict and ask the user to verify the cabinet/manual variant before proceeding.',
    'If supplied context includes asset_code_hint or known code mappings, treat them as high-priority internal evidence for that asset only.',
    'If an observed task code/error matches supplied code hints or manual chunks, state the mapping early in the frontline summary and immediate checks.',
    'If supplied context defines the code mapping, do not claim "no code definition in provided context".',
    'Do not invent code/error meanings when no supplied context provides the mapping.',
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

function buildGroundingDirective(context = {}) {
  const codeTokens = Array.isArray(context?.taskTokens?.codeTokens) ? context.taskTokens.codeTokens : [];
  if (!codeTokens.length) return '';
  const sources = Array.isArray(context?.documentationContext?.items) ? context.documentationContext.items : [];
  const manualDefinition = sources.find((item) => item?.sourceType === 'approved_manual_code_definition');
  const webDefinition = sources.find((item) => item?.sourceType === 'web_code_definition');
  if (manualDefinition?.excerpts?.[0]) {
    return `Grounding rule: first sentence must state this approved manual code definition for ${codeTokens.join(', ')}: ${manualDefinition.excerpts[0]}`;
  }
  if (webDefinition?.excerpts?.[0]) {
    return `Grounding rule: first sentence must state this web/manual code definition for ${codeTokens.join(', ')} and label it as web/manual source: ${webDefinition.excerpts[0]}`;
  }
  return `Grounding rule: code token(s) ${codeTokens.join(', ')} found but no definition evidence available. First sentence must say definition was not found and ask for manual attach/re-extraction or web research.`;
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
    'Use literal manufacturer-first search patterns such as: "[exact manufacturer]" "[exact title]" "service manual" pdf and "[exact manufacturer]" "[exact title]" "operator manual" pdf.',
    'For known manufacturers, exhaust official-domain-first searches before broader web results, including patterns like: site:[preferred official domain] "[exact title]" ("service manual" OR "operator manual" OR manual) (pdf OR download).',
    'Known official-domain priorities include Bay Tek -> parts.baytekent.com first, then baytekent.com; ICE -> support.icegame.com first, then icegame.com; Raw Thrills -> rawthrills.com.',
    'Prioritize exact title + exact manufacturer operator/service/install/parts manuals first.',
    'Prefer direct PDF/manual download links and exact-title official support/download/product pages over generic manufacturer hubs.',
    'Require exact title evidence before suggesting a manual link; if the page does not clearly reference the exact title, omit it.',
    'Require exact manufacturer or known manufacturer alias match before suggesting a manual; if manufacturer alignment is weak, omit it.',
    'Do not classify generic manufacturer homepages, generic /support pages, generic /products pages, category pages, or manual-library hubs as documentationLinks/manual results unless they are clearly exact-title manual/download pages.',
    'Put broad official support landing pages in supportResources instead of documentationLinks when they are useful but not title-specific manual pages.',
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

function buildTroubleshootingResultSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'conciseIssueSummary',
      'probableCauses',
      'immediateChecks',
      'diagnosticSteps',
      'recommendedFixes',
      'toolsNeeded',
      'partsPossiblyNeeded',
      'safetyNotes',
      'escalationSignals',
      'confidence',
      'shortFrontlineVersion',
      'detailedManagerVersion',
      'citations'
    ],
    properties: {
      conciseIssueSummary: { type: 'string' },
      probableCauses: { type: 'array', items: { type: 'string' } },
      immediateChecks: { type: 'array', items: { type: 'string' } },
      diagnosticSteps: { type: 'array', items: { type: 'string' } },
      recommendedFixes: { type: 'array', items: { type: 'string' } },
      toolsNeeded: { type: 'array', items: { type: 'string' } },
      partsPossiblyNeeded: { type: 'array', items: { type: 'string' } },
      safetyNotes: { type: 'array', items: { type: 'string' } },
      escalationSignals: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' },
      shortFrontlineVersion: { type: 'string' },
      detailedManagerVersion: { type: 'string' },
      citations: { type: 'array', items: { type: 'string' } },
    },
  };
}

function buildFollowupSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['needsFollowup', 'questions'],
    properties: {
      needsFollowup: { type: 'boolean' },
      questions: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  };
}

function buildAiResponseError({ code, message, flow, traceId, responseId, details = '' }) {
  const error = new Error(message);
  error.code = code;
  error.flow = flow;
  error.traceId = traceId;
  error.responseId = responseId || null;
  if (details) error.details = details;
  return error;
}

function extractStructuredJsonOrThrow(response, { flow, traceId, userMessage }) {
  const responseId = response?.id || null;
  if (response?.output_parsed && typeof response.output_parsed === 'object') {
    return response.output_parsed;
  }
  const raw = response?.output_text || '{}';
  try {
    return JSON.parse(raw);
  } catch (error) {
    const details = `${error?.message || 'JSON parse failed'}`;
    console.error('[openaiService] structured output parse failed', {
      traceId,
      flow,
      responseId,
      error: details
    });
    throw buildAiResponseError({
      code: 'ai_json_parse_failed',
      message: userMessage,
      flow,
      traceId,
      responseId,
      details
    });
  }
}

async function requestFollowupQuestions({ model, traceId, context }) {
  const client = getClient();
  const prompt = `Determine if follow-up questions are needed. Return JSON: {"needsFollowup":boolean, "questions": string[]} with 2-5 concise practical questions max. Context: ${JSON.stringify(context)}`;
  const response = await client.responses.create({
    model,
    metadata: { traceId, flow: 'followup-detection' },
    text: {
      format: {
        type: 'json_schema',
        name: 'task_followup_questions',
        strict: true,
        schema: buildFollowupSchema()
      }
    },
    input: [{ role: 'system', content: 'Return strict JSON.' }, { role: 'user', content: prompt }]
  });
  const parsed = extractStructuredJsonOrThrow(response, {
    flow: 'followup-detection',
    traceId,
    userMessage: 'AI follow-up analysis returned invalid data. Please rerun.'
  });
  return {
    needsFollowup: !!parsed.needsFollowup,
    questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 5).map((q) => String(q).trim()).filter(Boolean) : [],
    responseId: response.id
  };
}

async function requestTroubleshootingPlan({ model, traceId, settings, context }) {
  const client = getClient();
  const groundingDirective = buildGroundingDirective(context);
  const validationOverride = context?.validationOverride?.enforceDefinitionFirstSentence
    ? 'Validation retry: you previously omitted a known code definition. You MUST begin with the code definition sentence from supplied evidence.'
    : '';
  const response = await client.responses.create({
    model,
    metadata: { traceId, flow: 'task-troubleshooting' },
    text: {
      format: {
        type: 'json_schema',
        name: 'task_troubleshooting_plan',
        strict: true,
        schema: buildTroubleshootingResultSchema()
      }
    },
    input: [
      { role: 'system', content: buildSystemInstructions(settings) },
      { role: 'developer', content: `Output strict JSON schema: ${buildSchemaPrompt()}` },
      { role: 'developer', content: [groundingDirective, validationOverride].filter(Boolean).join('\n') || 'Use supplied evidence order and grounding rules.' },
      { role: 'user', content: `Use this structured context: ${JSON.stringify(context)}` }
    ]
  });
  const flow = 'task-troubleshooting';
  const data = extractStructuredJsonOrThrow(response, {
    flow,
    traceId,
    userMessage: 'AI troubleshooting output was invalid. Please rerun.'
  });
  let parsed;
  try {
    parsed = validateAiResultShape(data);
  } catch (error) {
    const details = `${error?.message || 'AI result validation failed'}`;
    console.error('[openaiService] troubleshooting output validation failed', {
      traceId,
      flow,
      responseId: response?.id || null,
      error: details
    });
    throw buildAiResponseError({
      code: 'ai_result_validation_failed',
      message: 'AI troubleshooting output failed validation. Please rerun.',
      flow,
      traceId,
      responseId: response?.id || null,
      details
    });
  }
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

function buildManualResearchInstructions(context = {}) {
  const originalTitle = `${context.originalTitle || ''}`.trim();
  const normalizedTitle = `${context.normalizedTitle || ''}`.trim();
  const manufacturerHint = `${context.manufacturerHint || ''}`.trim();
  const aliases = Array.isArray(context.titleAliases) ? context.titleAliases.filter(Boolean) : [];
  const queryPhrases = [
    `"${originalTitle}" "${manufacturerHint}" operator manual pdf`,
    `"${originalTitle}" "${manufacturerHint}" service manual pdf`,
    `"${originalTitle}" "${manufacturerHint}" install manual pdf`,
    `"${originalTitle}" manual download`,
    `"${originalTitle}" "${manufacturerHint}" manual download`,
    `filetype:pdf "${originalTitle}"`,
    ...(normalizedTitle && normalizedTitle.toLowerCase() !== originalTitle.toLowerCase()
      ? [
        `"${normalizedTitle}" "${manufacturerHint}" operator manual pdf`,
        `"${normalizedTitle}" "${manufacturerHint}" service manual pdf`,
        `"${normalizedTitle}" "${manufacturerHint}" install manual pdf`,
        `"${normalizedTitle}" manual download`,
        `"${normalizedTitle}" "${manufacturerHint}" manual download`,
        `filetype:pdf "${normalizedTitle}"`,
      ]
      : []),
    ...aliases.flatMap((alias) => ([
      `"${alias}" "${manufacturerHint}" operator manual pdf`,
      `"${alias}" "${manufacturerHint}" service manual pdf`,
      `"${alias}" "${manufacturerHint}" install manual pdf`,
      `"${alias}" manual download`,
      `"${alias}" "${manufacturerHint}" manual download`,
      `filetype:pdf "${alias}"`,
    ])),
  ].filter(Boolean);
  return [
    'You are a manual research assistant for arcade/FEC asset intake.',
    'Research the arcade manual for the specific title, family, and manufacturer like an expert operator would using web_search first.',
    'Search for operator manuals, service manuals, install/installation guides, parts manuals, and real downloadable manual pages.',
    'Run official manufacturer and major distributor domains first; if no strong manual appears, expand to broader web search.',
    'Use and adapt these required queries verbatim where relevant:',
    ...queryPhrases.map((query) => `- ${query}`),
    'Use exact title variants and known aliases throughout the search.',
    'Keep three concepts separate: manualUrl (actual manual candidate), manualSourceUrl (title-specific source page), and supportUrl (support context only).',
    'Generic support hubs are useful context but never count as manuals.',
    'Only set manualUrl when you have direct manual/download proof. Never put generic support/product/category/search pages in manualUrl.',
    'Only exact_manual or manual_page_with_download may set manualReady=true.',
    'If title family or variant ambiguity remains, use family_match_needs_review or title_specific_source and set reviewRequired=true.',
    'If no actual manual is found, preserve the best title-specific source or support page plus contact info when available.',
    'Be title-family aware about close variants, for example: Quick Drop/Quik Drop, Virtual Rabbids/Virtual Rabbids The Big Ride, King Kong VR/King Kong of Skull Island VR, Fast and Furious/Fast & Furious Arcade, Sink-It/Sink It/Sink It Shootout, and HYPERshoot.',
    'Never treat header/footer/nav links, service directories, consultative-services pages, installations pages, office-coffee pages, career pages, account/cart/login pages, or generic site-search/category pages as manuals.',
    'Be conservative. Do not invent manuals, URLs, titles, contact info, or confidence.',
    'Return ranked candidates in buckets: verified_pdf_candidate, title_specific_support_page, likely_install_or_service_doc, brochure_or_spec_doc, weak_lead.',
    'Each candidate must include url, title, sourceDomain, whyMatch, and confidence.',
    'Set selectedCandidate to the best manual attempt if one exists.',
    'Return JSON only. Put concise reasoning in matchNotes and optional rawResearchSummary, not chain-of-thought.',
    `Allowed manufacturer/trusted domains: ${(context.allowedDomains || []).join(', ') || 'none provided'}.`,
    `Input title: "${originalTitle}", normalized family title: "${normalizedTitle}", manufacturer hint: "${manufacturerHint}".`,
    `Aliases: ${aliases.join(', ') || 'none'}.`,
  ].join('\n');
}

function buildManualResearchSchemaPrompt() {
  return JSON.stringify({
    normalizedTitle: 'string',
    manufacturer: 'string',
    manufacturerInferred: false,
    matchType: 'exact_manual|manual_page_with_download|title_specific_source|support_only|family_match_needs_review|unresolved',
    manualReady: false,
    reviewRequired: true,
    variantWarning: 'string',
    manualUrl: 'https://...',
    manualSourceUrl: 'https://...',
    supportUrl: 'https://...',
    supportEmail: 'string',
    supportPhone: 'string',
    confidence: 0.0,
    matchConfidence: 0.0,
    matchNotes: 'string',
    candidates: [{
      bucket: 'verified_pdf_candidate|title_specific_support_page|likely_install_or_service_doc|brochure_or_spec_doc|weak_lead',
      url: 'https://...',
      title: 'string',
      sourceDomain: 'string',
      whyMatch: 'string',
      confidence: 0.0,
    }],
    selectedCandidate: {
      bucket: 'verified_pdf_candidate|title_specific_support_page|likely_install_or_service_doc|brochure_or_spec_doc|weak_lead',
      url: 'https://...',
      title: 'string',
      sourceDomain: 'string',
      whyMatch: 'string',
      confidence: 0.0,
    },
    evidence: [{ url: 'https://...', title: 'string', reason: 'string' }],
    citations: [{ url: 'https://...', title: 'string' }],
    rawResearchSummary: 'string'
  });
}

function extractToolCitations(response = {}) {
  const citations = [];
  for (const item of response.output || []) {
    if (item?.type === 'message') {
      for (const content of item.content || []) {
        for (const annotation of content.annotations || []) {
          if (annotation?.type === 'url_citation' && annotation.url) {
            citations.push({
              url: annotation.url,
              title: annotation.title || '',
            });
          }
        }
      }
    }
    if (item?.type === 'web_search_call' && Array.isArray(item?.action?.sources)) {
      item.action.sources.forEach((source) => {
        if (source?.url) citations.push({ url: source.url, title: source.title || '' });
      });
    }
  }
  return citations;
}

async function requestManualResearchFallback({
  model,
  traceId,
  context,
  apiKey = '',
  reasoningEffort = 'low',
  webSearchEnabled = true,
  fileSearchEnabled = true,
  vectorStoreIds = [],
  maxWebSources = 5,
}) {
  const client = getClient({ apiKeyOverride: apiKey });
  const tools = [];
  if (webSearchEnabled) {
    const webTool = {
      type: 'web_search',
      filters: Array.isArray(context?.allowedDomains) && context.allowedDomains.length
        ? { allowed_domains: context.allowedDomains.slice(0, 100) }
        : undefined,
    };
    tools.push(webTool);
  }
  if (fileSearchEnabled && Array.isArray(vectorStoreIds) && vectorStoreIds.length) {
    tools.push({
      type: 'file_search',
      vector_store_ids: vectorStoreIds.slice(0, 5),
      max_num_results: Math.max(1, Math.min(10, Number(maxWebSources || 5))),
    });
  }

  let response;
  try {
    response = await client.responses.create({
      model,
      reasoning: { effort: reasoningEffort },
      metadata: { traceId, flow: 'manual-research-fallback' },
      tools,
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
      text: {
        format: {
          type: 'json_schema',
          name: 'manual_research_candidates',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['normalizedTitle', 'manufacturer', 'manufacturerInferred', 'matchType', 'manualReady', 'reviewRequired', 'manualUrl', 'manualSourceUrl', 'supportUrl', 'supportEmail', 'supportPhone', 'confidence', 'matchConfidence', 'matchNotes', 'candidates', 'citations', 'rawResearchSummary'],
            properties: {
              normalizedTitle: { type: 'string' },
              manufacturer: { type: 'string' },
              manufacturerInferred: { type: 'boolean' },
              matchType: { type: 'string' },
              manualReady: { type: 'boolean' },
              reviewRequired: { type: 'boolean' },
              variantWarning: { type: 'string' },
              manualUrl: { type: 'string' },
              manualSourceUrl: { type: 'string' },
              supportUrl: { type: 'string' },
              supportEmail: { type: 'string' },
              supportPhone: { type: 'string' },
              confidence: { type: 'number' },
              matchConfidence: { type: 'number' },
              matchNotes: { type: 'string' },
              candidates: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['bucket', 'url', 'title', 'sourceDomain', 'whyMatch', 'confidence'],
                  properties: {
                    bucket: { type: 'string' },
                    url: { type: 'string' },
                    title: { type: 'string' },
                    sourceDomain: { type: 'string' },
                    whyMatch: { type: 'string' },
                    confidence: { type: 'number' },
                  }
                }
              },
              selectedCandidate: {
                type: 'object',
                additionalProperties: false,
                required: ['bucket', 'url', 'title', 'sourceDomain', 'whyMatch', 'confidence'],
                properties: {
                  bucket: { type: 'string' },
                  url: { type: 'string' },
                  title: { type: 'string' },
                  sourceDomain: { type: 'string' },
                  whyMatch: { type: 'string' },
                  confidence: { type: 'number' },
                }
              },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['url', 'title', 'reason'],
                  properties: {
                    url: { type: 'string' },
                    title: { type: 'string' },
                    reason: { type: 'string' },
                  },
                },
              },
              citations: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['url', 'title'],
                  properties: {
                    url: { type: 'string' },
                    title: { type: 'string' },
                  },
                },
              },
              rawResearchSummary: { type: 'string' },
            },
          },
        },
      },
      input: [
        { role: 'system', content: buildManualResearchInstructions(context) },
        { role: 'developer', content: `Output strict JSON schema: ${buildManualResearchSchemaPrompt()}` },
        { role: 'user', content: `Research this arcade/FEC title with the provided context and return JSON only: ${JSON.stringify(context)}` },
      ],
    });
  } catch (error) {
    const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
    const message = `${error?.message || ''}`.toLowerCase();
    if (status === 401 || /incorrect api key|invalid api key|unauthorized/.test(message)) {
      const normalized = new Error('OpenAI authentication failed for manual research. Verify OPENAI_API_KEY secret binding.');
      normalized.code = 'openai-auth-invalid';
      throw normalized;
    }
    throw error;
  }

  const parsed = validateManualResearchResultShape(JSON.parse(response.output_text || '{}'));
  const mergedCitations = [...(parsed.citations || []), ...extractToolCitations(response)];
  return {
    ...parsed,
    citations: mergedCitations.slice(0, 12),
    responseMeta: { responseId: response.id, model: response.model },
  };
}

module.exports = {
  OPENAI_API_KEY,
  requestFollowupQuestions,
  requestTroubleshootingPlan,
  requestAssetDocumentationLookup,
  requestManualResearchFallback
};
