const admin = require('firebase-admin');
const { createHash } = require('node:crypto');
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
  TIER: CANDIDATE_TIER,
  classifyCandidateTier,
  buildRankedCandidate,
  compareRankedCandidates,
  normalizeUrlKey,
} = require('./manualCandidateRankingService');
const {
  findCatalogManualMatch,
} = require('./manualLookupCatalogService');
const {
  findTrustedCatalogManualMatch,
  toTrustedCatalogSuggestion,
  DEFAULT_CONFIDENCE_THRESHOLD: TRUSTED_CATALOG_DEFAULT_CONFIDENCE_THRESHOLD,
} = require('./trustedManualCatalogService');
const {
  findManualLookupReferenceHints,
} = require('./manualLookupReferenceService');
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
const MANUFACTURER_ONLY_FOLLOWUP_QUESTION = 'Manufacturer is already confirmed. What exact model/title/version or cabinet nameplate text is printed on the game?';
const TRUSTED_CATALOG_MIN_CONFIDENCE = TRUSTED_CATALOG_DEFAULT_CONFIDENCE_THRESHOLD;

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

function normalizeUrlArray(values = [], max = 20) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeUrl(value))
    .filter(Boolean))).slice(0, max);
}

function fingerprint(value = '') {
  const normalized = normalizeString(value, 500).toLowerCase();
  if (!normalized) return '';
  return createHash('sha1').update(normalized).digest('hex');
}

