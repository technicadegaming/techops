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
  const manualUrl = normalizeUrl(result.manualUrl || '');
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

  if (manualUrl && explicitManualContract && manualLikeUrl) {
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

    logManualResearchEvent('stage1_result', {
      title: originalTitle,
      normalizedTitle: stageOne.normalizedTitle,
      manufacturer: stageOne.manufacturer,
      stage1MatchType: stageOne.summary.matchType,
      ranStage2: false,
      candidateManualCount: cleanCount(stageOne.documentationSuggestions),
      supportCandidateCount: stageOne.supportResourcesSuggestion.length,
      finalManualReady: stageOne.summary.manualReady === true,
    });

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
      }).catch((error) => {
        logManualResearchEvent('stage2_validation_failed', {
          title: originalTitle,
          normalizedTitle: stageOne.normalizedTitle,
          manufacturer: stageOne.manufacturer,
          stage1MatchType: stageOne.summary.matchType,
          ranStage2: true,
          reason: normalizeString(error?.message || String(error), 220),
        });
        return null;
      });
      if (stageTwo) {
        const mapped = mapResearchResultToSuggestions(stageTwo, stageOne.manufacturerProfile);
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
        if (stageTwo.manualUrl && !normalizedStageTwoDocs.length) {
          logManualResearchEvent('candidate_rejected', {
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
          title: originalTitle,
          normalizedTitle: stageOne.normalizedTitle,
          manufacturer: stageTwo.manufacturer || stageOne.manufacturer,
          stage1MatchType: stageOne.summary.matchType,
          ranStage2: true,
          candidateCount: normalizedStageTwoDocs.length,
          rejectedCandidateCount: Math.max(0, normalizedStageTwoDocs.length - verifiedStageTwoDocs.filter((entry) => entry.verified && entry.exactManualMatch).length),
          acceptedManualCandidateCount: verifiedStageTwoDocs.filter((entry) => entry.verified && entry.exactManualMatch).length,
          supportCandidateCount: mapped.supportResourcesSuggestion.length,
        });
        verifiedStageTwoDocs
          .filter((entry) => !(entry.verified && entry.exactManualMatch))
          .forEach((entry) => {
            logManualResearchEvent('candidate_rejected', {
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
        });
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
    } else {
      logManualResearchEvent('stage2_skipped', {
        title: originalTitle,
        normalizedTitle: stageOne.normalizedTitle,
        manufacturer: stageOne.manufacturer,
        stage1MatchType: stageOne.summary.matchType,
        ranStage2: false,
        reason: 'stage1_manual_ready',
        finalMatchType: stageOne.summary.matchType,
        manualReady: stageOne.summary.manualReady === true,
      });
    }

    let manualLibraryAcquisition = null;
    let acquisitionState = 'skipped';
    let acquisitionError = '';
    if (documentationSuggestions.length) {
      acquisitionState = 'started';
      logManualResearchEvent('manual_acquisition_start', {
        title: originalTitle,
        normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
        manufacturer: summary.manufacturer || stageOne.manufacturer,
        candidateUrl: documentationSuggestions[0]?.url || '',
        sourcePageUrl: documentationSuggestions[0]?.sourcePageUrl || summary.manualSourceUrl || '',
      });
      manualLibraryAcquisition = await withTimeout(
        acquireManualToLibrary({
          db,
          storage,
          fetchImpl,
          candidate: documentationSuggestions[0],
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
        logManualResearchEvent(acquisitionState === 'timed_out' ? 'manual_acquisition_timeout' : 'manual_acquisition_failed', {
          title: originalTitle,
          normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
          manufacturer: summary.manufacturer || stageOne.manufacturer,
          reason: acquisitionError,
        });
        return null;
      });
      if (manualLibraryAcquisition) acquisitionState = manualLibraryAcquisition.manualReady ? 'succeeded' : 'no_manual';
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
      documentationSuggestions = documentationSuggestions.map((entry, index) => index === 0 ? {
        ...entry,
        url: storageUrl,
        sourcePageUrl: library.sourcePageUrl || entry.sourcePageUrl || '',
        manualLibraryRef: library.id,
        manualStoragePath: library.storagePath || '',
        cachedManual: true,
      } : entry);
    } else {
      summary = {
        ...summary,
        manualReady: false,
        status: (summary.supportUrl || supportResourcesSuggestion.length || acquisitionError) ? 'followup_needed' : 'no_match_yet',
        reviewRequired: true,
        manualUrl: '',
      };
    }

    logManualResearchEvent('final_result', {
      title: originalTitle,
      normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
      manufacturer: summary.manufacturer || stageOne.manufacturer,
      stage1MatchType: stageOne.summary.matchType,
      ranStage2: FALLBACK_MATCH_TYPES.has(stageOne.summary.matchType),
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
      documentationSuggestions,
      supportResourcesSuggestion,
      supportContactsSuggestion,
      manualMatchSummary: {
        ...summary,
      },
      pipelineMeta: {
        stage1MatchType: stageOne.summary.matchType || '',
        stage2Ran: FALLBACK_MATCH_TYPES.has(stageOne.summary.matchType),
        sourcePageExtracted: Array.isArray(documentationSuggestions) && documentationSuggestions.some((entry) => !!`${entry?.sourcePageUrl || ''}`.trim()),
        acquisitionSucceeded: summary.manualReady === true && !!`${summary.manualLibraryRef || ''}`.trim(),
        acquisitionState,
        acquisitionError,
        manualLibraryRef: summary.manualLibraryRef || '',
        manualStoragePath: summary.manualStoragePath || '',
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

module.exports = {
  FALLBACK_MATCH_TYPES,
  buildDomainAllowlist,
  researchAssetTitles,
};
