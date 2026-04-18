const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  requestManualResearchFallback,
} = require('./openaiService');
const {
  discoverManualDocumentation,
  classifyManualCandidate,
  hasJunkManualCandidateUrl,
} = require('./manualDiscoveryService');
const {
  findCatalogManualMatch,
} = require('./manualLookupCatalogService');
const {
  resolveArcadeTitleFamily,
  normalizeManufacturerName,
  expandArcadeTitleAliases,
} = require('./arcadeTitleAliasService');
const {
  getManufacturerProfile,
  normalizeDocumentationSuggestions,
  verifyDocumentationSuggestions,
  mergeDocumentationSuggestions,
  findReusableVerifiedManuals,
  classifyManualMatchSummary,
} = require('./assetEnrichmentService');
const { acquireManualToLibrary } = require('./manualAcquisitionService');

const FALLBACK_MATCH_TYPES = new Set([
  'title_specific_source',
  'support_only',
  'family_match_needs_review',
  'unresolved',
]);
const OPENAI_WEAK_CANDIDATE_BUCKETS = new Set([
  'weak_lead',
  'title_specific_support_page',
  'brochure_or_spec_doc',
]);

const CACHE_COLLECTION = 'assetTitleResearchCache';
const MAX_TITLE_BATCH = 50;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MANUAL_ACQUISITION_TIMEOUT_MS = 15000;

function logManualResearchEvent(event, payload = {}) {
  try {
    console.log(`manualResearch:${event}`, payload);
  } catch {
    // swallow logging failures so research stays safe
  }
}

function buildResearchLogContext({ row = {}, companyId = '', traceId = '' } = {}) {
  return {
    assetId: normalizeString(row?.assetId || '', 120),
    companyId: normalizeString(companyId, 120),
    runId: normalizeString(row?.runId || row?.enrichmentRunId || '', 120),
    traceId: normalizeString(traceId, 160),
  };
}

function normalizeString(value = '', max = 240) {
  return `${value || ''}`.trim().slice(0, max);
}

