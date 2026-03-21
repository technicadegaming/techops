const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  requestManualResearchFallback,
} = require('./openaiService');
const {
  discoverManualDocumentation,
} = require('./manualDiscoveryService');
const {
  findCatalogManualMatch,
} = require('./manualLookupCatalogService');
const {
  resolveArcadeTitleFamily,
  normalizeManufacturerName,
} = require('./arcadeTitleAliasService');
const {
  getManufacturerProfile,
  normalizeDocumentationSuggestions,
  verifyDocumentationSuggestions,
  mergeDocumentationSuggestions,
  findReusableVerifiedManuals,
  classifyManualMatchSummary,
} = require('./assetEnrichmentService');

const FALLBACK_MATCH_TYPES = new Set([
  'title_specific_source',
  'support_only',
  'family_match_needs_review',
  'unresolved',
]);

const CACHE_COLLECTION = 'assetTitleResearchCache';
const MAX_TITLE_BATCH = 50;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

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

  if (result.manualUrl) {
    documentationSuggestions.push({
      title: normalizeString(result.manualTitle || result.originalTitle || result.normalizedTitle || '', 160),
      url: result.manualUrl,
      sourceType: trustedSource ? 'manufacturer' : 'other',
      exactTitleMatch: true,
      exactManualMatch: result.manualReady === true,
      trustedSource,
      matchType: result.matchType,
      sourcePageUrl: result.manualSourceUrl || '',
      citations,
      rawResearchSummary: result.rawResearchSummary || '',
    });
  }
  if (result.manualSourceUrl) {
    supportResourcesSuggestion.push({
      label: normalizeString(result.manualSourceTitle || result.normalizedTitle || result.originalTitle || '', 160),
      url: result.manualSourceUrl,
      resourceType: 'support',
      sourceType: trustedSource ? 'manufacturer' : 'other',
      citations,
    });
  }
  if (result.supportUrl) {
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
  maxWebSources = 5,
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

  const discovered = await discoverManualDocumentation({
    assetName: input.originalTitle,
    normalizedName: normalizedTitle,
    manufacturer,
    manufacturerProfile,
    searchHints: [],
    logger: console,
    traceId: `manual-research-stage1-${Date.now()}`,
    fetchImpl,
  });
  const discoveredDocumentationSuggestions = normalizeDocumentationSuggestions({
    links: (discovered.documentationLinks || []).slice(0, Math.max(1, maxWebSources)),
    confidence: 0.6,
    asset: { name: input.originalTitle, manufacturer },
    normalizedName: normalizedTitle,
    manufacturerSuggestion: manufacturer,
  });
  const documentationSuggestions = mergeDocumentationSuggestions({
    existingSuggestions: [...verifiedCatalogSuggestions, ...reusedSuggestions],
    nextSuggestions: discoveredDocumentationSuggestions,
    preserveExistingCandidates: true,
  });
  const supportResourcesSuggestion = normalizeDocumentationSuggestions({
    links: [
      ...(catalogMatch?.supportResources || []),
      ...(discovered.supportResources || []).slice(0, Math.max(1, maxWebSources)),
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
    documentationSuggestions,
    supportResourcesSuggestion,
    supportContactsSuggestion: [],
    summary,
    catalogMatch,
    stage: 'stage1',
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
  const vectorStoreIds = includeInternalDocs !== false
    ? (Array.isArray(settings.manualResearchVectorStoreIds) ? settings.manualResearchVectorStoreIds : [])
    : [];
  const cached = await loadCachedResearchResult({
    db,
    companyId,
    normalizedTitle: stageOne.normalizedTitle,
    manufacturer: stageOne.manufacturer,
  });
  if (cached) return { ...cached, sourceType: 'cache' };

  const allowedDomains = buildDomainAllowlist({
    manufacturerProfile: stageOne.manufacturerProfile,
    titleFamily: stageOne.titleFamily,
  });

  const result = await researchFallback({
    model: settings.manualResearchModel || settings.aiModel || 'gpt-5',
    reasoningEffort: settings.manualResearchReasoningEffort || 'low',
    traceId,
    maxWebSources,
    webSearchEnabled: settings.manualResearchWebSearchEnabled !== false,
    fileSearchEnabled: settings.manualResearchFileSearchEnabled !== false,
    vectorStoreIds,
    context: {
      companyId,
      originalTitle: input.originalTitle,
      normalizedTitle: stageOne.normalizedTitle,
      manufacturerHint: input.manufacturerHint || '',
      stageOneSummary: stageOne.summary,
      allowedDomains,
      includeInternalDocs: includeInternalDocs !== false,
    },
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
}) {
  if (!companyId) throw new HttpsError('invalid-argument', 'companyId is required');
  if (!Array.isArray(titles) || !titles.length) throw new HttpsError('invalid-argument', 'titles is required');
  if (titles.length > MAX_TITLE_BATCH) throw new HttpsError('invalid-argument', `titles must contain at most ${MAX_TITLE_BATCH} entries`);

  const results = [];
  for (const row of titles) {
    const originalTitle = normalizeString(row?.originalTitle || '', 160);
    if (!originalTitle) continue;
    const stageOne = await runStageOneLookup({
      db,
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

    if (FALLBACK_MATCH_TYPES.has(stageOne.summary.matchType)) {
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
      }).catch(() => null);
      if (stageTwo) {
        const mapped = mapResearchResultToSuggestions(stageTwo, stageOne.manufacturerProfile);
        documentationSuggestions = mergeDocumentationSuggestions({
          existingSuggestions: documentationSuggestions,
          nextSuggestions: mapped.documentationSuggestions,
          preserveExistingCandidates: true,
        });
        supportResourcesSuggestion = normalizeDocumentationSuggestions({
          links: [...supportResourcesSuggestion, ...mapped.supportResourcesSuggestion],
          confidence: Number(stageTwo.confidence || stageOne.summary.confidence || 0),
          asset: { name: originalTitle, manufacturer: stageTwo.manufacturer || stageOne.manufacturer },
          normalizedName: stageTwo.normalizedTitle || stageOne.normalizedTitle,
          manufacturerSuggestion: stageTwo.manufacturer || stageOne.manufacturer,
          kind: 'support',
        });
        supportContactsSuggestion = [
          ...(stageTwo.supportEmail ? [{ label: 'Support email', value: stageTwo.supportEmail, contactType: 'email' }] : []),
          ...(stageTwo.supportPhone ? [{ label: 'Support phone', value: stageTwo.supportPhone, contactType: 'phone' }] : []),
        ];
        summary = {
          ...summary,
          ...stageTwo,
          originalTitle,
          manualUrl: stageTwo.manualUrl || summary.manualUrl || '',
          manualSourceUrl: stageTwo.manualSourceUrl || summary.manualSourceUrl || '',
          supportUrl: stageTwo.supportUrl || summary.supportUrl || '',
          supportEmail: stageTwo.supportEmail || '',
          supportPhone: stageTwo.supportPhone || '',
          matchType: stageTwo.matchType || summary.matchType,
          manualReady: stageTwo.manualReady === true,
          reviewRequired: typeof stageTwo.reviewRequired === 'boolean' ? stageTwo.reviewRequired : !stageTwo.manualReady,
          variantWarning: stageTwo.variantWarning || summary.variantWarning || '',
          confidence: Number(stageTwo.confidence || summary.confidence || 0),
          matchNotes: stageTwo.matchNotes || summary.matchNotes || '',
          citations: sanitizeCitations(stageTwo.citations),
          rawResearchSummary: stageTwo.rawResearchSummary || '',
          researchTimestamp: new Date().toISOString(),
          researchSourceType: stageTwo.sourceType || 'responses_api',
        };
      }
    }

    results.push({
      ...summary,
      originalTitle,
      normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
      canonicalTitleFamily: summary.canonicalTitleFamily || stageOne.canonicalTitleFamily,
      manufacturer: summary.manufacturer || stageOne.manufacturer || '',
      manufacturerInferred: typeof summary.manufacturerInferred === 'boolean' ? summary.manufacturerInferred : stageOne.manufacturerInferred,
      citations: sanitizeCitations(summary.citations),
      documentationSuggestions,
      supportResourcesSuggestion,
      supportContactsSuggestion,
      manualMatchSummary: {
        ...summary,
      },
      locationId: normalizeString(locationId, 120),
    });
  }

  return {
    ok: true,
    companyId,
    locationId: normalizeString(locationId, 120),
    results,
  };
}

module.exports = {
  FALLBACK_MATCH_TYPES,
  buildDomainAllowlist,
  researchAssetTitles,
};