function isManufacturerOnlyFollowupAnswer({ followupAnswer = '', knownManufacturer = '' } = {}) {
  const manufacturerNorm = normalizeManufacturerName(knownManufacturer || '');
  if (!manufacturerNorm) return false;
  const manufacturerTokens = normalizeString(manufacturerNorm, 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  if (!manufacturerTokens.length) return false;

  const answerTokens = normalizeString(followupAnswer, 240)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  if (!answerTokens.length) return false;

  const ignored = new Set(['it', 'its', 'is', 'the', 'a', 'an', 'maker', 'manufacturer', 'made', 'by', 'from', 'brand']);
  const evidenceTokens = answerTokens.filter((token) => !ignored.has(token));
  if (!evidenceTokens.length) return false;
  return evidenceTokens.every((token) => manufacturerTokens.includes(token));
}

function classifyFallbackTerminalReason({ stage2ErrorCode = '', fallbackDiagnostics = {}, documentationCount = 0, supportCount = 0 } = {}) {
  const reasonCode = normalizeString(stage2ErrorCode, 80).toLowerCase();
  const discoveryTerminalReason = normalizeString(fallbackDiagnostics?.terminalReason || '', 120).toLowerCase();
  const referenceManualUrlProbeCount = Number(fallbackDiagnostics?.referenceManualUrlProbeCount || 0);
  const referenceSourcePageProbeCount = Number(fallbackDiagnostics?.referenceSourcePageProbeCount || 0);
  const referenceSupportPageProbeCount = Number(fallbackDiagnostics?.referenceSupportPageProbeCount || 0);
  const referenceProbeCount = referenceManualUrlProbeCount + referenceSourcePageProbeCount + referenceSupportPageProbeCount;
  const referenceRowCandidateValidatedCount = Number(fallbackDiagnostics?.referenceRowCandidateValidatedCount || 0);
  if (Number(fallbackDiagnostics?.searchTimeoutCount || 0) > 0) return 'site_timeout';
  if (discoveryTerminalReason === 'deterministic-search-no-results') return 'deterministic-search-no-results';
  if (discoveryTerminalReason === 'close_title_specific_hit_no_manual_extracted') return 'close_title_specific_hit_no_manual_extracted';
  if (discoveryTerminalReason === 'title_page_found_manual_probe_failed') return 'title_page_found_manual_probe_failed';
  if (discoveryTerminalReason === 'candidate_found_but_not_durable') return 'candidate_found_but_not_durable';
  if (discoveryTerminalReason === 'generic-search-page-only') return 'generic-search-page-only';
  if (discoveryTerminalReason === 'reference_row_not_matched') return 'reference_row_not_matched';
  if (Number(fallbackDiagnostics?.referenceManualUrl404Count || 0) > 0
    && referenceManualUrlProbeCount > 0
    && referenceRowCandidateValidatedCount <= 0) return 'reference-manual-url-404';
  if (referenceSourcePageProbeCount > 0
    && referenceRowCandidateValidatedCount <= 0
    && Number(fallbackDiagnostics?.referenceSourcePageNoManualCount || 0) > 0) {
    return 'reference-source-page-no-manual-link';
  }
  if (referenceSupportPageProbeCount > 0
    && referenceRowCandidateValidatedCount <= 0
    && Number(fallbackDiagnostics?.referenceSupportPageNoManualCount || 0) > 0) {
    return 'reference-support-page-no-manual-link';
  }
  if (referenceProbeCount > 0
    && referenceRowCandidateValidatedCount <= 0) {
    return 'reference_row_match_no_live_manual';
  }
  if (!documentationCount && !supportCount && Number(fallbackDiagnostics?.searchNoResultsCount || 0) > 0) return 'deterministic-search-no-results';
  if (discoveryTerminalReason === 'guessed-pdf-404-no-better-candidate') return 'guessed-pdf-404-no-better-candidate';
  if (normalizeString(fallbackDiagnostics?.manufacturer || '', 80)
    && Number(fallbackDiagnostics?.searchNoResultsCount || 0) > 0) {
    return 'manufacturer-adapter-no-better-candidate';
  }
  if ((reasonCode === 'openai-config-missing' || reasonCode === 'openai-auth-invalid') && !documentationCount && !supportCount) return '';
  return '';
}

function buildPipelineTrace({ originalTitle = '', stageOne = {}, row = {} } = {}) {
  return {
    schemaVersion: 'manual-research-trace-v1',
    stages: {},
    continuity: {
      workbookDirectManualUrl: normalizeUrl(stageOne?.summary?.manualUrl || ''),
      workbookSourcePageUrl: normalizeUrl(stageOne?.summary?.manualSourceUrl || ''),
      workbookSupportPageUrl: normalizeUrl(stageOne?.summary?.supportUrl || ''),
      referenceManualUrl: normalizeUrl(stageOne?.referenceHints?.manualUrl || ''),
      referenceSourcePageUrl: normalizeUrl(stageOne?.referenceHints?.manualSourceUrl || ''),
      referenceSupportPageUrl: normalizeUrl(stageOne?.referenceHints?.supportUrl || ''),
      titlePageDiscoveredManualLinks: [],
      brochureClassifiedUrls: [],
      deadLinkSuppressionUrls: [],
      continuationCandidateUrls: [],
      continuationCandidatesUsed: false,
      referenceHintsExpected: row?.referenceHintsExpected === true,
      normalizedHintBundle: stageOne?.normalizedHintBundle || null,
    },
    diagnostics: {},
    summary: {
      originalTitle: normalizeString(originalTitle, 160),
      normalizedTitle: normalizeString(stageOne?.normalizedTitle || originalTitle, 160),
      manufacturer: normalizeString(stageOne?.manufacturer || '', 120),
    },
  };
}

function buildNormalizedHintBundle({
  originalTitle = '',
  normalizedTitle = '',
  manufacturer = '',
  titleFamily = null,
  referenceHints = null,
  referenceHintSource = 'none',
  referenceEntryKey = '',
  rowHintSource = '',
} = {}) {
  return {
    input: {
      originalTitle: normalizeString(originalTitle, 180),
      normalizedTitle: normalizeString(normalizedTitle || originalTitle, 180),
      manufacturer: normalizeManufacturerName(manufacturer || ''),
      aliases: Array.from(new Set(expandArcadeTitleAliases([
        originalTitle,
        normalizedTitle,
        ...(Array.isArray(titleFamily?.alternateTitles) ? titleFamily.alternateTitles : []),
      ]).map((value) => normalizeString(value, 180)).filter(Boolean))).slice(0, 20),
      familyTitles: Array.from(new Set([
        normalizeString(titleFamily?.canonicalTitle || '', 180),
        normalizeString(titleFamily?.familyTitle || '', 180),
      ].filter(Boolean))).slice(0, 10),
    },
    hints: referenceHints ? {
      source: normalizeString(referenceHintSource || 'json_index', 80) || 'json_index',
      entryKey: normalizeString(referenceEntryKey || '', 180),
      rowHintSource: normalizeString(rowHintSource || '', 80),
      lookupRowsUsed: Number(referenceHints.lookupRowsUsed || 0),
      preferredManufacturerDomains: Array.isArray(referenceHints.preferredManufacturerDomains)
        ? referenceHints.preferredManufacturerDomains.slice(0, 12)
        : [],
      likelySlugPatterns: Array.isArray(referenceHints.likelySlugPatterns)
        ? referenceHints.likelySlugPatterns.slice(0, 20)
        : [],
      likelyManualFilenamePatterns: Array.isArray(referenceHints.likelyManualFilenamePatterns)
        ? referenceHints.likelyManualFilenamePatterns.slice(0, 20)
        : [],
      referenceRowCandidates: Array.isArray(referenceHints.referenceRowCandidates)
        ? referenceHints.referenceRowCandidates.slice(0, 30)
        : [],
    } : null,
  };
}

function recordTraceStage({ trace = null, stage = '', payload = {}, logContext = {} } = {}) {
  if (!trace || !stage) return;
  trace.stages[stage] = payload;
  logManualResearchEvent('pipeline_trace_stage', {
    ...logContext,
    stage,
    payload,
  });
}

function deriveDetailedTerminalReason({
  summary = {},
  fallbackTerminalReason = '',
  fallbackDiagnostics = {},
  stageOne = {},
  acquisitionEligible = false,
  acquisitionAttempted = false,
  acquisitionState = '',
  acquisitionError = '',
  acquisitionSkippedReason = '',
  documentationSuggestions = [],
  continuationSuggestions = [],
  continuationUsed = false,
  deterministicCandidateState = null,
  deadCandidateUrls = new Set(),
} = {}) {
  if (summary.manualReady === true) return 'docs_found_after_durable_storage';
  if (fallbackTerminalReason === 'title_page_found_manual_probe_failed') return 'title_page_found_no_extractable_manual_links';
  if (fallbackTerminalReason) return fallbackTerminalReason;
  if (stageOne.referenceHintSource === 'none' && stageOne.referenceHintsExpected === true) {
    return 'reference_hints_expected_but_not_loaded';
  }
  const referenceProbeCount = Number(fallbackDiagnostics?.referenceManualUrlProbeCount || 0)
    + Number(fallbackDiagnostics?.referenceSourcePageProbeCount || 0)
    + Number(fallbackDiagnostics?.referenceSupportPageProbeCount || 0);
  if (stageOne.referenceHints && referenceProbeCount === 0) return 'reference_hints_loaded_but_no_reference_probes_started';
  if (!acquisitionEligible && documentationSuggestions.length > 0) {
    if (documentationSuggestions.some((entry) => isBrochureLikeCandidate(entry)) && continuationSuggestions.length === 0) {
      return 'brochure_selected_no_manual_continuation_used';
    }
    return 'valid_candidate_selected_but_not_acquisition_eligible';
  }
  if (acquisitionAttempted && (acquisitionState === 'failed' || acquisitionState === 'timed_out' || acquisitionError)) {
    return 'acquisition_attempt_failed_after_valid_candidate';
  }
  if (deadCandidateUrls.size > 0
    && deterministicCandidateState?.deterministicCandidateType === 'workbook_seed_exact_pdf'
    && continuationSuggestions.length === 0) {
    return 'dead_seeded_pdf_no_continuation_used';
  }
  if (continuationSuggestions.length > 0 && !continuationUsed && !summary.manualReady) {
    return 'continuation_candidates_generated_but_not_used';
  }
  if (acquisitionAttempted && !summary.manualReady) return 'terminalized_after_continuation_exhaustion';
  if (!deterministicCandidateState?.found && Number(fallbackDiagnostics?.providerFallbackInvoked ? 1 : 0) > 0) {
    return 'provider_only_fallback_used_due_to_missing_deterministic_state';
  }
  if (deadCandidateUrls.size > 0 && documentationSuggestions.length === 0) return 'dead-candidate-only';
  return `no_durable_manual:${acquisitionState || acquisitionSkippedReason || 'unknown'}`;
}

function prioritizeDocumentationSuggestions({
  documentationSuggestions = [],
  deadCandidateUrls = new Set(),
  logContext = {},
  logEvent = () => {},
} = {}) {
  const deadSet = deadCandidateUrls instanceof Set ? deadCandidateUrls : new Set();
  const rows = (Array.isArray(documentationSuggestions) ? documentationSuggestions : []).map((entry, index) => {
    const ranked = buildRankedCandidate(entry, { deadCandidateUrls: deadSet });
    logEvent('candidate_rank_assigned', {
      ...logContext,
      candidateUrl: entry?.url || '',
      candidateRankTier: ranked.tier,
      candidateDead: ranked.dead,
      candidateScore: ranked.score,
      candidateIndex: index,
    });
    return { ...ranked, index };
  });
  const hasNonBrochureLiveCandidate = rows.some((row) => !row.dead && !isBrochureLikeCandidate(row.candidate));
  if (hasNonBrochureLiveCandidate) {
    rows.forEach((row) => {
      if (!row.dead && isBrochureLikeCandidate(row.candidate)) {
        row.tierRank = Math.max(row.tierRank, 6);
        row.score -= 60;
        logEvent('brochure_candidate_excluded_from_final_selection', {
          ...logContext,
          candidateUrl: row.candidate?.url || '',
          candidateTier: row.tier,
          reason: 'brochure_hard_ineligible_for_final_manual_selection',
        });
      }
    });
  }
  rows.sort(compareRankedCandidates);
  const deadRows = rows.filter((row) => row.dead);
  const staleTopDead = deadRows[0] || null;
  deadRows.forEach((row) => {
    logEvent('stale_candidate_pre_demoted', {
      ...logContext,
      candidateUrl: row.candidate?.url || '',
      candidateTier: row.tier,
    });
  });
  const bestDiscovered = rows.find((row) => row.exactTitle && row.discovered && !row.dead);
  const bestWeak = rows.find((row) => !row.dead && (row.tier === CANDIDATE_TIER.GENERIC_BRAND_OR_LIBRARY_PAGE || row.tier === CANDIDATE_TIER.GENERATED_VENDOR_GUESS));
  const deadGuessed = rows.find((row) => row.dead);
  let top = rows[0] || null;
  if (bestDiscovered) {
    logEvent('best_exact_title_candidate_found', {
      ...logContext,
      candidateUrl: bestDiscovered.candidate?.url || '',
      candidateTier: bestDiscovered.tier,
    });
  }
  const bestExtractedTitlePage = rows.find((row) => {
    const source = `${row.candidate?.discoverySource || ''}`.toLowerCase();
    return row.exactTitle && source === 'html_followup';
  });
  if (bestDiscovered && top && compareRankedCandidates(top, bestDiscovered) > 0) {
    logEvent('final_selected_weaker_than_best_discovered', {
      ...logContext,
      selectedCandidateUrl: top.candidate?.url || '',
      selectedTier: top.tier,
      bestDiscoveredCandidateUrl: bestDiscovered.candidate?.url || '',
      bestDiscoveredTier: bestDiscovered.tier,
    });
    logEvent('weaker_candidate_rejected', {
      ...logContext,
      rejectedCandidateUrl: top.candidate?.url || '',
      selectedCandidateUrl: bestDiscovered.candidate?.url || '',
    });
    const promoted = rows.find((row) => row.urlKey === bestDiscovered.urlKey);
    if (promoted) {
      rows.splice(rows.indexOf(promoted), 1);
      rows.unshift(promoted);
      top = rows[0];
      logEvent('final_candidate_selected_from_best_exact_match', {
        ...logContext,
        selectedCandidateUrl: top.candidate?.url || '',
        selectedTier: top.tier,
      });
    }
  }
  if (top?.discovered) {
    logEvent('final_candidate_selected_from_discovery', { ...logContext, selectedCandidateUrl: top.candidate?.url || '', selectedTier: top.tier });
  } else if (top) {
    logEvent('final_candidate_selected_from_research', { ...logContext, selectedCandidateUrl: top.candidate?.url || '', selectedTier: top.tier });
  }
  if (staleTopDead && top && staleTopDead.urlKey !== top.urlKey) {
    logEvent('alternate_candidate_selected_due_to_dead_cache', {
      ...logContext,
      deadCandidateUrl: staleTopDead.candidate?.url || '',
      selectedCandidateUrl: top.candidate?.url || '',
      selectedTier: top.tier,
    });
  }
  if (top && `${top.candidate?.discoverySource || ''}`.toLowerCase() === 'html_followup') {
    logEvent('final_candidate_selected_from_extracted_title_page', {
      ...logContext,
      selectedCandidateUrl: top.candidate?.url || '',
      selectedTier: top.tier,
    });
  }
  if (bestDiscovered && top && bestDiscovered.urlKey !== top.urlKey && compareRankedCandidates(bestDiscovered, top) < 0) {
    logEvent('candidate_replaced_due_to_better_exact_match', {
      ...logContext,
      previousSelectedCandidateUrl: top.candidate?.url || '',
      selectedCandidateUrl: bestDiscovered.candidate?.url || '',
    });
  }
  if (bestDiscovered && top && bestDiscovered.urlKey === top.urlKey) {
    logEvent('discovered_candidate_promoted', {
      ...logContext,
      selectedCandidateUrl: bestDiscovered.candidate?.url || '',
      selectedTier: bestDiscovered.tier,
    });
  }
  if (bestWeak && bestDiscovered && compareRankedCandidates(bestDiscovered, bestWeak) < 0) {
    logEvent('weak_candidate_demoted', {
      ...logContext,
      demotedCandidateUrl: bestWeak.candidate?.url || '',
      selectedCandidateUrl: bestDiscovered.candidate?.url || '',
      demotedTier: bestWeak.tier,
      selectedTier: bestDiscovered.tier,
    });
    logEvent('generic_candidate_demoted', {
      ...logContext,
      demotedCandidateUrl: bestWeak.candidate?.url || '',
      selectedCandidateUrl: bestDiscovered.candidate?.url || '',
    });
  }
  if (deadGuessed && top && deadGuessed.urlKey !== top.urlKey) {
    logEvent('candidate_replaced_due_to_better_exact_match', {
      ...logContext,
      previousSelectedCandidateUrl: deadGuessed.candidate?.url || '',
      selectedCandidateUrl: top.candidate?.url || '',
    });
    logEvent('guessed_candidate_demoted', {
      ...logContext,
      demotedCandidateUrl: deadGuessed.candidate?.url || '',
      selectedCandidateUrl: top.candidate?.url || '',
    });
  }
  if (bestExtractedTitlePage && top && bestExtractedTitlePage.urlKey !== top.urlKey && compareRankedCandidates(bestExtractedTitlePage, top) < 0) {
    logEvent('final_candidate_selected_from_extracted_title_page', {
      ...logContext,
      selectedCandidateUrl: bestExtractedTitlePage.candidate?.url || '',
      selectedTier: bestExtractedTitlePage.tier,
      replacedCandidateUrl: top.candidate?.url || '',
    });
  }
  return rows.map((row) => row.candidate);
}

function isDeadCandidateStatus(status = 0) {
  const code = Number(status || 0) || 0;
  return code === 404 || code === 410 || code >= 500;
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

  const exactManualPromotionEligible = manualUrl
    && explicitManualContract
    && !hasJunkManualCandidateUrl(manualUrl)
    && (
      manualLikeUrl
      || result.matchType === 'exact_manual'
      || result.manualReady === true
      || /\.(pdf|docx?)($|[?#])/i.test(manualUrl)
    );
  if (exactManualPromotionEligible && !documentationSuggestions.some((entry) => entry.url === manualUrl)) {
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

function deriveContinuationContext({ summary = {}, stageOne = {}, candidate = {} } = {}) {
  const referenceRows = Array.isArray(stageOne?.referenceHints?.referenceRowCandidates)
    ? stageOne.referenceHints.referenceRowCandidates
    : [];
  const firstReferenceSource = referenceRows
    .map((row = {}) => normalizeUrl(row.manualSourceUrl || row.supportUrl || row.manualUrl || ''))
    .find(Boolean) || '';
  const fallbackSource = normalizeUrl(
    candidate?.sourcePageUrl
    || summary.manualSourceUrl
    || summary.supportUrl
    || stageOne?.summary?.manualSourceUrl
    || stageOne?.summary?.supportUrl
    || firstReferenceSource
    || ''
  );
  return {
    sourcePageUrl: fallbackSource,
    manualSourceUrl: normalizeUrl(summary.manualSourceUrl || stageOne?.summary?.manualSourceUrl || ''),
    supportUrl: normalizeUrl(summary.supportUrl || stageOne?.summary?.supportUrl || ''),
  };
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

function isDirectManualCandidateUrl(url = '') {
  const normalized = normalizeUrl(url).toLowerCase();
  if (!normalized) return false;
  return /\.(pdf|docx?)($|[?#])/.test(normalized) || /manual|operator|service-manual|installation/.test(normalized);
}

const JUNK_SUPPORT_LINK_PATTERNS = [
  /\/(?:cart|checkout|login|register|create_account|account)\.php(?:$|[?#])/i,
  /\/shop-all-parts(?:\/|$)/i,
  /\/(?:balls|cable|cabinet-components|consumables|merchandise)(?:\/|$)/i,
  /\/(?:category|product-category)\//i,
];

function isJunkSupportResourceUrl(url = '') {
  const normalized = normalizeUrl(url);
  if (!normalized) return true;
  if (hasJunkManualCandidateUrl(normalized)) return true;
  return JUNK_SUPPORT_LINK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isBrochureLikeCandidate(candidate = {}) {
  const url = normalizeUrl(candidate?.url || '');
  return /(brochure|spec(?:ification)?(?:\s*sheet)?|sell[\s-]?sheet|flyer|catalog)/.test(`${candidate?.title || ''} ${url}`);
}

function filterSupportResourcesSuggestion(entries = [], logContext = {}) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const url = normalizeUrl(entry?.url || entry || '');
    if (!url || isJunkSupportResourceUrl(url)) {
      logManualResearchEvent('junk_support_page_rejected', {
        ...logContext,
        rejectedUrl: url || `${entry?.url || entry || ''}`,
      });
      return false;
    }
    return true;
  });
}

function buildContinuationSuggestions({
  stageOne = {},
  summary = {},
  supportResourcesSuggestion = [],
  documentationSuggestions = [],
  logContext = {},
} = {}) {
  const existingUrlKeys = new Set(
    (Array.isArray(documentationSuggestions) ? documentationSuggestions : [])
      .map((entry) => normalizeUrlKey(entry?.url || ''))
      .filter(Boolean)
  );
  const out = [];
  const pushContinuation = ({
    url = '',
    sourcePageUrl = '',
    title = '',
    discoverySource = '',
    continuationLogEvent = '',
  } = {}) => {
    const normalized = normalizeUrl(url);
    if (!normalized || hasJunkManualCandidateUrl(normalized)) return false;
    const key = normalizeUrlKey(normalized);
    if (!key || existingUrlKeys.has(key)) return false;
    existingUrlKeys.add(key);
    out.push(withSuggestionBucket({
      url: normalized,
      sourcePageUrl: normalizeUrl(sourcePageUrl || normalized),
      title: title || summary.normalizedTitle || stageOne.normalizedTitle || '',
      discoverySource: discoverySource || 'continuation_context',
      bucket: 'title_specific_support_page',
      matchType: 'manual_page_with_download',
      titleSpecificSupport: true,
      continuationCandidate: true,
    }));
    if (continuationLogEvent) {
      logManualResearchEvent(continuationLogEvent, {
        ...logContext,
        candidateUrl: normalized,
      });
    }
    return true;
  };

  const referenceRows = Array.isArray(stageOne.referenceHints?.referenceRowCandidates)
    ? stageOne.referenceHints.referenceRowCandidates
    : [];
  referenceRows.forEach((row = {}) => {
    if (row.manualSourceUrl) {
      pushContinuation({
        url: row.manualSourceUrl,
        sourcePageUrl: row.manualSourceUrl,
        title: row.originalTitle || row.normalizedTitle,
        discoverySource: 'reference_row_source_page',
        continuationLogEvent: 'reference_source_continuation_started',
      });
    }
    if (row.supportUrl) {
      pushContinuation({
        url: row.supportUrl,
        sourcePageUrl: row.supportUrl,
        title: row.originalTitle || row.normalizedTitle,
        discoverySource: 'reference_row_support_page',
        continuationLogEvent: 'support_page_continuation_started',
      });
    }
    if (row.manualUrl) {
      pushContinuation({
        url: row.manualUrl,
        sourcePageUrl: row.manualSourceUrl || row.supportUrl || summary.manualSourceUrl || summary.supportUrl || '',
        title: row.originalTitle || row.normalizedTitle,
        discoverySource: 'reference_row_manual_url_continuation',
      });
    }
  });

  if (summary.manualSourceUrl) {
    pushContinuation({
      url: summary.manualSourceUrl,
      sourcePageUrl: summary.manualSourceUrl,
      discoverySource: 'workbook_source_page_continuation',
      continuationLogEvent: 'workbook_source_continuation_started',
    });
  }
  if (summary.supportUrl) {
    pushContinuation({
      url: summary.supportUrl,
      sourcePageUrl: summary.supportUrl,
      discoverySource: 'workbook_support_page_continuation',
      continuationLogEvent: 'support_page_continuation_started',
    });
  }

  (Array.isArray(supportResourcesSuggestion) ? supportResourcesSuggestion : []).forEach((entry = {}) => {
    pushContinuation({
      url: entry.url,
      sourcePageUrl: entry.url,
      title: entry.label || entry.title || '',
      discoverySource: normalizeString(entry.discoverySource || '', 80) || 'support_resource_continuation',
      continuationLogEvent: 'support_page_continuation_started',
    });
  });

  return out;
}

function isAcquisitionEligibleCandidate(candidate = {}) {
  const tier = classifyCandidateTier(candidate);
  const url = normalizeUrl(candidate?.url || '');
  const bucket = `${candidate?.candidateBucket || candidate?.bucket || ''}`.trim().toLowerCase();
  const matchType = `${candidate?.matchType || ''}`.trim().toLowerCase();
  const supportOnlyBucket = new Set(['support_product_page', 'weak_lead', 'brochure_or_spec_doc', 'title_specific_support_page']);
  const brochureLike = isBrochureLikeCandidate({ ...candidate, url });
  const cachedManual = !!`${candidate?.manualLibraryRef || ''}`.trim() || `${candidate?.cachedManual || ''}` === 'true';
  const hasStoredPath = /^(manual-library\/|companies\/)/i.test(`${candidate?.manualStoragePath || candidate?.url || ''}`.trim());
  if (cachedManual || hasStoredPath || tier === CANDIDATE_TIER.SHARED_LIBRARY_REUSE) {
    return {
      eligible: true,
      tier,
      directManualLike: false,
      url,
    };
  }
  const directManualLike = isDirectManualCandidateUrl(url)
    || candidate?.candidateScoringFlags?.isDirectPdf === true
    || `${candidate?.resourceType || candidate?.sourceType || ''}`.trim().toLowerCase() === 'manual';
  const manualPageWithDownloadContract = (matchType === 'manual_page_with_download' || matchType === 'exact_manual')
    && !!normalizeUrl(candidate?.sourcePageUrl || candidate?.url || '');
  const validatedManualTier = [
    CANDIDATE_TIER.EXACT_TITLE_VALIDATED_MANUAL,
    CANDIDATE_TIER.EXACT_TITLE_UNVALIDATED_CANDIDATE,
    CANDIDATE_TIER.SHARED_LIBRARY_REUSE,
  ].includes(tier);
  const deterministicDirectManual = (
    normalizeString(candidate?.lookupMethod || '', 80).toLowerCase() === 'workbook_seed_exact_pdf'
    || normalizeString(candidate?.discoverySource || '', 120).toLowerCase() === 'reference_row_manual_url'
  ) && directManualLike;
  return {
    eligible: !!url && !brochureLike && (manualPageWithDownloadContract || directManualLike || deterministicDirectManual || (!supportOnlyBucket.has(bucket) && validatedManualTier)),
    tier,
    directManualLike,
    url,
  };
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
  settings = {},
  input,
  fetchImpl = fetch,
  companyId = '',
  logContext = {},
}) {
  const titleFamily = resolveArcadeTitleFamily({
    title: input.originalTitle,
    manufacturer: input.manufacturerHint || '',
  });
  const normalizedTitle = titleFamily.canonicalTitle || input.originalTitle;
  const manufacturer = normalizeManufacturerName(titleFamily.manufacturer || input.manufacturerHint || '');
  const manufacturerProfile = getManufacturerProfile(input.manufacturerHint || manufacturer, normalizedTitle);
  const trustedCatalogEnabled = settings.manualResearchEnableTrustedCatalogShortCircuit === true;

  logManualResearchEvent('reference_index_lookup_started', {
    ...logContext,
    title: input.originalTitle,
    normalizedTitle,
    manufacturer,
  });
  const referenceLookup = await findManualLookupReferenceHints({
    db,
    assetName: input.originalTitle,
    normalizedName: normalizedTitle,
    originalTitle: input.originalTitle,
    manufacturer,
    alternateNames: titleFamily.alternateTitles || [],
  });
  const referenceHints = referenceLookup?.hints || null;
  if (referenceLookup) {
    logManualResearchEvent('reference_index_entry_count', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
      entryCount: Number(referenceLookup.entryCount || 0),
    });
  }
  if (referenceHints) {
    logManualResearchEvent('reference_index_hit', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
      rowsMatched: Number(referenceHints.lookupRowsUsed || 0),
      aliasesMatched: (referenceHints.aliases || []).slice(0, 8),
    });
    logManualResearchEvent('reference_variants_added', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
      variantCount: (referenceHints.aliases || []).length + (referenceHints.familyTitles || []).length,
    });
    logManualResearchEvent('reference_row_match_expanded', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
      expandedMatchReasons: Array.isArray(referenceHints.expandedMatchReasons)
        ? referenceHints.expandedMatchReasons.slice(0, 12)
        : [],
    });
    if (Array.isArray(referenceHints.likelySlugPatterns) && referenceHints.likelySlugPatterns.length) {
      logManualResearchEvent('reference_adapter_paths_added', {
        ...logContext,
        title: input.originalTitle,
        normalizedTitle,
        manufacturer,
        slugCount: referenceHints.likelySlugPatterns.length,
      });
    }
    if (Array.isArray(referenceHints.preferredManufacturerDomains) && referenceHints.preferredManufacturerDomains.length) {
      logManualResearchEvent('reference_domain_boost_applied', {
        ...logContext,
        title: input.originalTitle,
        normalizedTitle,
        manufacturer,
        domains: referenceHints.preferredManufacturerDomains.slice(0, 6),
      });
    }
  } else {
    logManualResearchEvent('reference_index_miss', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
    });
  }

  logManualResearchEvent('trusted_catalog_lookup_started', {
    ...logContext,
    title: input.originalTitle,
    normalizedTitle,
    manufacturer,
  });
  let trustedCatalogMatch = null;
  if (!trustedCatalogEnabled) {
    logManualResearchEvent('trusted_catalog_disabled_by_default', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
    });
    logManualResearchEvent('trusted_catalog_lookup_skipped', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
      reason: 'feature_flag_disabled',
    });
  } else {
    trustedCatalogMatch = await findTrustedCatalogManualMatch({
      db,
      assetName: input.originalTitle,
      normalizedName: normalizedTitle,
      originalTitle: input.originalTitle,
      manufacturer,
      minConfidence: TRUSTED_CATALOG_MIN_CONFIDENCE,
      alternateNames: titleFamily.alternateTitles || [],
    });
  }

  if (trustedCatalogMatch?.row) {
    logManualResearchEvent('trusted_catalog_match_found', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
      trustedCatalogSourceRowId: trustedCatalogMatch.row.sourceRowId || trustedCatalogMatch.row.id || '',
      trustedCatalogConfidence: Number(trustedCatalogMatch.row.matchConfidence || 0),
      trustedCatalogManualReady: trustedCatalogMatch.row.manualReady === true,
      trustedCatalogReviewRequired: trustedCatalogMatch.row.reviewRequired === true,
    });
  } else {
    logManualResearchEvent('trusted_catalog_lookup_miss', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
    });
  }

  const trustedCatalogSuggestion = trustedCatalogMatch?.row
    ? toTrustedCatalogSuggestion(trustedCatalogMatch.row)
    : null;
  const trustedCatalogDocs = trustedCatalogEnabled && trustedCatalogSuggestion
    ? normalizeDocumentationSuggestions({
      links: trustedCatalogSuggestion.documentationSuggestions,
      confidence: Math.max(0.7, Number(trustedCatalogSuggestion.confidence || trustedCatalogMatch.row.matchConfidence || 0)),
      asset: { name: input.originalTitle, manufacturer },
      normalizedName: normalizedTitle,
      manufacturerSuggestion: manufacturer,
    })
    : [];

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

  const verifiedCatalogSuggestions = [...trustedCatalogDocs, ...catalogSuggestions].length
    ? await verifyDocumentationSuggestions([...trustedCatalogDocs, ...catalogSuggestions], fetchImpl)
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
    existingSuggestions: [...reusedSuggestions, ...verifiedCatalogSuggestions],
    nextSuggestions: [],
    preserveExistingCandidates: true,
  });
  const supportResourcesSuggestion = normalizeDocumentationSuggestions({
    links: [
      ...(trustedCatalogSuggestion?.supportResources || []),
      ...(catalogMatch?.supportResources || []),
    ],
    confidence: Math.max(0.45, Number(trustedCatalogMatch?.row?.matchConfidence || catalogMatch?.confidence || 0)),
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
    confidence: Math.max(Number(trustedCatalogMatch?.row?.matchConfidence || 0), Number(catalogMatch?.confidence || 0), documentationSuggestions[0]?.matchScore ? documentationSuggestions[0].matchScore / 100 : 0),
    catalogMatch,
  });

  const trustedCatalogSelected = trustedCatalogMatch?.highConfidenceSelected === true;
  if (trustedCatalogSelected) {
    logManualResearchEvent('trusted_catalog_match_selected', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
      trustedCatalogSourceRowId: trustedCatalogMatch.row.sourceRowId || trustedCatalogMatch.row.id || '',
      trustedCatalogCandidateUrl: trustedCatalogMatch.row.manualUrl || '',
      trustedCatalogConfidence: Number(trustedCatalogMatch.row.matchConfidence || 0),
    });
  } else if (trustedCatalogMatch?.row) {
    logManualResearchEvent('trusted_catalog_match_review_only', {
      ...logContext,
      title: input.originalTitle,
      normalizedTitle,
      manufacturer,
      trustedCatalogSourceRowId: trustedCatalogMatch.row.sourceRowId || trustedCatalogMatch.row.id || '',
      trustedCatalogCandidateUrl: trustedCatalogMatch.row.manualUrl || trustedCatalogMatch.row.manualSourceUrl || trustedCatalogMatch.row.supportUrl || '',
      trustedCatalogConfidence: Number(trustedCatalogMatch.row.matchConfidence || 0),
    });
  }

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
    trustedCatalogMatch,
    trustedCatalogSelected,
    trustedCatalogSuggestion,
    referenceHints: referenceHints ? { ...referenceHints, source: referenceLookup?.source || 'json_index' } : null,
    referenceHintSource: referenceLookup?.source || 'none',
    referenceEntryKey: referenceLookup?.entry?.entryKey || '',
    referenceHit: !!referenceHints,
    discoverySkippedBecauseTrustedCatalogMatched: trustedCatalogEnabled && trustedCatalogSelected,
    searchEvidence: [],
    stage: 'stage1',
    normalizedHintBundle: buildNormalizedHintBundle({
      originalTitle: input.originalTitle,
      normalizedTitle,
      manufacturer,
      titleFamily,
      referenceHints,
      referenceHintSource: referenceLookup?.source || 'none',
      referenceEntryKey: referenceLookup?.entry?.entryKey || '',
    }),
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
    searchHints: [
      ...((stageOne.referenceHints?.preferredManufacturerDomains || []).map((domain) => `site:${domain}`)),
      ...(stageOne.referenceHints?.likelyManualFilenamePatterns || []),
    ],
    searchProviderOptions: {
      primarySearchProvider: settings.manualResearchPrimarySearchProvider || '',
      serpApiKey: settings.manualResearchSerpApiKey || process.env.SERPAPI_API_KEY || '',
      bingApiKey: settings.manualResearchBingApiKey || process.env.BING_SEARCH_API_KEY || '',
      bingEndpoint: settings.manualResearchBingEndpoint || process.env.BING_SEARCH_ENDPOINT || '',
    },
    logger: console,
    traceId: `manual-research-fallback-${Date.now()}`,
    fetchImpl,
    referenceHints: stageOne.referenceHints || null,
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
    fallbackDiagnostics: discovered.diagnostics || {},
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
    const followupQuestionKeyPrev = normalizeString(row?.followupQuestionKey || row?.previousFollowupQuestionKey || '', 120);
    const consumedAnswerFingerprintPrev = normalizeString(row?.consumedFollowupAnswerFingerprint || row?.followupAnswerFingerprint || '', 120);
    const followupAnswer = normalizeString(row?.followupAnswer || '', 500);
    const followupAnswerFingerprint = fingerprint(followupAnswer);
    const previousCandidateFingerprint = normalizeString(row?.previousCandidateFingerprint || '', 120);
    const previousRawCandidateFingerprint = normalizeString(row?.previousRawCandidateFingerprint || '', 120);
    const previousQueryPlanFingerprint = normalizeString(row?.previousQueryPlanFingerprint || '', 120);
    const persistedDeadCandidateUrls = new Set(
      (Array.isArray(row?.deadCandidateUrls) ? row.deadCandidateUrls : [])
        .map((value) => normalizeUrlKey(value))
        .filter(Boolean),
    );
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
      logContext,
    });
    if (!stageOne.referenceHints) {
      const rowReferenceRows = Array.isArray(row?.referenceRowCandidates)
        ? row.referenceRowCandidates
        : (Array.isArray(row?.manualLookupReferenceRows) ? row.manualLookupReferenceRows : []);
      const fallbackReferenceHints = rowReferenceRows.length
        ? {
          source: normalizeString(row?.referenceHintSource || row?.manualLookupReferenceHintSource || '', 80) || 'row_rehydrated',
          entryKey: normalizeString(row?.referenceEntryKey || row?.manualLookupReferenceEntryKey || '', 160),
          referenceRowCandidates: rowReferenceRows.map((entry = {}) => ({
            sourceRowId: normalizeString(entry.sourceRowId || entry.rowId || '', 160),
            manufacturer: normalizeString(entry.manufacturer || stageOne.manufacturer || '', 160),
            originalTitle: normalizeString(entry.originalTitle || originalTitle, 220),
            normalizedTitle: normalizeString(entry.normalizedTitle || stageOne.normalizedTitle || originalTitle, 220),
            manualUrl: normalizeUrl(entry.manualUrl || ''),
            manualSourceUrl: normalizeUrl(entry.manualSourceUrl || ''),
            supportUrl: normalizeUrl(entry.supportUrl || ''),
          })),
          preferredManufacturerDomains: normalizeUrlArray(row?.referenceDomainsUsed || row?.referenceDomains || [], 8).map((value) => {
            try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
          }).filter(Boolean),
          likelySlugPatterns: Array.isArray(row?.referenceSlugPatternsUsed) ? row.referenceSlugPatternsUsed.slice(0, 12) : [],
        }
        : null;
      if (fallbackReferenceHints) {
        stageOne.referenceHints = fallbackReferenceHints;
        stageOne.referenceHintSource = fallbackReferenceHints.source;
        stageOne.referenceHit = true;
        stageOne.referenceEntryKey = fallbackReferenceHints.entryKey || stageOne.referenceEntryKey || '';
        logManualResearchEvent('reference_hint_rehydrated_from_row', {
          ...logContext,
          referenceHintSource: stageOne.referenceHintSource,
          referenceEntryKey: stageOne.referenceEntryKey,
          referenceRowCandidateCount: fallbackReferenceHints.referenceRowCandidates.length,
        });
        stageOne.normalizedHintBundle = buildNormalizedHintBundle({
          originalTitle,
          normalizedTitle: stageOne.normalizedTitle,
          manufacturer: stageOne.manufacturer,
          titleFamily: stageOne.titleFamily,
          referenceHints: stageOne.referenceHints,
          referenceHintSource: stageOne.referenceHintSource,
          referenceEntryKey: stageOne.referenceEntryKey,
          rowHintSource: 'row_rehydrated',
        });
      }
    }
    stageOne.referenceHintsExpected = row?.referenceHintsExpected === true;
    const pipelineTrace = buildPipelineTrace({ originalTitle, stageOne, row });
    recordTraceStage({
      trace: pipelineTrace,
      stage: 'normalized_input_aliases',
      logContext,
      payload: {
        originalTitle,
        normalizedTitle: stageOne.normalizedTitle,
        canonicalTitleFamily: stageOne.canonicalTitleFamily,
        aliases: (stageOne.titleFamily?.alternateTitles || []).slice(0, 10),
        manufacturerHint: normalizeString(row?.manufacturerHint || '', 120),
        manufacturerResolved: stageOne.manufacturer || '',
      },
    });
    recordTraceStage({
      trace: pipelineTrace,
      stage: 'hints_loaded',
      logContext,
      payload: {
        referenceHintSource: stageOne.referenceHintSource || 'none',
        referenceHit: stageOne.referenceHit === true,
        referenceEntryKey: stageOne.referenceEntryKey || '',
        referenceRowCandidateCount: Array.isArray(stageOne.referenceHints?.referenceRowCandidates)
          ? stageOne.referenceHints.referenceRowCandidates.length
          : 0,
        normalizedHintBundlePresent: !!stageOne.normalizedHintBundle,
      },
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
    let stage2ErrorCode = '';
    let fallbackDiagnostics = {};
    const stage2Planned = stageOne.discoverySkippedBecauseTrustedCatalogMatched !== true;
    recordTraceStage({
      trace: pipelineTrace,
      stage: 'seed_urls_loaded_at_start',
      logContext,
      payload: {
        workbook: {
          manualUrl: normalizeUrl(summary.manualUrl || ''),
          sourcePageUrl: normalizeUrl(summary.manualSourceUrl || ''),
          supportPageUrl: normalizeUrl(summary.supportUrl || ''),
        },
        reference: {
          manualUrl: normalizeUrl(stageOne.referenceHints?.manualUrl || ''),
          sourcePageUrl: normalizeUrl(stageOne.referenceHints?.manualSourceUrl || ''),
          supportPageUrl: normalizeUrl(stageOne.referenceHints?.supportUrl || ''),
        },
      },
    });
    recordTraceStage({
      trace: pipelineTrace,
      stage: 'query_plan_produced',
      logContext,
      payload: {
        stage2Planned,
        trustedCatalogShortCircuit: stageOne.discoverySkippedBecauseTrustedCatalogMatched === true,
        referenceDomainHints: (stageOne.referenceHints?.preferredManufacturerDomains || []).slice(0, 8),
        referenceSlugHints: (stageOne.referenceHints?.likelySlugPatterns || []).slice(0, 8),
      },
    });

    logManualResearchEvent('stage1_result', {
      ...logContext,
      title: originalTitle,
      normalizedTitle: stageOne.normalizedTitle,
      manufacturer: stageOne.manufacturer,
      stage1MatchType: stageOne.summary.matchType,
      ranStage2: stage2Planned,
      candidateManualCount: cleanCount(stageOne.documentationSuggestions),
      supportCandidateCount: stageOne.supportResourcesSuggestion.length,
      finalManualReady: stageOne.summary.manualReady === true,
    });
    let stageTwo = null;
    if (stage2Planned) {
      logManualResearchEvent('OPENAI_SEARCH_STARTED', {
        ...logContext,
        title: originalTitle,
        normalizedTitle: stageOne.normalizedTitle,
        manufacturer: stageOne.manufacturer,
      });
      stageTwo = await runStageTwoResearch({
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
        stage2ErrorCode = reasonCode;
        logManualResearchEvent('stage2_validation_failed', {
          ...logContext,
          title: originalTitle,
          normalizedTitle: stageOne.normalizedTitle,
          manufacturer: stageOne.manufacturer,
          stage1MatchType: stageOne.summary.matchType,
          ranStage2: stage2Planned,
          reason: normalizeString(error?.message || String(error), 220),
          reasonCode,
        });
        if (reasonCode === 'openai-auth-invalid') {
          logManualResearchEvent('stage2_auth_invalid_fallback', {
            ...logContext,
            title: originalTitle,
            normalizedTitle: stageOne.normalizedTitle,
            manufacturer: stageOne.manufacturer,
            reasonCode,
            guidance: 'Verify OPENAI_API_KEY secret binding for Cloud Functions runtime.',
          });
        } else if (reasonCode === 'openai-config-missing') {
          logManualResearchEvent('openai-config-missing', {
            ...logContext,
            title: originalTitle,
            normalizedTitle: stageOne.normalizedTitle,
            manufacturer: stageOne.manufacturer,
            reasonCode,
          });
        }
        return null;
      });
    }
    let shouldFallbackToScraping = stage2Planned;
    if (stageOne.discoverySkippedBecauseTrustedCatalogMatched === true) {
      fallbackDiagnostics.discoverySkippedBecauseTrustedCatalogMatched = true;
    }
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
          ranStage2: stage2Planned,
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
        ranStage2: stage2Planned,
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
            ranStage2: stage2Planned,
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
          ranStage2: stage2Planned,
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
    const deterministicCandidateState = detectDeterministicCandidate(documentationSuggestions);
    if (deterministicCandidateState.found) {
      logManualResearchEvent('deterministic_candidate_detected', {
        ...logContext,
        deterministicCandidateType: deterministicCandidateState.deterministicCandidateType,
        candidateUrl: deterministicCandidateState.candidate?.url || '',
      });
      logManualResearchEvent('deterministic_candidate_type', {
        ...logContext,
        deterministicCandidateType: deterministicCandidateState.deterministicCandidateType,
      });
      logManualResearchEvent('deterministic_candidate_short_circuit_applied', {
        ...logContext,
        deterministicCandidateType: deterministicCandidateState.deterministicCandidateType,
        candidateUrl: deterministicCandidateState.candidate?.url || '',
      });
      logManualResearchEvent('provider_fallback_skipped_due_to_deterministic_candidate', {
        ...logContext,
        deterministicCandidateType: deterministicCandidateState.deterministicCandidateType,
        candidateUrl: deterministicCandidateState.candidate?.url || '',
      });
      shouldFallbackToScraping = false;
    } else if (deterministicCandidateState.skipped) {
      logManualResearchEvent('deterministic_candidate_detected', {
        ...logContext,
        deterministicCandidateType: deterministicCandidateState.deterministicCandidateType,
        candidateUrl: deterministicCandidateState.candidate?.url || '',
      });
      logManualResearchEvent('deterministic_candidate_type', {
        ...logContext,
        deterministicCandidateType: deterministicCandidateState.deterministicCandidateType,
      });
      logManualResearchEvent('deterministic_candidate_skipped_reason', {
        ...logContext,
        deterministicCandidateType: deterministicCandidateState.deterministicCandidateType,
        candidateUrl: deterministicCandidateState.candidate?.url || '',
        reason: deterministicCandidateState.skippedReason,
      });
    }
    if (shouldFallbackToScraping) {
      logManualResearchEvent('provider_fallback_used_due_to_no_deterministic_candidate', {
        ...logContext,
      });
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
      fallbackDiagnostics = discoveredFallback.fallbackDiagnostics || {};
      recordTraceStage({
        trace: pipelineTrace,
        stage: 'discovery_outputs',
        logContext,
        payload: {
          documentationLinksDiscovered: discoveredFallback.documentationSuggestions.map((entry) => entry.url).slice(0, 20),
          supportLinksDiscovered: discoveredFallback.supportResourcesSuggestion.map((entry) => entry.url).slice(0, 20),
          diagnostics: fallbackDiagnostics,
        },
      });
    }
    if (stageOne.referenceHints) {
      logManualResearchEvent('reference_hint_rehydrated', {
        ...logContext,
        referenceEntryKey: stageOne.referenceEntryKey || '',
        referenceRowCount: Array.isArray(stageOne.referenceHints.referenceRowCandidates)
          ? stageOne.referenceHints.referenceRowCandidates.length
          : 0,
      });
    } else {
      logManualResearchEvent('reference_hint_missing_reason', {
        ...logContext,
        reason: stageOne.referenceHintSource || 'none',
      });
    }

    const continuationSuggestions = [];
    const preContinuationDeterministicState = detectDeterministicCandidate(documentationSuggestions);
    const shouldExpandContinuationCandidates = preContinuationDeterministicState.found
      || documentationSuggestions.some((entry) => isBrochureLikeCandidate(entry))
      || !!stageOne.referenceHints;
    if (shouldExpandContinuationCandidates) {
      continuationSuggestions.push(...buildContinuationSuggestions({
        stageOne,
        summary,
        supportResourcesSuggestion,
        documentationSuggestions,
        logContext,
      }));
      if (continuationSuggestions.length) {
        documentationSuggestions = mergeDocumentationSuggestions({
          existingSuggestions: documentationSuggestions,
          nextSuggestions: continuationSuggestions,
          preserveExistingCandidates: true,
        }).map(withSuggestionBucket);
      }
    }
    pipelineTrace.continuity.continuationCandidateUrls = continuationSuggestions.map((entry) => entry.url).slice(0, 30);
    recordTraceStage({
      trace: pipelineTrace,
      stage: 'candidate_set_before_ranking',
      logContext,
      payload: {
        candidateCount: documentationSuggestions.length,
        candidates: documentationSuggestions.map((entry) => ({
          url: entry?.url || '',
          bucket: classifySuggestionBucket(entry),
          discoverySource: normalizeString(entry?.discoverySource || '', 80),
          brochureLike: isBrochureLikeCandidate(entry),
          continuationCandidate: entry?.continuationCandidate === true,
        })).slice(0, 40),
      },
    });

    const deadCandidateUrls = new Set([...persistedDeadCandidateUrls]);
    documentationSuggestions = prioritizeDocumentationSuggestions({
      documentationSuggestions,
      deadCandidateUrls,
      logContext,
      logEvent: logManualResearchEvent,
    });
    if (documentationSuggestions.length) {
      const selectedSuggestion = documentationSuggestions[0];
      const selectedSource = normalizeString(selectedSuggestion?.discoverySource || '', 80) || 'stage2_or_catalog';
      const selectedOrigin = selectedSource.startsWith('adapter:') ? 'generated_adapter_guess' : 'discovered_source';
      logManualResearchEvent('selected_candidate_final_tier', {
        ...logContext,
        candidateUrl: selectedSuggestion?.url || '',
        candidateTier: classifyCandidateTier(selectedSuggestion),
      });
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
      recordTraceStage({
        trace: pipelineTrace,
        stage: 'ranking_selection_decision',
        logContext,
        payload: {
          selectedCandidateUrl: selectedSuggestion?.url || '',
          selectedCandidateTier: classifyCandidateTier(selectedSuggestion),
          selectedDiscoverySource: selectedSource,
          brochureLikeSelected: isBrochureLikeCandidate(selectedSuggestion),
          candidateCountRanked: documentationSuggestions.length,
        },
      });
    }
    pipelineTrace.continuity.titlePageDiscoveredManualLinks = documentationSuggestions
      .filter((entry) => `${entry?.discoverySource || ''}`.toLowerCase() === 'html_followup')
      .map((entry) => entry?.url || '')
      .filter(Boolean)
      .slice(0, 20);
    pipelineTrace.continuity.brochureClassifiedUrls = documentationSuggestions
      .filter((entry) => isBrochureLikeCandidate(entry))
      .map((entry) => entry?.url || '')
      .filter(Boolean)
      .slice(0, 20);

    let manualLibraryAcquisition = null;
    let acquiredCandidateIndex = -1;
    let acquisitionState = 'skipped';
    let acquisitionAttempted = false;
    let acquisitionEligible = false;
    let candidateWasDirectPdf = false;
    let acquisitionSkippedReason = '';
    let durableStorageCompleted = false;
    let openedFromStoragePreferred = false;
    let acquisitionError = '';
    let lastFailureState = '';
    let lastFailureError = '';
    documentationSuggestions = documentationSuggestions.filter((candidate) => {
      const tier = classifyCandidateTier(candidate);
      logManualResearchEvent('candidate_validation_tier', {
        ...logContext,
        title: originalTitle,
        normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
        manufacturer: summary.manufacturer || stageOne.manufacturer,
        candidateUrl: candidate?.url || '',
        candidateTier: tier,
      });
      if (tier === CANDIDATE_TIER.GENERATED_VENDOR_GUESS && candidate?.verified !== true) {
        logManualResearchEvent('selected_candidate_rejected_unvalidated', {
          ...logContext,
          title: originalTitle,
          normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
          manufacturer: summary.manufacturer || stageOne.manufacturer,
          candidateUrl: candidate?.url || '',
          discoverySource: normalizeString(candidate?.discoverySource || '', 80),
        });
        return false;
      }
      return true;
    });
    if (!documentationSuggestions.length && stage2SelectedCandidate?.url) {
      const selectedCandidateEligibility = isAcquisitionEligibleCandidate(stage2SelectedCandidate);
      if (selectedCandidateEligibility.eligible) {
        documentationSuggestions = [withSuggestionBucket({
          ...stage2SelectedCandidate,
          url: selectedCandidateEligibility.url,
          title: stage2SelectedCandidate.title || originalTitle,
          exactTitleMatch: stage2SelectedCandidate.exactTitleMatch !== false,
          exactManualMatch: selectedCandidateEligibility.directManualLike || stage2SelectedCandidate.verified === true,
          sourcePageUrl: stage2SelectedCandidate.sourcePageUrl || summary.manualSourceUrl || '',
        })];
        logManualResearchEvent('acquisition_eligible_candidate_detected', {
          ...logContext,
          candidateUrl: selectedCandidateEligibility.url,
          candidateTier: selectedCandidateEligibility.tier,
          candidateWasDirectPdf: selectedCandidateEligibility.directManualLike,
          source: 'stage2_selected_candidate',
        });
      }
    }
    documentationSuggestions = documentationSuggestions.map((candidate) => {
      const continuationContext = deriveContinuationContext({ summary, stageOne, candidate });
      return {
        ...candidate,
        sourcePageUrl: normalizeUrl(candidate?.sourcePageUrl || continuationContext.sourcePageUrl || ''),
        manualSourceUrl: normalizeUrl(candidate?.manualSourceUrl || continuationContext.manualSourceUrl || ''),
        supportUrl: normalizeUrl(candidate?.supportUrl || continuationContext.supportUrl || ''),
      };
    });
    const candidateEligibilityList = documentationSuggestions.map((candidate) => isAcquisitionEligibleCandidate(candidate));
    const primaryCandidateEligibility = candidateEligibilityList[0] || isAcquisitionEligibleCandidate({});
    const deterministicEligibleCandidateIndex = documentationSuggestions.findIndex((candidate, index) => {
      if (!resolveDeterministicCandidateType(candidate)) return false;
      return candidateEligibilityList[index]?.eligible === true;
    });
    const firstEligibleOverallCandidateIndex = candidateEligibilityList.findIndex((candidateEligibility) => candidateEligibility?.eligible === true);
    const firstEligibleCandidateIndex = deterministicEligibleCandidateIndex >= 0
      ? deterministicEligibleCandidateIndex
      : (primaryCandidateEligibility.eligible ? 0 : firstEligibleOverallCandidateIndex);
    const selectedCandidateEligibility = firstEligibleCandidateIndex >= 0
      ? candidateEligibilityList[firstEligibleCandidateIndex]
      : primaryCandidateEligibility;
    acquisitionEligible = firstEligibleCandidateIndex >= 0;
    candidateWasDirectPdf = selectedCandidateEligibility.directManualLike;
    recordTraceStage({
      trace: pipelineTrace,
      stage: 'acquisition_eligibility',
      logContext,
      payload: {
        acquisitionEligible,
        firstEligibleCandidateIndex,
        selectedCandidateUrl: documentationSuggestions[firstEligibleCandidateIndex]?.url || documentationSuggestions[0]?.url || '',
        selectedCandidateTier: selectedCandidateEligibility.tier || '',
        candidateEligibility: documentationSuggestions.map((entry, index) => ({
          url: entry?.url || '',
          eligible: candidateEligibilityList[index]?.eligible === true,
          tier: candidateEligibilityList[index]?.tier || '',
          brochureLike: isBrochureLikeCandidate(entry),
          continuationCandidate: entry?.continuationCandidate === true,
        })).slice(0, 40),
      },
    });
    if (summary.matchType === 'exact_manual' || summary.manualReady === true) {
      logManualResearchEvent('exact_manual_detected', {
        ...logContext,
        matchType: summary.matchType || '',
        manualReady: summary.manualReady === true,
        manualUrl: summary.manualUrl || '',
      });
    }
    if (summary.matchType === 'manual_page_with_download') {
      logManualResearchEvent('manual_page_with_download_detected', {
        ...logContext,
        matchType: summary.matchType || '',
        manualSourceUrl: summary.manualSourceUrl || '',
        manualUrl: summary.manualUrl || '',
      });
    }
    if (!documentationSuggestions.length) {
      acquisitionSkippedReason = 'no_candidate_selected';
    } else if (!acquisitionEligible) {
      acquisitionSkippedReason = `candidate_not_acquisition_eligible:${selectedCandidateEligibility.tier || 'unknown'}`;
      logManualResearchEvent('acquisition_skipped_reason', {
        ...logContext,
        reason: acquisitionSkippedReason,
        candidateUrl: documentationSuggestions[0]?.url || '',
        candidateTier: selectedCandidateEligibility.tier || '',
      });
    } else {
      logManualResearchEvent('acquisition_eligible_candidate_detected', {
        ...logContext,
        candidateUrl: selectedCandidateEligibility.url,
        candidateTier: selectedCandidateEligibility.tier,
        candidateWasDirectPdf,
        source: normalizeString(documentationSuggestions[firstEligibleCandidateIndex]?.discoverySource || '', 80) || 'ranked_candidate',
      });
    }
    const reusableCandidate = documentationSuggestions[0] || {};
    const reusableStoragePath = `${reusableCandidate?.manualStoragePath || reusableCandidate?.url || ''}`.trim();
    const reusableManualLibraryRef = `${reusableCandidate?.manualLibraryRef || ''}`.trim();
    const reusableCandidateIsDurable = acquisitionEligible
      && !!reusableManualLibraryRef
      && /^(manual-library\/|companies\/)/i.test(reusableStoragePath);
    if (reusableCandidateIsDurable) {
      summary = {
        ...summary,
        matchType: 'exact_manual',
        manualReady: true,
        reviewRequired: true,
        status: 'docs_found',
        manualUrl: reusableStoragePath,
        manualLibraryRef: reusableManualLibraryRef,
        manualStoragePath: reusableStoragePath,
      };
      acquisitionState = 'reused_existing_durable_storage';
      durableStorageCompleted = true;
      openedFromStoragePreferred = true;
      logManualResearchEvent('durable_storage_completed', {
        ...logContext,
        manualLibraryRef: summary.manualLibraryRef || '',
        manualStoragePath: reusableStoragePath,
        source: 'reused_candidate',
      });
    } else if (acquisitionEligible) {
      acquisitionState = 'started';
      acquisitionAttempted = true;
      logManualResearchEvent('durable_acquisition_attempted', {
        ...logContext,
        candidateCount: documentationSuggestions.filter((_, index) => candidateEligibilityList[index]?.eligible).length,
        firstCandidateUrl: documentationSuggestions[firstEligibleCandidateIndex]?.url || '',
      });
      if (candidateWasDirectPdf) {
        logManualResearchEvent('acquisition_forced_for_direct_pdf', {
          ...logContext,
          candidateUrl: documentationSuggestions[firstEligibleCandidateIndex]?.url || '',
        });
      }
      const manualGradeCandidateCount = candidateEligibilityList.filter((entry) => entry?.eligible === true).length;
      for (let index = 0; index < documentationSuggestions.length; index += 1) {
        const candidate = documentationSuggestions[index];
        const candidateEligibility = candidateEligibilityList[index] || isAcquisitionEligibleCandidate(candidate);
        const isDeterministicCandidate = !!resolveDeterministicCandidateType(candidate);
        if (!candidateEligibility.eligible) {
          if (isBrochureLikeCandidate(candidate)) {
            logManualResearchEvent('brochure_candidate_rejected', {
              ...logContext,
              candidateUrl: candidate?.url || '',
              candidateTier: candidateEligibility.tier || '',
              reason: 'brochure_or_sell_sheet',
            });
            if (index + 1 < documentationSuggestions.length) {
              logManualResearchEvent('brochure_candidate_continuation_started', {
                ...logContext,
                candidateUrl: candidate?.url || '',
                nextCandidateUrl: documentationSuggestions[index + 1]?.url || '',
              });
            }
          }
          logManualResearchEvent('non_manual_candidate_rejected', {
            ...logContext,
            candidateUrl: candidate?.url || '',
            candidateTier: candidateEligibility.tier || '',
            reason: `not_acquisition_eligible:${candidateEligibility.tier || 'unknown'}`,
          });
          logManualResearchEvent('candidate_skipped_not_acquisition_eligible', {
            ...logContext,
            candidateUrl: candidate?.url || '',
            candidateTier: candidateEligibility.tier || '',
          });
          if (isDeterministicCandidate) {
            logManualResearchEvent('deterministic_candidate_rejected_reason', {
              ...logContext,
              deterministicCandidateType: resolveDeterministicCandidateType(candidate),
              candidateUrl: candidate?.url || '',
              reason: `not_acquisition_eligible:${candidateEligibility.tier || 'unknown'}`,
            });
          }
          if (manualGradeCandidateCount > 0 && index + 1 < documentationSuggestions.length) {
            logManualResearchEvent('continued_to_next_candidate', {
              ...logContext,
              candidateUrl: candidate?.url || '',
              reason: 'candidate_not_manual_grade_or_not_acquisition_eligible',
              nextCandidateUrl: documentationSuggestions[index + 1]?.url || '',
            });
          }
          continue;
        }
        const candidateUrlKey = normalizeUrlKey(candidate?.url || '');
        if (candidateUrlKey && deadCandidateUrls.has(candidateUrlKey)) {
          logManualResearchEvent('dead_candidate_skipped_before_selection', {
            ...logContext,
            title: originalTitle,
            normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
            manufacturer: summary.manufacturer || stageOne.manufacturer,
            candidateUrl: candidate?.url || '',
          });
          logManualResearchEvent('candidate_rejected', {
            ...logContext,
            title: originalTitle,
            normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
            manufacturer: summary.manufacturer || stageOne.manufacturer,
            candidateUrl: candidate?.url || '',
            reason: 'persisted_dead_link_candidate',
          });
          if (`${candidate?.discoverySource || ''}`.startsWith('reference_row_')) {
            logManualResearchEvent('reference_row_candidate_stale_cached', {
              ...logContext,
              candidateUrl: candidate?.url || '',
              discoverySource: normalizeString(candidate?.discoverySource || '', 80),
            });
          }
          continue;
        }
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
              titleAliases: Array.from(new Set([
                ...(stageOne.titleFamily?.alternateTitles || []),
                originalTitle,
                stageOne.normalizedTitle,
                stageOne.canonicalTitleFamily,
              ])).filter(Boolean),
              manufacturer: summary.manufacturer || stageOne.manufacturer,
              manufacturerProfile: stageOne.manufacturerProfile,
              manualSourceUrl: summary.manualSourceUrl,
              manualUrl: summary.manualUrl,
              matchType: summary.matchType,
              matchConfidence: summary.matchConfidence || summary.confidence,
              notes: summary.matchNotes || '',
              catalogEntryId: stageOne.catalogMatch?.catalogEntryId || '',
              seededFromWorkbook: stageOne.catalogMatch?.seededFromWorkbook === true,
              trustedCatalog: !!stageOne.trustedCatalogMatch?.row,
              trustedCatalogSourceRowId: stageOne.trustedCatalogMatch?.row?.sourceRowId || stageOne.trustedCatalogMatch?.row?.id || '',
              source: stageOne.trustedCatalogMatch?.row ? 'imported_csv' : '',
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
          if (`${candidate?.discoverySource || ''}`.startsWith('reference_row_')) {
            logManualResearchEvent('reference_row_candidate_promoted_validated', {
              ...logContext,
              candidateUrl: candidate?.url || '',
              discoverySource: normalizeString(candidate?.discoverySource || '', 80),
            });
          }
          acquiredCandidateIndex = index;
          acquisitionState = 'succeeded';
          durableStorageCompleted = true;
          break;
        }
        const failedCandidates = Array.isArray(manualLibraryAcquisition?.failedCandidates)
          ? manualLibraryAcquisition.failedCandidates
          : [];
        failedCandidates.forEach((failed) => {
          const failedUrlKey = normalizeUrlKey(failed?.url || '');
          const httpStatus = Number(failed?.httpStatus || 0) || 0;
          if (isDeterministicCandidate && failed?.deadLink === true) {
            logManualResearchEvent('deterministic_candidate_dead_link', {
              ...logContext,
              candidateUrl: failed?.url || candidate?.url || '',
              httpStatus,
            });
            if (index + 1 < documentationSuggestions.length) {
              logManualResearchEvent('dead_direct_pdf_continuation_started', {
                ...logContext,
                candidateUrl: failed?.url || candidate?.url || '',
                nextCandidateUrl: documentationSuggestions[index + 1]?.url || '',
              });
            }
            if (httpStatus === 404) {
              logManualResearchEvent('deterministic_candidate_404', {
                ...logContext,
                candidateUrl: failed?.url || candidate?.url || '',
              });
            }
          } else if (isDeterministicCandidate && failed?.reason) {
            logManualResearchEvent('deterministic_candidate_validation_failed_reason', {
              ...logContext,
              candidateUrl: failed?.url || candidate?.url || '',
              reason: failed.reason,
              httpStatus,
            });
          }
          if (!failedUrlKey || failed?.deadLink !== true || !isDeadCandidateStatus(httpStatus)) return;
          deadCandidateUrls.add(failedUrlKey);
          logManualResearchEvent('candidate_marked_dead', {
            ...logContext,
            title: originalTitle,
            normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
            manufacturer: summary.manufacturer || stageOne.manufacturer,
            candidateUrl: failed.url || '',
            httpStatus,
          });
          if (`${candidate?.discoverySource || ''}`.startsWith('reference_row_')) {
            logManualResearchEvent('reference_row_candidate_demoted_dead', {
              ...logContext,
              candidateUrl: failed.url || '',
              httpStatus,
              discoverySource: normalizeString(candidate?.discoverySource || '', 80),
            });
          }
        });
        if (!manualLibraryAcquisition?.manualReady && index + 1 < documentationSuggestions.length) {
          if (isDeterministicCandidate) {
            logManualResearchEvent('deterministic_candidate_continuation_started', {
              ...logContext,
              candidateUrl: candidate?.url || '',
              nextCandidateUrl: documentationSuggestions[index + 1]?.url || '',
            });
          }
          logManualResearchEvent('continued_to_next_candidate', {
            ...logContext,
            candidateUrl: candidate?.url || '',
            reason: acquisitionError || 'candidate_failed_or_not_durable',
            nextCandidateUrl: documentationSuggestions[index + 1]?.url || '',
          });
        }
        if (!lastFailureState) acquisitionState = 'no_manual';
      }
      if (!manualLibraryAcquisition?.manualReady && lastFailureState) {
        acquisitionState = lastFailureState;
        acquisitionError = lastFailureError || acquisitionError;
      }
      if (!manualLibraryAcquisition?.manualReady) {
        if (manualGradeCandidateCount > 0) {
          if (documentationSuggestions.some((entry) => isBrochureLikeCandidate(entry))) {
            logManualResearchEvent('continuation_exhausted_after_brochure', {
              ...logContext,
              attemptedCandidateCount: manualGradeCandidateCount,
            });
          }
          if (documentationSuggestions.some((entry) => resolveDeterministicCandidateType(entry) === 'workbook_seed_exact_pdf')) {
            logManualResearchEvent('continuation_exhausted_after_dead_pdf', {
              ...logContext,
              attemptedCandidateCount: manualGradeCandidateCount,
            });
          }
          logManualResearchEvent('exhausted_manual_grade_candidates', {
            ...logContext,
            attemptedCandidateCount: manualGradeCandidateCount,
            acquisitionState,
          });
          logManualResearchEvent('terminalized_after_continuation_exhaustion', {
            ...logContext,
            attemptedCandidateCount: manualGradeCandidateCount,
            acquisitionState,
            reason: acquisitionError || acquisitionState || 'no_manual_after_attempt',
          });
          logManualResearchEvent('terminalized_after_exhaustion', {
            ...logContext,
            attemptedCandidateCount: manualGradeCandidateCount,
            acquisitionState,
            reason: acquisitionError || acquisitionState || 'no_manual_after_attempt',
          });
        }
        logManualResearchEvent('durable_acquisition_failed_reason', {
          ...logContext,
          reason: acquisitionError || acquisitionState || 'no_manual_after_attempt',
          acquisitionState,
          candidateCount: documentationSuggestions.length,
        });
      }
    } else if (!acquisitionSkippedReason) {
      acquisitionSkippedReason = 'acquisition_not_attempted';
    }
    if (!acquisitionAttempted && acquisitionSkippedReason) {
      logManualResearchEvent('durable_acquisition_skipped_reason', {
        ...logContext,
        reason: acquisitionSkippedReason,
      });
      logManualResearchEvent('acquisition_skipped_reason', {
        ...logContext,
        reason: acquisitionSkippedReason,
      });
    }
    if (manualLibraryAcquisition?.manualReady && manualLibraryAcquisition.manualLibrary) {
      const library = manualLibraryAcquisition.manualLibrary;
      const storageUrl = library.storagePath || manualLibraryAcquisition.manualUrl || '';
      openedFromStoragePreferred = !!storageUrl;
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
      logManualResearchEvent('durable_storage_completed', {
        ...logContext,
        manualLibraryRef: library.id,
        manualStoragePath: library.storagePath || '',
      });
      documentationSuggestions = documentationSuggestions.map((entry, index) => index === acquiredCandidateIndex ? {
        ...entry,
        url: storageUrl,
        sourcePageUrl: library.sourcePageUrl || entry.sourcePageUrl || '',
        manualLibraryRef: library.id,
        manualStoragePath: library.storagePath || '',
        cachedManual: true,
      } : entry).map(withSuggestionBucket);
    } else if (!durableStorageCompleted) {
      logManualResearchEvent('exact_manual_terminalized_without_attachment', {
        ...logContext,
        matchType: summary.matchType || '',
        manualReady: summary.manualReady === true,
        reason: acquisitionError || acquisitionSkippedReason || acquisitionState || 'no_durable_storage',
      });
      summary = {
        ...summary,
        manualReady: false,
        status: (summary.supportUrl || supportResourcesSuggestion.length || acquisitionError) ? 'followup_needed' : 'no_match_yet',
        reviewRequired: true,
        manualUrl: '',
      };
    }
    const continuationCandidatesUsed = acquiredCandidateIndex >= 0
      ? documentationSuggestions[acquiredCandidateIndex]?.continuationCandidate === true
      : false;
    pipelineTrace.continuity.continuationCandidatesUsed = continuationCandidatesUsed;
    if (durableStorageCompleted === true && openedFromStoragePreferred !== true) {
      logManualResearchEvent('storageMetadataPresentButExternalUsed', {
        ...logContext,
        manualLibraryRef: summary.manualLibraryRef || '',
        manualStoragePath: summary.manualStoragePath || '',
        selectedCandidateUrl: documentationSuggestions[0]?.url || '',
      });
    }
    documentationSuggestions = documentationSuggestions
      .filter((entry) => {
        const key = normalizeUrlKey(entry?.url || '');
        if (key && deadCandidateUrls.has(key)) {
          logManualResearchEvent('dead_candidate_suppressed', {
            ...logContext,
            title: originalTitle,
            normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
            manufacturer: summary.manufacturer || stageOne.manufacturer,
            candidateUrl: entry?.url || '',
          });
        }
        return !(key && deadCandidateUrls.has(key));
      })
      .map(withSuggestionBucket);
    pipelineTrace.continuity.deadLinkSuppressionUrls = Array.from(deadCandidateUrls).slice(0, 40);
    supportResourcesSuggestion = supportResourcesSuggestion
      .filter((entry) => {
        const key = normalizeUrlKey(entry?.url || '');
        return !(key && deadCandidateUrls.has(key));
      })
      .map(withSuggestionBucket);
    supportResourcesSuggestion = filterSupportResourcesSuggestion(supportResourcesSuggestion, logContext).map(withSuggestionBucket);
    if (summary.supportUrl && isJunkSupportResourceUrl(summary.supportUrl)) {
      summary = { ...summary, supportUrl: '' };
    }
    const queryPlanFingerprint = fingerprint([
      stageOne.normalizedTitle,
      stageOne.manufacturer,
      ...((stageOne.titleFamily?.alternateTitles || []).slice(0, 8)),
      stageOne.catalogMatch?.catalogEntryId || '',
    ].join('|'));
    const candidateFingerprint = fingerprint([
      ...documentationSuggestions.map((entry) => `${entry?.url || ''}|${entry?.candidateBucket || ''}`),
      ...supportResourcesSuggestion.map((entry) => `${entry?.url || ''}|${entry?.candidateBucket || ''}`),
    ].join('|'));
    const rawCandidateFingerprint = fingerprint([
      ...(Array.isArray(stage2ReturnedCandidates) ? stage2ReturnedCandidates.map((entry) => `${entry?.url || ''}|${entry?.bucket || ''}`) : []),
      ...((Array.isArray(stageOne.searchEvidence) ? stageOne.searchEvidence : []).map((entry) => `${entry?.url || ''}|${entry?.classification || ''}`)),
    ].join('|'));
    const queryPlanChanged = !previousQueryPlanFingerprint || queryPlanFingerprint !== previousQueryPlanFingerprint;
    const candidateDelta = !previousCandidateFingerprint || candidateFingerprint !== previousCandidateFingerprint;
    const rawCandidateDelta = !previousRawCandidateFingerprint || rawCandidateFingerprint !== previousRawCandidateFingerprint;
    const deadCandidatesIgnoredForDelta = rawCandidateDelta && !candidateDelta && deadCandidateUrls.size > 0;
    const followupAnswerConsumed = !!(followupAnswer && followupAnswerFingerprint && consumedAnswerFingerprintPrev === followupAnswerFingerprint);
    const knownManufacturer = normalizeManufacturerName(row?.manufacturerHint || stageOne.manufacturer || '');
    const manufacturerOnlyFollowup = isManufacturerOnlyFollowupAnswer({
      followupAnswer,
      knownManufacturer,
    });
    if (followupAnswerConsumed) {
      logManualResearchEvent('followup_answer_consumed', { ...logContext, followupAnswerFingerprint });
    }
    logManualResearchEvent('followup_query_plan_changed', { ...logContext, changed: queryPlanChanged, queryPlanFingerprint });
    logManualResearchEvent('followup_candidate_delta', { ...logContext, changed: candidateDelta, candidateFingerprint });
    logManualResearchEvent('followup_candidate_delta', {
      ...logContext,
      candidateDelta,
      deadCandidatesSuppressedCount: deadCandidateUrls.size,
    });
    logManualResearchEvent('followup_delta_dead_candidates_ignored', {
      ...logContext,
      ignored: deadCandidatesIgnoredForDelta,
      deadCandidatesSuppressedCount: deadCandidateUrls.size,
    });
    if (summary.status === 'followup_needed' && followupQuestionKeyPrev && followupAnswerConsumed && !queryPlanChanged && !candidateDelta) {
      if (knownManufacturer && manufacturerOnlyFollowup) {
        logManualResearchEvent('followup_answer_manufacturer_only_no_new_evidence', {
          ...logContext,
          knownManufacturer,
          followupAnswerFingerprint,
        });
        summary = {
          ...summary,
          followupQuestion: MANUFACTURER_ONLY_FOLLOWUP_QUESTION,
        };
      }
      logManualResearchEvent('followup_question_repeated', { ...logContext, followupQuestionKey: followupQuestionKeyPrev });
      if (manufacturerOnlyFollowup) {
        logManualResearchEvent('followup_question_refined', {
          ...logContext,
          followupQuestionKeyPrev,
          strategy: 'manufacturer_already_known_request_exact_model_text',
        });
      } else {
        summary = {
          ...summary,
          status: documentationSuggestions.length
            ? 'review_needed'
            : (supportResourcesSuggestion.length ? 'support_only' : 'no_match_yet'),
        };
      }
    }
    logManualResearchEvent('ACQUISITION_RESULT', {
      ...logContext,
      title: originalTitle,
      normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
      manufacturer: summary.manufacturer || stageOne.manufacturer,
      acquisitionState,
      acquisitionEligible,
      acquisitionAttempted,
      acquisitionSkippedReason,
      candidateWasDirectPdf,
      durableStorageCompleted,
      manualReady: summary.manualReady === true,
      manualLibraryRef: summary.manualLibraryRef || '',
      manualStoragePath: summary.manualStoragePath || '',
      acquisitionError,
    });
    const fallbackTerminalReason = classifyFallbackTerminalReason({
      stage2ErrorCode,
      fallbackDiagnostics,
      documentationCount: documentationSuggestions.length,
      supportCount: supportResourcesSuggestion.length,
    });
    const terminalStateReason = fallbackTerminalReason
      || deriveDetailedTerminalReason({
        summary,
        fallbackTerminalReason,
        fallbackDiagnostics,
        stageOne,
        acquisitionEligible,
        acquisitionAttempted,
        acquisitionState,
        acquisitionError,
        acquisitionSkippedReason,
        documentationSuggestions,
        continuationSuggestions,
        continuationUsed: continuationCandidatesUsed,
        deterministicCandidateState: preContinuationDeterministicState,
        deadCandidateUrls,
      });
    recordTraceStage({
      trace: pipelineTrace,
      stage: 'continuation_candidates_after_failure_or_rejection',
      logContext,
      payload: {
        continuationCandidateCount: continuationSuggestions.length,
        continuationCandidates: continuationSuggestions.map((entry) => ({
          url: entry?.url || '',
          discoverySource: normalizeString(entry?.discoverySource || '', 80),
          bucket: classifySuggestionBucket(entry),
        })).slice(0, 30),
        continuationCandidatesUsed,
      },
    });
    recordTraceStage({
      trace: pipelineTrace,
      stage: 'acquisition_attempt_results',
      logContext,
      payload: {
        acquisitionAttempted,
        acquisitionEligible,
        acquisitionState,
        acquisitionError,
        acquiredCandidateIndex,
      },
    });
    recordTraceStage({
      trace: pipelineTrace,
      stage: 'terminal_reason_status_mapping',
      logContext,
      payload: {
        terminalStateReason,
        finalStatus: summary.status || '',
        manualReady: summary.manualReady === true,
        acquisitionState,
      },
    });
    if (stage2ErrorCode === 'openai-config-missing' || stage2ErrorCode === 'openai-auth-invalid') {
      logManualResearchEvent(stage2ErrorCode, {
        ...logContext,
        title: originalTitle,
        normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
        manufacturer: summary.manufacturer || stageOne.manufacturer,
      });
    }
    if (terminalStateReason === 'docs_found_after_durable_storage') {
      logManualResearchEvent('docs_found_after_durable_storage', { ...logContext });
    } else if (terminalStateReason === 'acquisition-failed') {
      logManualResearchEvent('acquisition-failed', { ...logContext, reason: acquisitionError });
    } else if (terminalStateReason === 'dead-candidate-only') {
      logManualResearchEvent('dead-candidate-only', { ...logContext, deadCandidatesSuppressedCount: deadCandidateUrls.size });
    } else if (terminalStateReason === 'deterministic-search-no-results') {
      logManualResearchEvent('deterministic-search-no-results', { ...logContext });
    } else if (terminalStateReason === 'close_title_specific_hit_no_manual_extracted') {
      logManualResearchEvent('close_title_specific_hit_no_manual_extracted', { ...logContext });
    } else if (terminalStateReason === 'title_page_found_manual_probe_failed') {
      logManualResearchEvent('title_page_found_manual_probe_failed', { ...logContext });
    } else if (terminalStateReason === 'candidate_found_but_not_durable') {
      logManualResearchEvent('candidate_found_but_not_durable', { ...logContext });
    } else if (terminalStateReason === 'generic-search-page-only') {
      logManualResearchEvent('generic-search-page-only', { ...logContext });
    } else if (terminalStateReason === 'guessed-pdf-404-no-better-candidate') {
      logManualResearchEvent('guessed-pdf-404-no-better-candidate', { ...logContext });
    } else if (terminalStateReason === 'reference_row_match_no_live_manual') {
      logManualResearchEvent('reference_row_match_no_live_manual', { ...logContext });
    } else if (terminalStateReason === 'reference_row_not_matched') {
      logManualResearchEvent('reference_row_not_matched', { ...logContext });
    } else if (terminalStateReason === 'exact_title_candidate_unvalidated_then_404') {
      logManualResearchEvent('exact_title_candidate_unvalidated_then_404', { ...logContext });
    } else if (terminalStateReason === 'dead_candidate_retry_to_alternate') {
      logManualResearchEvent('dead_candidate_retry_to_alternate', { ...logContext });
    } else if (terminalStateReason === 'reference-manual-url-404') {
      logManualResearchEvent('reference-manual-url-404', { ...logContext });
    } else if (terminalStateReason === 'reference-source-page-no-manual-link') {
      logManualResearchEvent('reference-source-page-no-manual-link', { ...logContext });
    } else if (terminalStateReason === 'reference-support-page-no-manual-link') {
      logManualResearchEvent('reference-support-page-no-manual-link', { ...logContext });
    } else if (terminalStateReason === 'manufacturer-adapter-no-better-candidate') {
      logManualResearchEvent('manufacturer-adapter-no-better-candidate', { ...logContext });
    } else if (terminalStateReason === 'candidate_validated_but_not_stored') {
      logManualResearchEvent('candidate_validated_but_not_stored', {
        ...logContext,
        candidateUrl: documentationSuggestions[0]?.url || '',
      });
    }
    logManualResearchEvent('terminal_status_reason', {
      ...logContext,
      title: originalTitle,
      normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
      manufacturer: summary.manufacturer || stageOne.manufacturer,
      terminalStateReason,
    });
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
      ranStage2: stage2Planned,
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
    logManualResearchEvent('run_summary', {
      ...logContext,
      rawTitle: originalTitle,
      normalizedTitle: summary.normalizedTitle || stageOne.normalizedTitle,
      title: originalTitle,
      manufacturer: summary.manufacturer || stageOne.manufacturer,
      titleVariantsUsed: fallbackDiagnostics.titleVariantsUsed || [],
      manufacturerAwareNormalizationApplied: fallbackDiagnostics.manufacturerAwareNormalizationApplied === true,
      titleOnlyQueryCount: Number(fallbackDiagnostics.titleOnlyQueryCount || 0),
      titleManufacturerQueryCount: Number(fallbackDiagnostics.titleManufacturerQueryCount || 0),
      providerSequenceTried: fallbackDiagnostics.providerSequenceTried || [],
      providerAttempts: fallbackDiagnostics.providerAttempts || {},
      providerZeroResults: fallbackDiagnostics.providerZeroResultCounts || {},
      providerFallbackInvoked: fallbackDiagnostics.providerFallbackInvoked === true,
      trustedCatalogHit: !!stageOne.trustedCatalogMatch?.row,
      trustedCatalogSelected: stageOne.discoverySkippedBecauseTrustedCatalogMatched === true,
      trustedCatalogCandidateUrl: stageOne.trustedCatalogMatch?.row?.manualUrl || stageOne.trustedCatalogMatch?.row?.manualSourceUrl || stageOne.trustedCatalogMatch?.row?.supportUrl || '',
      trustedCatalogConfidence: Number(stageOne.trustedCatalogMatch?.row?.matchConfidence || 0),
      trustedCatalogSourceRowId: stageOne.trustedCatalogMatch?.row?.sourceRowId || stageOne.trustedCatalogMatch?.row?.id || '',
      discoverySkippedBecauseTrustedCatalogMatched: stageOne.discoverySkippedBecauseTrustedCatalogMatched === true,
      reusableHit: documentationSuggestions.some((entry) => !!`${entry?.manualLibraryRef || ''}`.trim()),
      selectedCandidateUrl: documentationSuggestions[0]?.url || '',
      selectedCandidateTier: classifyCandidateTier(documentationSuggestions[0] || {}),
      deadCandidatesSuppressedCount: deadCandidateUrls.size,
      acquisitionState,
      terminalReason: terminalStateReason,
      candidateWasDirectPdf,
      acquisitionEligible,
      acquisitionAttempted,
      acquisitionSkippedReason,
      durableStorageCompleted,
      openedFromStoragePreferred,
      storageMetadataPresentButExternalUsed: durableStorageCompleted === true && openedFromStoragePreferred !== true,
      referenceHintSource: stageOne.referenceHintSource || 'none',
      referenceHit: stageOne.referenceHit === true,
      referenceEntryKey: stageOne.referenceEntryKey || '',
      referenceSlugPatternsUsed: Array.isArray(fallbackDiagnostics.referenceSlugPatternsUsed) ? fallbackDiagnostics.referenceSlugPatternsUsed : [],
      referenceDomainsUsed: Array.isArray(fallbackDiagnostics.referenceDomainsUsed) ? fallbackDiagnostics.referenceDomainsUsed : [],
      titlePageFirstApplied: fallbackDiagnostics.titlePageFirstApplied === true,
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
        stage2Ran: stage2Planned,
        sourcePageExtracted: Array.isArray(documentationSuggestions) && documentationSuggestions.some((entry) => !!`${entry?.sourcePageUrl || ''}`.trim()),
        acquisitionSucceeded: summary.manualReady === true && !!`${summary.manualLibraryRef || ''}`.trim(),
        candidateWasDirectPdf,
        acquisitionEligible,
        acquisitionAttempted,
        acquisitionSkippedReason,
        durableStorageCompleted,
        openedFromStoragePreferred,
        storageMetadataPresentButExternalUsed: durableStorageCompleted === true && openedFromStoragePreferred !== true,
        acquisitionState,
        acquisitionError,
        manualLibraryRef: summary.manualLibraryRef || '',
        manualStoragePath: summary.manualStoragePath || '',
        searchEvidence: Array.isArray(stageOne.searchEvidence) ? stageOne.searchEvidence : [],
        deadCandidateUrls: Array.from(deadCandidateUrls).slice(0, 40),
        returnedCandidates: stage2ReturnedCandidates,
        selectedCandidate: stage2SelectedCandidate,
        stage2CandidateAudit,
        trustedCatalogHit: !!stageOne.trustedCatalogMatch?.row,
        trustedCatalogSelected: stageOne.discoverySkippedBecauseTrustedCatalogMatched === true,
        trustedCatalogCandidateUrl: stageOne.trustedCatalogMatch?.row?.manualUrl || stageOne.trustedCatalogMatch?.row?.manualSourceUrl || stageOne.trustedCatalogMatch?.row?.supportUrl || '',
        trustedCatalogConfidence: Number(stageOne.trustedCatalogMatch?.row?.matchConfidence || 0),
        trustedCatalogSourceRowId: stageOne.trustedCatalogMatch?.row?.sourceRowId || stageOne.trustedCatalogMatch?.row?.id || '',
        discoverySkippedBecauseTrustedCatalogMatched: stageOne.discoverySkippedBecauseTrustedCatalogMatched === true,
        terminalStateReason,
        referenceHintSource: stageOne.referenceHintSource || 'none',
        referenceHit: stageOne.referenceHit === true,
        referenceEntryKey: stageOne.referenceEntryKey || '',
        referenceSlugPatternsUsed: Array.isArray(fallbackDiagnostics.referenceSlugPatternsUsed) ? fallbackDiagnostics.referenceSlugPatternsUsed : [],
        referenceDomainsUsed: Array.isArray(fallbackDiagnostics.referenceDomainsUsed) ? fallbackDiagnostics.referenceDomainsUsed : [],
        titlePageFirstApplied: fallbackDiagnostics.titlePageFirstApplied === true,
        followupQuestionKey: summary.followupQuestion ? fingerprint(summary.followupQuestion) : followupQuestionKeyPrev,
        followupQuestion: normalizeString(summary.followupQuestion || '', 220),
        followupAnswerFingerprint,
        followupAnswerConsumed,
        queryPlanFingerprint,
        queryPlanChanged,
        candidateFingerprint,
        rawCandidateFingerprint,
        candidateDelta,
        pipelineTrace,
      },
      locationId: normalizeString(locationId, 120),
      previousQueryPlanFingerprint: queryPlanFingerprint,
      previousCandidateFingerprint: candidateFingerprint,
      previousRawCandidateFingerprint: rawCandidateFingerprint,
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

function resolveDeterministicCandidateType(candidate = {}) {
  const lookupMethod = normalizeString(candidate?.lookupMethod || '', 80).toLowerCase();
  const discoverySource = normalizeString(candidate?.discoverySource || '', 120).toLowerCase();
  const isDirectManual = isDirectManualCandidateUrl(candidate?.url || '')
    || candidate?.candidateScoringFlags?.isDirectPdf === true
    || `${candidate?.resourceType || candidate?.sourceType || ''}`.trim().toLowerCase() === 'manual';
  const exactManual = candidate?.exactManualMatch === true || candidate?.verified === true;

  if (lookupMethod === 'workbook_seed_exact_pdf' && isDirectManual && exactManual) return 'workbook_seed_exact_pdf';
  if (lookupMethod === 'reference_row_manual_url' && isDirectManual && exactManual) return 'reference_row_direct_pdf';
  if (discoverySource === 'reference_row_manual_url' && isDirectManual && exactManual) return 'reference_row_direct_pdf';
  if (discoverySource === 'reference_row_source_page' && exactManual) return 'reference_row_manual_url';
  if (discoverySource === 'reference_row_support_page' && exactManual) return 'reference_row_manual_url';
  return '';
}

function detectDeterministicCandidate(documentationSuggestions = []) {
  const suggestions = Array.isArray(documentationSuggestions) ? documentationSuggestions : [];
  for (let index = 0; index < suggestions.length; index += 1) {
    const candidate = suggestions[index] || {};
    const deterministicType = resolveDeterministicCandidateType(candidate);
    if (!deterministicType) continue;
    const eligibility = isAcquisitionEligibleCandidate(candidate);
    if (!eligibility.eligible) {
      return {
        found: false,
        skipped: true,
        skippedReason: `not_acquisition_eligible:${eligibility.tier || 'unknown'}`,
        deterministicCandidateType: deterministicType,
        candidate,
      };
    }
    return {
      found: true,
      deterministicCandidateType: deterministicType,
      candidate,
      index,
      eligibility,
    };
  }
  return { found: false, skipped: false, skippedReason: 'none' };
}

module.exports = {
  FALLBACK_MATCH_TYPES,
  buildDomainAllowlist,
  researchAssetTitles,
};