function normalizeUrl(value = '') {
  const trimmed = `${value || ''}`.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeErrorMessage(error, max = 220) {
  return normalizeString(error?.message || String(error || ''), max);
}

function createTimeoutError(message, code = 'deadline-exceeded') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function withTimeout(operation, timeoutMs, timeoutMessage) {
  let timer = null;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createTimeoutError(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitizeCitation(entry = {}) {
  const url = normalizeUrl(entry?.url || '');
  if (!url) return null;
  return {
    url,
    title: normalizeString(entry?.title || '', 180),
  };
}

function sanitizeCitations(entries = []) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : [])
    .map(sanitizeCitation)
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function classifySuggestionBucket(entry = {}) {
  const explicitBucket = `${entry?.bucket || entry?.candidateBucket || ''}`.trim();
  if (explicitBucket === 'verified_pdf_candidate') return 'verified_manual';
  if (explicitBucket === 'title_specific_support_page') return 'support_product_page';
  if (explicitBucket === 'likely_install_or_service_doc') return 'likely_manual_install_service_doc';
  if (explicitBucket === 'brochure_or_spec_doc') return 'support_product_page';
  if (explicitBucket === 'weak_lead') return 'weak_lead';
  const verified = entry?.verified === true;
  const exactManualMatch = entry?.exactManualMatch === true;
  const matchScore = Number(entry?.matchScore || 0);
  const url = normalizeUrl(entry?.url || '').toLowerCase();
  const title = normalizeString(entry?.title || '', 200).toLowerCase();
  const brochureLike = /(brochure|spec(?:ification)?(?:\s*sheet)?|sell[\s-]?sheet|flyer|catalog)/.test(`${title} ${url}`);
  if (brochureLike) return 'support_product_page';
  if (verified && exactManualMatch) return 'verified_manual';
  if ((verified && matchScore >= 60) || /manual|operator|service|install|\.pdf($|[?#])/.test(url)) return 'likely_manual_install_service_doc';
  if (/(support|product|download|service|parts)/.test(url) || ['support', 'official_site', 'parts', 'distributor'].includes(`${entry?.resourceType || entry?.sourceType || ''}`.toLowerCase())) {
    return 'support_product_page';
  }
  return 'weak_lead';
}

function withSuggestionBucket(entry = {}) {
  return {
    ...entry,
    candidateBucket: classifySuggestionBucket(entry),
  };
}

function buildDomainAllowlist({ manufacturerProfile, titleFamily }) {
  return Array.from(new Set([
    ...((manufacturerProfile?.preferredSourceTokens || []).map((value) => `${value || ''}`.trim().toLowerCase())),
    ...((manufacturerProfile?.sourceTokens || []).map((value) => `${value || ''}`.trim().toLowerCase())),
    ...((manufacturerProfile?.authorizedSourceTokens || []).map((value) => `${value || ''}`.trim().toLowerCase())),
    ...((titleFamily?.manufacturer ? [titleFamily.manufacturer] : []).map((value) => `${value || ''}`.trim().toLowerCase()).filter(Boolean)),
  ].filter((value) => value.includes('.')))).slice(0, 25);
}

function buildCacheId(companyId, normalizedTitle, manufacturer) {
  const safeKey = `${companyId || 'global'}::${normalizedTitle || ''}::${manufacturer || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 180);
  return safeKey || 'manual-research-cache';
}

function mapResearchResultToSuggestions(result = {}, manufacturerProfile = {}) {
  const documentationSuggestions = [];
  const supportResourcesSuggestion = [];
  const citations = sanitizeCitations(result.citations);
  const trustedSource = buildDomainAllowlist({ manufacturerProfile, titleFamily: {} })
    .some((domain) => normalizeUrl(result.manualUrl || result.manualSourceUrl || result.supportUrl || '').includes(domain));
  const manualUrl = normalizeUrl(result.manualUrl || result.selectedCandidate?.url || '');
  const manualTitle = normalizeString(result.manualTitle || result.originalTitle || result.normalizedTitle || '', 160);
  const manualTitleVariants = [result.normalizedTitle, result.originalTitle, manualTitle]
    .flatMap((value) => `${value || ''}`.trim() ? [resolveArcadeTitleFamily({ title: value, manufacturer: result.manufacturer || '' }).canonicalTitle || value] : [])
    .map((value) => `${value || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .filter(Boolean);
  const manualLikeUrl = isLikelyManualResearchUrl(manualUrl, {
    title: manualTitle,
    manufacturer: result.manufacturer || '',
    titleVariants: manualTitleVariants,
    manufacturerProfile,
  });
  const manualLikeMatchType = ['exact_manual', 'manual_page_with_download'].includes(`${result.matchType || ''}`.trim());
  const explicitManualContract = result.manualReady === true || manualLikeMatchType || /\.pdf($|[?#])/.test(manualUrl.toLowerCase());

  const stageTwoCandidates = Array.isArray(result.candidates) ? result.candidates : [];
  stageTwoCandidates.forEach((candidate) => {
    const candidateUrl = normalizeUrl(candidate?.url || '');
    if (!candidateUrl || hasJunkManualCandidateUrl(candidateUrl)) return;
    const bucket = classifySuggestionBucket(candidate);
    const payload = {
      title: normalizeString(candidate?.title || result.normalizedTitle || result.originalTitle || '', 160),
      url: candidateUrl,
      sourceType: trustedSource ? 'manufacturer' : 'other',
      exactTitleMatch: true,
      exactManualMatch: bucket === 'verified_manual',
      trustedSource,
      matchType: result.matchType,
      sourcePageUrl: result.manualSourceUrl || '',
      citations,
      rawResearchSummary: result.rawResearchSummary || '',
      candidateBucket: bucket,
      matchScore: Math.round(Math.max(0, Math.min(1, Number(candidate?.confidence || 0))) * 100),
    };
    if (bucket === 'verified_manual' || bucket === 'likely_manual_install_service_doc') {
      documentationSuggestions.push(payload);
    } else {
      supportResourcesSuggestion.push({
        label: payload.title,
        url: payload.url,
        resourceType: bucket === 'weak_lead' ? 'other' : 'support',
        sourceType: payload.sourceType,
        citations,
      });
    }
  });

  if (manualUrl && explicitManualContract && manualLikeUrl && !documentationSuggestions.some((entry) => entry.url === manualUrl)) {
    documentationSuggestions.push({
      title: normalizeString(result.manualTitle || result.originalTitle || result.normalizedTitle || '', 160),
      url: manualUrl,
      sourceType: trustedSource ? 'manufacturer' : 'other',
      exactTitleMatch: true,
      exactManualMatch: result.manualReady === true || manualLikeMatchType || manualLikeUrl,
      trustedSource,
      matchType: result.matchType,
      sourcePageUrl: result.manualSourceUrl || '',
      citations,
      rawResearchSummary: result.rawResearchSummary || '',
    });
  }
  if (result.manualSourceUrl && !hasJunkManualCandidateUrl(result.manualSourceUrl)) {
    supportResourcesSuggestion.push({
      label: normalizeString(result.manualSourceTitle || result.normalizedTitle || result.originalTitle || '', 160),
      url: result.manualSourceUrl,
      resourceType: 'support',
      sourceType: trustedSource ? 'manufacturer' : 'other',
      citations,
    });
  }
  if (result.supportUrl && !hasJunkManualCandidateUrl(result.supportUrl)) {
    supportResourcesSuggestion.push({
      label: normalizeString(result.supportTitle || `Support for ${result.normalizedTitle || result.originalTitle || 'title'}`, 160),
      url: result.supportUrl,
      resourceType: 'support',
      sourceType: trustedSource ? 'manufacturer' : 'other',
      citations,
    });
  }
  return { documentationSuggestions, supportResourcesSuggestion };
}

function isLikelyManualResearchUrl(url = '', { title = '', manufacturer = '', titleVariants = [], manufacturerProfile = null } = {}) {
  const normalized = normalizeUrl(url).toLowerCase();
  if (!normalized) return false;
  if (hasJunkManualCandidateUrl(normalized)) return false;
  const classification = classifyManualCandidate({
    title,
    url: normalized,
    manufacturer,
    titleVariants,
    manufacturerProfile,
  });
  return classification.includeManual;
}

async function loadCachedResearchResult({ db, companyId, normalizedTitle, manufacturer }) {
  const cacheId = buildCacheId(companyId, normalizedTitle, manufacturer);
  const snap = await db.collection(CACHE_COLLECTION).doc(cacheId).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  const updatedAtMs = data.updatedAt?.toMillis?.() || data.updatedAtMs || 0;
  if (!updatedAtMs || (Date.now() - updatedAtMs) > CACHE_TTL_MS) return null;
  return data.result || null;
}

async function saveCachedResearchResult({ db, companyId, normalizedTitle, manufacturer, result, sourceType }) {
  const cacheId = buildCacheId(companyId, normalizedTitle, manufacturer);
  await db.collection(CACHE_COLLECTION).doc(cacheId).set({
    companyId: companyId || '',
    normalizedTitle,
    manufacturer,
    sourceType,
    result,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAtMs: Date.now(),
  }, { merge: true });
}

async function runStageOneLookup({
  db,
  input,
  fetchImpl = fetch,
  companyId = '',
}) {
  const titleFamily = resolveArcadeTitleFamily({
    title: input.originalTitle,
    manufacturer: input.manufacturerHint || '',
  });
  const normalizedTitle = titleFamily.canonicalTitle || input.originalTitle;
  const manufacturer = normalizeManufacturerName(titleFamily.manufacturer || input.manufacturerHint || '');
  const manufacturerProfile = getManufacturerProfile(input.manufacturerHint || manufacturer, normalizedTitle);
  const catalogMatch = findCatalogManualMatch({
    assetName: input.originalTitle,
    normalizedName: normalizedTitle,
    manufacturer,
    manufacturerProfile,
  });
  const catalogSuggestions = catalogMatch
    ? normalizeDocumentationSuggestions({
      links: catalogMatch.documentationSuggestions,
      confidence: Math.max(0.7, Number(catalogMatch.confidence || 0)),
      asset: { name: input.originalTitle, manufacturer },
      normalizedName: normalizedTitle,
      manufacturerSuggestion: manufacturer,
    })
    : [];
  const verifiedCatalogSuggestions = catalogSuggestions.length
    ? await verifyDocumentationSuggestions(catalogSuggestions, fetchImpl)
    : [];
  const reusedSuggestions = companyId
    ? await findReusableVerifiedManuals({
      db,
      asset: { name: input.originalTitle, manufacturer, normalizedName: normalizedTitle },
      assetId: input.assetId || '',
      companyId,
      matchedManufacturer: manufacturerProfile?.key || '',
    })
    : [];

  const documentationSuggestions = mergeDocumentationSuggestions({
    existingSuggestions: [...verifiedCatalogSuggestions, ...reusedSuggestions],
    nextSuggestions: [],
    preserveExistingCandidates: true,
  });
  const supportResourcesSuggestion = normalizeDocumentationSuggestions({
    links: [
      ...(catalogMatch?.supportResources || []),
    ],
    confidence: Math.max(0.45, Number(catalogMatch?.confidence || 0)),
    asset: { name: input.originalTitle, manufacturer },
    normalizedName: normalizedTitle,
    manufacturerSuggestion: manufacturer,
    kind: 'support',
  });

  const summary = classifyManualMatchSummary({
    inputTitle: input.originalTitle,
    titleFamily,
    documentationSuggestions,
    supportResourcesSuggestion,
    supportContactsSuggestion: [],
    confidence: Math.max(Number(catalogMatch?.confidence || 0), documentationSuggestions[0]?.matchScore ? documentationSuggestions[0].matchScore / 100 : 0),
    catalogMatch,
  });

  return {
    originalTitle: input.originalTitle,
    normalizedTitle,
    canonicalTitleFamily: titleFamily.canonicalTitle || normalizedTitle,
    manufacturer: manufacturer || '',
    manufacturerInferred: !input.manufacturerHint && !!manufacturer,
    titleFamily,
    manufacturerProfile,
    documentationSuggestions: documentationSuggestions.map(withSuggestionBucket),
    supportResourcesSuggestion: supportResourcesSuggestion.map(withSuggestionBucket),
    supportContactsSuggestion: [],
    summary,
    catalogMatch,
    searchEvidence: [],
    stage: 'stage1',
  };
}

async function runDiscoveryFallback({
  settings = {},
  input,
  stageOne,
  fetchImpl = fetch,
  maxWebSources = 5,
}) {
  const discovered = await discoverManualDocumentation({
    assetName: input.originalTitle,
    normalizedName: stageOne.normalizedTitle,
    manufacturer: stageOne.manufacturer,
    manufacturerProfile: stageOne.manufacturerProfile,
    searchHints: [],
    searchProviderOptions: {
      primarySearchProvider: settings.manualResearchPrimarySearchProvider || '',
      serpApiKey: settings.manualResearchSerpApiKey || process.env.SERPAPI_API_KEY || '',
      bingApiKey: settings.manualResearchBingApiKey || process.env.BING_SEARCH_API_KEY || '',
      bingEndpoint: settings.manualResearchBingEndpoint || process.env.BING_SEARCH_ENDPOINT || '',
    },
    logger: console,
    traceId: `manual-research-fallback-${Date.now()}`,
    fetchImpl,
  });
  return {
    documentationSuggestions: normalizeDocumentationSuggestions({
      links: (discovered.documentationLinks || []).slice(0, Math.max(1, maxWebSources)),
      confidence: 0.6,
      asset: { name: input.originalTitle, manufacturer: stageOne.manufacturer },
      normalizedName: stageOne.normalizedTitle,
      manufacturerSuggestion: stageOne.manufacturer,
    }),
    supportResourcesSuggestion: normalizeDocumentationSuggestions({
      links: (discovered.supportResources || []).slice(0, Math.max(1, maxWebSources)),
      confidence: 0.45,
      asset: { name: input.originalTitle, manufacturer: stageOne.manufacturer },
      normalizedName: stageOne.normalizedTitle,
      manufacturerSuggestion: stageOne.manufacturer,
      kind: 'support',
    }),
    searchEvidence: Array.isArray(discovered.evidence) ? discovered.evidence : [],
  };
}

async function runStageTwoResearch({
  db,
  settings,
  companyId,
  includeInternalDocs,
  input,
  stageOne,
  traceId,
  maxWebSources,
  researchFallback = requestManualResearchFallback,
}) {
  const model = settings.manualResearchModel || settings.aiModel || 'gpt-5';
  const webSearchEnabled = settings.manualResearchWebSearchEnabled !== false;
  const fileSearchEnabled = settings.manualResearchFileSearchEnabled !== false;
  const vectorStoreIds = includeInternalDocs !== false
    ? (Array.isArray(settings.manualResearchVectorStoreIds) ? settings.manualResearchVectorStoreIds : [])
    : [];
  const cached = await loadCachedResearchResult({
    db,
    companyId,
    normalizedTitle: stageOne.normalizedTitle,
    manufacturer: stageOne.manufacturer,
  });
  if (cached) {
    logManualResearchEvent('stage2_skipped', {
      title: input.originalTitle,
      normalizedTitle: stageOne.normalizedTitle,
      manufacturer: stageOne.manufacturer,
      stage1MatchType: stageOne.summary.matchType,
      ranStage2: false,
      reason: 'cache_hit',
      model,
      webSearchEnabled,
      fileSearchEnabled: fileSearchEnabled && vectorStoreIds.length > 0,
    });
    return { ...cached, sourceType: 'cache' };
  }

  const allowedDomains = buildDomainAllowlist({
    manufacturerProfile: stageOne.manufacturerProfile,
    titleFamily: stageOne.titleFamily,
  });
  logManualResearchEvent('stage2_start', {
    title: input.originalTitle,
    normalizedTitle: stageOne.normalizedTitle,
    manufacturer: stageOne.manufacturer,
    stage1MatchType: stageOne.summary.matchType,
    ranStage2: true,
    model,
    webSearchEnabled,
    fileSearchEnabled: fileSearchEnabled && vectorStoreIds.length > 0,
  });
  logManualResearchEvent('stage2_prompt_built', {
    title: input.originalTitle,
    normalizedTitle: stageOne.normalizedTitle,
    manufacturer: stageOne.manufacturer,
    stage1MatchType: stageOne.summary.matchType,
    allowedDomainCount: allowedDomains.length,
    allowedDomains: allowedDomains.slice(0, 10),
    includeInternalDocs: includeInternalDocs !== false,
    vectorStoreCount: vectorStoreIds.length,
  });

  const result = await researchFallback({
    model,
    reasoningEffort: settings.manualResearchReasoningEffort || 'low',
    traceId,
    maxWebSources,
    webSearchEnabled,
    fileSearchEnabled,
    vectorStoreIds,
    context: {
      companyId,
      originalTitle: input.originalTitle,
      normalizedTitle: stageOne.normalizedTitle,
      manufacturerHint: input.manufacturerHint || '',
      stageOneSummary: stageOne.summary,
      allowedDomains,
      includeInternalDocs: includeInternalDocs !== false,
      titleAliases: expandArcadeTitleAliases([input.originalTitle, stageOne.normalizedTitle]).slice(0, 8),
    },
  });
  logManualResearchEvent('stage2_response_received', {
    title: input.originalTitle,
    normalizedTitle: stageOne.normalizedTitle,
    manufacturer: result.manufacturer || stageOne.manufacturer,
    stage1MatchType: stageOne.summary.matchType,
    ranStage2: true,
    model: result.responseMeta?.model || model,
    webSearchEnabled,
    fileSearchEnabled: fileSearchEnabled && vectorStoreIds.length > 0,
    citationCount: sanitizeCitations(result.citations).length,
    rawMatchType: result.matchType,
    rawManualReady: result.manualReady === true,
  });
  logManualResearchEvent('openai_candidate_json_returned', {
    title: input.originalTitle,
    normalizedTitle: stageOne.normalizedTitle,
    manufacturer: result.manufacturer || stageOne.manufacturer,
    candidateCount: Array.isArray(result.candidates) ? result.candidates.length : 0,
    selectedCandidateUrl: normalizeString(result.selectedCandidate?.url || '', 220),
  });
  const merged = {
    ...result,
    originalTitle: input.originalTitle,
    normalizedTitle: result.normalizedTitle || stageOne.normalizedTitle,
    canonicalTitleFamily: stageOne.canonicalTitleFamily,
    manufacturer: result.manufacturer || stageOne.manufacturer || '',
    manufacturerInferred: typeof result.manufacturerInferred === 'boolean'
      ? result.manufacturerInferred
      : !input.manufacturerHint && !!(result.manufacturer || stageOne.manufacturer),
    citations: sanitizeCitations(result.citations),
  };
  await saveCachedResearchResult({
    db,
    companyId,
    normalizedTitle: stageOne.normalizedTitle,
    manufacturer: stageOne.manufacturer,
    result: merged,
    sourceType: 'responses_api',
  });
  return { ...merged, sourceType: 'responses_api' };
}

async function researchAssetTitles({
  db,
  settings,
  companyId,
  locationId = '',
  titles = [],
  includeInternalDocs = true,
  maxWebSources = 5,
  traceId = '',
  fetchImpl = fetch,
  researchFallback,
  storage = admin.storage(),
}) {
  if (!companyId) throw new HttpsError('invalid-argument', 'companyId is required');
  if (!Array.isArray(titles) || !titles.length) throw new HttpsError('invalid-argument', 'titles is required');
  if (titles.length > MAX_TITLE_BATCH) throw new HttpsError('invalid-argument', `titles must contain at most ${MAX_TITLE_BATCH} entries`);

  const results = [];
  for (const row of titles) {
    const startedAt = Date.now();
    const logContext = buildResearchLogContext({ row, companyId, traceId });
    const originalTitle = normalizeString(row?.originalTitle || '', 160);
    if (!originalTitle) continue;
    const stageOne = await runStageOneLookup({
      db,
      settings,
      input: {
        originalTitle,
        manufacturerHint: normalizeString(row?.manufacturerHint || '', 120),
        assetId: normalizeString(row?.assetId || '', 120),
      },
      fetchImpl,
      companyId,
      maxWebSources,
    });

    let summary = {
      ...stageOne.summary,
      originalTitle,
      normalizedTitle: stageOne.normalizedTitle,
      canonicalTitleFamily: stageOne.canonicalTitleFamily,
      manufacturer: stageOne.summary.manufacturer || stageOne.manufacturer || '',
      manufacturerInferred: stageOne.manufacturerInferred,
      citations: [],
      rawResearchSummary: '',
      researchTimestamp: null,
      researchSourceType: 'stage1',
    };
    let documentationSuggestions = stageOne.documentationSuggestions;
    let supportResourcesSuggestion = stageOne.supportResourcesSuggestion;
    let supportContactsSuggestion = stageOne.supportContactsSuggestion;
    const stage2CandidateAudit = [];
    let stage2ReturnedCandidates = [];
    let stage2SelectedCandidate = null;

    logManualResearchEvent('stage1_result', {
      ...logContext,
      title: originalTitle,
      normalizedTitle: stageOne.normalizedTitle,
      manufacturer: stageOne.manufacturer,
      stage1MatchType: stageOne.summary.matchType,
      ranStage2: true,
      candidateManualCount: cleanCount(stageOne.documentationSuggestions),
      supportCandidateCount: stageOne.supportResourcesSuggestion.length,
      finalManualReady: stageOne.summary.manualReady === true,
    });
    logManualResearchEvent('OPENAI_SEARCH_STARTED', {
      ...logContext,
      title: originalTitle,
      normalizedTitle: stageOne.normalizedTitle,
      manufacturer: stageOne.manufacturer,
    });
    const stageTwo = await runStageTwoResearch({
      db,
      settings,
      companyId,
      includeInternalDocs,
      input: row,
      stageOne,
      traceId: `${traceId || 'manual-research'}:${originalTitle}`,
      maxWebSources,
      researchFallback,
    }).catch((error) => {
      const reasonCode = normalizeString(error?.code || '', 80);
      logManualResearchEvent('stage2_validation_failed', {
        ...logContext,
        title: originalTitle,
        normalizedTitle: stageOne.normalizedTitle,
        manufacturer: stageOne.manufacturer,
        stage1MatchType: stageOne.summary.matchType,
        ranStage2: true,
        reason: normalizeString(error?.message || String(error), 220),
        reasonCode,
      });
      return null;
    });
    let shouldFallbackToScraping = true;
    if (stageTwo) {
      logManualResearchEvent('openai_search_invocation', {
        ...logContext,
        title: originalTitle,
        normalizedTitle: stageOne.normalizedTitle,
        manufacturer: stageOne.manufacturer,
        matchType: stageOne.summary.matchType,
      });
      const mapped = mapResearchResultToSuggestions(stageTwo, stageOne.manufacturerProfile);
      stage2ReturnedCandidates = Array.isArray(stageTwo.candidates)
        ? stageTwo.candidates.map((entry = {}) => ({
          bucket: normalizeString(entry.bucket || '', 80),
          url: normalizeUrl(entry.url || ''),
          title: normalizeString(entry.title || '', 200),
          sourceDomain: normalizeString(entry.sourceDomain || '', 160),
          whyMatch: normalizeString(entry.whyMatch || '', 240),
          confidence: Number(entry.confidence || 0) || 0,
        })).filter((entry) => entry.url)
        : [];
      logManualResearchEvent('OPENAI_CANDIDATES_RECEIVED', {
        ...logContext,
        title: originalTitle,
        normalizedTitle: stageOne.normalizedTitle,
        manufacturer: stageOne.manufacturer,
        candidateCount: stage2ReturnedCandidates.length,
      });
      const chosenCandidate = stageTwo.selectedCandidate?.url
        ? stageTwo.selectedCandidate
        : (Array.isArray(stageTwo.candidates)
          ? stageTwo.candidates.find((entry) => ['verified_pdf_candidate', 'likely_install_or_service_doc'].includes(`${entry?.bucket || ''}`))
          : null);
      stage2SelectedCandidate = chosenCandidate?.url
        ? {
          bucket: normalizeString(chosenCandidate.bucket || '', 80),
          url: normalizeUrl(chosenCandidate.url || ''),
          title: normalizeString(chosenCandidate.title || '', 200),
          sourceDomain: normalizeString(chosenCandidate.sourceDomain || '', 160),
          whyMatch: normalizeString(chosenCandidate.whyMatch || '', 240),
          confidence: Number(chosenCandidate.confidence || 0) || 0,
        }
        : null;
      if (chosenCandidate?.url) {
        logManualResearchEvent('OPENAI_SELECTED_CANDIDATE', {
          ...logContext,
          title: originalTitle,
          normalizedTitle: stageOne.normalizedTitle,
          manufacturer: stageTwo.manufacturer || stageOne.manufacturer,
          selectedCandidateUrl: chosenCandidate.url,
          selectedCandidateBucket: chosenCandidate.bucket || '',
        });
      }
      const normalizedStageTwoDocs = normalizeDocumentationSuggestions({
        links: mapped.documentationSuggestions,
        confidence: Number(stageTwo.confidence || stageOne.summary.confidence || 0),
        asset: { name: originalTitle, manufacturer: stageTwo.manufacturer || stageOne.manufacturer },
        normalizedName: stageTwo.normalizedTitle || stageOne.normalizedTitle,
        manufacturerSuggestion: stageTwo.manufacturer || stageOne.manufacturer,
      });
      const verifiedStageTwoDocs = normalizedStageTwoDocs.length
        ? await verifyDocumentationSuggestions(normalizedStageTwoDocs, fetchImpl)
        : [];
      const acceptedManualCandidateCount = verifiedStageTwoDocs.filter((entry) => entry.verified && entry.exactManualMatch).length;
      shouldFallbackToScraping = shouldRunFallbackScraping({
        returnedCandidates: stage2ReturnedCandidates,
        acceptedManualCandidateCount,
      });
      if (stageTwo.manualUrl && !normalizedStageTwoDocs.length) {
        logManualResearchEvent('candidate_rejected', {
          ...logContext,
          title: originalTitle,
          normalizedTitle: stageOne.normalizedTitle,
          manufacturer: stageTwo.manufacturer || stageOne.manufacturer,
          stage1MatchType: stageOne.summary.matchType,
          ranStage2: true,
          candidateUrl: stageTwo.manualUrl,
          reason: 'manual_contract_not_authoritative',
        });
      }
      logManualResearchEvent('stage2_candidates_extracted', {
        ...logContext,
        title: originalTitle,
        normalizedTitle: stageOne.normalizedTitle,
        manufacturer: stageTwo.manufacturer || stageOne.manufacturer,
        stage1MatchType: stageOne.summary.matchType,
        ranStage2: true,
        candidateCount: normalizedStageTwoDocs.length,
        rejectedCandidateCount: Math.max(0, normalizedStageTwoDocs.length - acceptedManualCandidateCount),
        acceptedManualCandidateCount,
        supportCandidateCount: mapped.supportResourcesSuggestion.length,
      });
      verifiedStageTwoDocs
        .filter((entry) => !(entry.verified && entry.exactManualMatch))
        .forEach((entry) => {
          stage2CandidateAudit.push({
            url: entry.url || '',
            bucket: classifySuggestionBucket(entry),
            decision: 'rejected',
            reason: entry.verificationStatus || entry.verificationKind || 'manual_contract_not_authoritative',
            exactManualMatch: entry.exactManualMatch === true,
            verified: entry.verified === true,
          });
          logManualResearchEvent('candidate_rejected', {
            ...logContext,
            title: originalTitle,
            normalizedTitle: stageOne.normalizedTitle,
            manufacturer: stageTwo.manufacturer || stageOne.manufacturer,
            stage1MatchType: stageOne.summary.matchType,
            ranStage2: true,
            candidateUrl: entry.url || '',
            verificationKind: entry.verificationKind || '',
            verificationStatus: entry.verificationStatus || '',
            exactManualMatch: entry.exactManualMatch === true,
          });
        });
      verifiedStageTwoDocs
        .filter((entry) => entry.verified && entry.exactManualMatch)
        .forEach((entry) => {
          stage2CandidateAudit.push({
            url: entry.url || '',
            bucket: classifySuggestionBucket(entry),
            decision: 'accepted',
            reason: 'verified_exact_manual',
            exactManualMatch: true,
            verified: true,
          });
        });
      documentationSuggestions = mergeDocumentationSuggestions({
        existingSuggestions: documentationSuggestions,
        nextSuggestions: verifiedStageTwoDocs,
        preserveExistingCandidates: true,
      });
      supportResourcesSuggestion = normalizeDocumentationSuggestions({
        links: [...supportResourcesSuggestion, ...mapped.supportResourcesSuggestion],
        confidence: Number(stageTwo.confidence || stageOne.summary.confidence || 0),
        asset: { name: originalTitle, manufacturer: stageTwo.manufacturer || stageOne.manufacturer },
        normalizedName: stageTwo.normalizedTitle || stageOne.normalizedTitle,
        manufacturerSuggestion: stageTwo.manufacturer || stageOne.manufacturer,
        kind: 'support',
      }).map(withSuggestionBucket);
      supportContactsSuggestion = [
        ...(stageTwo.supportEmail ? [{ label: 'Support email', value: stageTwo.supportEmail, contactType: 'email' }] : []),
        ...(stageTwo.supportPhone ? [{ label: 'Support phone', value: stageTwo.supportPhone, contactType: 'phone' }] : []),
      ];
      const reclassified = classifyManualMatchSummary({
        inputTitle: originalTitle,
        titleFamily: stageOne.titleFamily,
        documentationSuggestions,
        supportResourcesSuggestion,
        supportContactsSuggestion,
        confidence: Number(stageTwo.confidence || stageOne.summary.confidence || 0),
        catalogMatch: stageOne.catalogMatch,
      });
      if (stageTwo.manualUrl && !reclassified.manualReady) {
        logManualResearchEvent('stage2_validation_failed', {
          ...logContext,
          title: originalTitle,
          normalizedTitle: stageOne.normalizedTitle,
          manufacturer: stageTwo.manufacturer || stageOne.manufacturer,
          stage1MatchType: stageOne.summary.matchType,
          ranStage2: true,
          reason: 'manual_candidate_rejected_by_backend_validation',
          candidateManualUrl: stageTwo.manualUrl,
        });
      }
      summary = {
        ...summary,
        ...reclassified,
        originalTitle,
        manufacturer: stageTwo.manufacturer || reclassified.manufacturer || summary.manufacturer || '',
        manufacturerInferred: typeof stageTwo.manufacturerInferred === 'boolean'
          ? stageTwo.manufacturerInferred
          : reclassified.manufacturerInferred,
        supportEmail: stageTwo.supportEmail || '',
        supportPhone: stageTwo.supportPhone || '',
        matchNotes: [reclassified.matchNotes, stageTwo.matchNotes].filter(Boolean).join(' | '),
        citations: sanitizeCitations(stageTwo.citations),
        rawResearchSummary: stageTwo.rawResearchSummary || '',
        researchTimestamp: new Date().toISOString(),
        researchSourceType: stageTwo.sourceType || 'responses_api',
      };
    }
    if (shouldFallbackToScraping) {
      const discoveredFallback = await runDiscoveryFallback({
        settings,
        input: { originalTitle },
        stageOne,
        fetchImpl,
        maxWebSources,
      });
      documentationSuggestions = mergeDocumentationSuggestions({
        existingSuggestions: documentationSuggestions,
        nextSuggestions: discoveredFallback.documentationSuggestions,
        preserveExistingCandidates: true,
      });
      supportResourcesSuggestion = normalizeDocumentationSuggestions({
        links: [...supportResourcesSuggestion, ...discoveredFallback.supportResourcesSuggestion],
        confidence: Number(summary.confidence || stageOne.summary.confidence || 0),
        asset: { name: originalTitle, manufacturer: summary.manufacturer || stageOne.manufacturer },
        normalizedName: summary.normalizedTitle || stageOne.normalizedTitle,
        manufacturerSuggestion: summary.manufacturer || stageOne.manufacturer,
        kind: 'support',
      }).map(withSuggestionBucket);
      stageOne.searchEvidence = discoveredFallback.searchEvidence;
    }

    if (documentationSuggestions.length) {
      const selectedSuggestion = documentationSuggestions[0];
      const selectedSource = normalizeString(selectedSuggestion?.discoverySource || '', 80) || 'stage2_or_catalog';
      const selectedOrigin = selectedSource.startsWith('adapter:') ? 'generated_adapter_guess' : 'discovered_source';
      logManualResearchEvent('selected_candidate_origin', {
        ...logContext,
        title: originalTitle,
        normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
        manufacturer: summary.manufacturer || stageOne.manufacturer,
        selectedCandidateUrl: selectedSuggestion?.url || '',
        selectedCandidateOrigin: selectedOrigin,
        selectedCandidateSource: selectedSource,
        selectedCandidateScore: Number(selectedSuggestion?.discoveryCandidateScore || 0) || Number(selectedSuggestion?.matchScore || 0) || 0,
        selectedCandidateScoreContributions: Array.isArray(selectedSuggestion?.discoveryCandidateScoreContributions)
          ? selectedSuggestion.discoveryCandidateScoreContributions
          : [],
      });
    }

    let manualLibraryAcquisition = null;
    let acquiredCandidateIndex = -1;
    let acquisitionState = 'skipped';
    let acquisitionError = '';
    let lastFailureState = '';
    let lastFailureError = '';
    if (documentationSuggestions.length) {
      acquisitionState = 'started';
      for (let index = 0; index < documentationSuggestions.length; index += 1) {
        const candidate = documentationSuggestions[index];
        if (index > 0) {
          logManualResearchEvent('CANDIDATE_RETRY', {
            ...logContext,
            title: originalTitle,
            normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
            manufacturer: summary.manufacturer || stageOne.manufacturer,
            attempt: index + 1,
            candidateUrl: candidate?.url || '',
            previousCandidateUrl: documentationSuggestions[index - 1]?.url || '',
          });
        }
        logManualResearchEvent('manual_acquisition_start', {
          ...logContext,
          title: originalTitle,
          normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
          manufacturer: summary.manufacturer || stageOne.manufacturer,
          candidateUrl: candidate?.url || '',
          sourcePageUrl: candidate?.sourcePageUrl || summary.manualSourceUrl || '',
        });
        manualLibraryAcquisition = await withTimeout(
          acquireManualToLibrary({
            db,
            storage,
            fetchImpl,
            candidate,
            context: {
              originalTitle,
              canonicalTitle: summary.canonicalTitle || stageOne.canonicalTitleFamily,
              normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
              familyTitle: stageOne.canonicalTitleFamily,
              manufacturer: summary.manufacturer || stageOne.manufacturer,
              manufacturerProfile: stageOne.manufacturerProfile,
              manualSourceUrl: summary.manualSourceUrl,
              manualUrl: summary.manualUrl,
              matchType: summary.matchType,
              matchConfidence: summary.matchConfidence || summary.confidence,
              notes: summary.matchNotes || '',
              catalogEntryId: stageOne.catalogMatch?.catalogEntryId || '',
              seededFromWorkbook: stageOne.catalogMatch?.seededFromWorkbook === true,
              downloadTimeoutMs: MANUAL_ACQUISITION_TIMEOUT_MS,
            },
          }),
          MANUAL_ACQUISITION_TIMEOUT_MS,
          `Manual acquisition timed out after ${MANUAL_ACQUISITION_TIMEOUT_MS}ms`,
        ).catch((error) => {
          acquisitionError = normalizeErrorMessage(error);
          acquisitionState = `${error?.code || ''}` === 'deadline-exceeded' ? 'timed_out' : 'failed';
          lastFailureState = acquisitionState;
          lastFailureError = acquisitionError;
          logManualResearchEvent(acquisitionState === 'timed_out' ? 'manual_acquisition_timeout' : 'manual_acquisition_failed', {
            ...logContext,
            title: originalTitle,
            normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
            manufacturer: summary.manufacturer || stageOne.manufacturer,
            reason: acquisitionError,
            candidateUrl: candidate?.url || '',
          });
          return null;
        });
        if (manualLibraryAcquisition?.manualReady && manualLibraryAcquisition.manualLibrary) {
          acquiredCandidateIndex = index;
          acquisitionState = 'succeeded';
          break;
        }
        if (!lastFailureState) acquisitionState = 'no_manual';
      }
      if (!manualLibraryAcquisition?.manualReady && lastFailureState) {
        acquisitionState = lastFailureState;
        acquisitionError = lastFailureError || acquisitionError;
      }
    }
    if (manualLibraryAcquisition?.manualReady && manualLibraryAcquisition.manualLibrary) {
      const library = manualLibraryAcquisition.manualLibrary;
      const storageUrl = library.storagePath || manualLibraryAcquisition.manualUrl || '';
      summary = {
        ...summary,
        matchType: 'exact_manual',
        manualReady: true,
        reviewRequired: library.approved !== true,
        status: 'docs_found',
        manualUrl: storageUrl,
        manualSourceUrl: library.sourcePageUrl || summary.manualSourceUrl || '',
        manualLibraryRef: library.id,
        manualStoragePath: library.storagePath || '',
        manualVariant: library.variant || '',
      };
      documentationSuggestions = documentationSuggestions.map((entry, index) => index === acquiredCandidateIndex ? {
        ...entry,
        url: storageUrl,
        sourcePageUrl: library.sourcePageUrl || entry.sourcePageUrl || '',
        manualLibraryRef: library.id,
        manualStoragePath: library.storagePath || '',
        cachedManual: true,
      } : entry).map(withSuggestionBucket);
    } else {
      summary = {
        ...summary,
        manualReady: false,
        status: (summary.supportUrl || supportResourcesSuggestion.length || acquisitionError) ? 'followup_needed' : 'no_match_yet',
        reviewRequired: true,
        manualUrl: '',
      };
    }
    logManualResearchEvent('ACQUISITION_RESULT', {
      ...logContext,
      title: originalTitle,
      normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
      manufacturer: summary.manufacturer || stageOne.manufacturer,
      acquisitionState,
      manualReady: summary.manualReady === true,
      manualLibraryRef: summary.manualLibraryRef || '',
      manualStoragePath: summary.manualStoragePath || '',
      acquisitionError,
    });
    const terminalStateReason = summary.manualReady === true
      ? 'docs_found_after_durable_storage'
      : (acquisitionError ? `acquisition_failed:${acquisitionError}` : `no_durable_manual:${acquisitionState}`);
    logManualResearchEvent('TERMINAL_STATUS_REASON', {
      ...logContext,
      title: originalTitle,
      normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
      manufacturer: summary.manufacturer || stageOne.manufacturer,
      terminalStateReason,
    });

    logManualResearchEvent('final_result', {
      ...logContext,
      title: originalTitle,
      normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
      manufacturer: summary.manufacturer || stageOne.manufacturer,
      stage1MatchType: stageOne.summary.matchType,
      ranStage2: true,
      candidateManualCount: Array.isArray(documentationSuggestions) ? documentationSuggestions.length : 0,
      rejectedCandidateCount: Math.max(0, (Array.isArray(documentationSuggestions) ? documentationSuggestions.length : 0) - cleanCount(documentationSuggestions)),
      acceptedManualCount: cleanCount(documentationSuggestions),
      finalMatchType: summary.matchType,
      finalManualReady: summary.manualReady === true,
      supportCandidateCount: supportResourcesSuggestion.length,
      researchSourceType: summary.researchSourceType,
      manualLibraryRef: summary.manualLibraryRef || '',
      manualStoragePath: summary.manualStoragePath || '',
      acquisitionState,
      terminalStateReason,
      elapsedMs: Date.now() - startedAt,
    });

    results.push({
      ...summary,
      originalTitle,
      normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
      canonicalTitleFamily: summary.canonicalTitleFamily || stageOne.canonicalTitleFamily,
      manufacturer: summary.manufacturer || stageOne.manufacturer || '',
      manufacturerInferred: typeof summary.manufacturerInferred === 'boolean' ? summary.manufacturerInferred : stageOne.manufacturerInferred,
      citations: sanitizeCitations(summary.citations),
      documentationSuggestions: documentationSuggestions.map(withSuggestionBucket),
      supportResourcesSuggestion: supportResourcesSuggestion.map(withSuggestionBucket),
      supportContactsSuggestion,
      manualMatchSummary: {
        ...summary,
      },
      pipelineMeta: {
        stage1MatchType: stageOne.summary.matchType || '',
        stage2Ran: true,
        sourcePageExtracted: Array.isArray(documentationSuggestions) && documentationSuggestions.some((entry) => !!`${entry?.sourcePageUrl || ''}`.trim()),
        acquisitionSucceeded: summary.manualReady === true && !!`${summary.manualLibraryRef || ''}`.trim(),
        acquisitionState,
        acquisitionError,
        manualLibraryRef: summary.manualLibraryRef || '',
        manualStoragePath: summary.manualStoragePath || '',
        searchEvidence: Array.isArray(stageOne.searchEvidence) ? stageOne.searchEvidence : [],
        returnedCandidates: stage2ReturnedCandidates,
        selectedCandidate: stage2SelectedCandidate,
        stage2CandidateAudit,
        terminalStateReason,
      },
      locationId: normalizeString(locationId, 120),
      manualLibraryRef: summary.manualLibraryRef || '',
      manualVariant: summary.manualVariant || '',
      manualStoragePath: summary.manualStoragePath || '',
      manualLinks: summary.manualUrl ? [summary.manualUrl] : [],
    });
  }

  return {
    ok: true,
    companyId,
    locationId: normalizeString(locationId, 120),
    results,
  };
}

function cleanCount(documentationSuggestions = []) {
  return (Array.isArray(documentationSuggestions) ? documentationSuggestions : [])
    .filter((entry) => entry?.verified && entry?.exactManualMatch)
    .length;
}

function shouldRunFallbackScraping({
  returnedCandidates = [],
  acceptedManualCandidateCount = 0,
} = {}) {
  if (acceptedManualCandidateCount > 0) return false;
  if (!Array.isArray(returnedCandidates) || !returnedCandidates.length) return true;
  return returnedCandidates.every((candidate = {}) => OPENAI_WEAK_CANDIDATE_BUCKETS.has(`${candidate.bucket || ''}`.trim()));
}

module.exports = {
  FALLBACK_MATCH_TYPES,
  buildDomainAllowlist,
  researchAssetTitles,
};
