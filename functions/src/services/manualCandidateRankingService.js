const { normalizeUrl } = require('./manualLibraryService');

const TIER = {
  SHARED_LIBRARY_REUSE: 'A_shared_library_reuse',
  EXACT_TITLE_UNVALIDATED_CANDIDATE: 'B_exact_title_unvalidated_candidate',
  EXACT_TITLE_VALIDATED_MANUAL: 'B_exact_title_validated_manual',
  EXACT_TITLE_SUPPORT_OR_LIBRARY: 'C_exact_title_support_or_library',
  GENERIC_BRAND_OR_LIBRARY_PAGE: 'D_generic_brand_or_library_page',
  GENERATED_VENDOR_GUESS: 'E_generated_vendor_guess',
};

function normalizeUrlKey(value = '') {
  return normalizeUrl(value).toLowerCase();
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tierRank(tier = '') {
  if (tier === TIER.SHARED_LIBRARY_REUSE) return 0;
  if (tier === TIER.EXACT_TITLE_VALIDATED_MANUAL) return 1;
  if (tier === TIER.EXACT_TITLE_UNVALIDATED_CANDIDATE) return 2;
  if (tier === TIER.EXACT_TITLE_SUPPORT_OR_LIBRARY) return 3;
  if (tier === TIER.GENERIC_BRAND_OR_LIBRARY_PAGE) return 4;
  if (tier === TIER.GENERATED_VENDOR_GUESS) return 5;
  return 5;
}

function classifyCandidateTier(candidate = {}) {
  const discoverySource = `${candidate?.discoverySource || ''}`.trim().toLowerCase();
  const url = `${candidate?.url || ''}`.trim().toLowerCase();
  const bucket = `${candidate?.bucket || candidate?.candidateBucket || ''}`.trim().toLowerCase();
  const sourceType = `${candidate?.sourceType || candidate?.resourceType || ''}`.trim().toLowerCase();
  const title = `${candidate?.title || ''}`.trim().toLowerCase();
  const verified = candidate?.verified === true;
  const cachedManual = `${candidate?.cachedManual || ''}` === 'true' || !!`${candidate?.manualLibraryRef || ''}`.trim();
  const exactTitle = candidate?.exactManualMatch === true
    || candidate?.candidateScoringFlags?.hasStrongTitleFamilyMatch === true
    || toNumber(candidate?.matchScore, 0) >= 85
    || bucket === 'verified_pdf_candidate';
  const directManualLike = /\.(pdf|docx?)($|[?#])/.test(url)
    || candidate?.candidateScoringFlags?.isDirectPdf === true
    || /manual|operator|service\s+manual|install/.test(`${title} ${url}`)
    || sourceType === 'manual';
  const adapterGuess = discoverySource.startsWith('adapter:') || discoverySource.startsWith('seed:') || candidate?.candidateScoringFlags?.isAdapterGuess === true;
  const titleSpecificSupport = candidate?.titleSpecificSupport === true
    || bucket === 'title_specific_support_page'
    || (/support/.test(sourceType) && exactTitle)
    || (/manuals?\//.test(url) && exactTitle);
  const generic = candidate?.genericSupport === true
    || bucket === 'weak_lead'
    || /^support$|^official_site$|^distributor$/.test(sourceType)
    || /\/library\/?$|\/manuals?\/?$|\/support\/?$/.test(url);

  if (cachedManual) return TIER.SHARED_LIBRARY_REUSE;
  if (!adapterGuess && exactTitle && directManualLike && verified) return TIER.EXACT_TITLE_VALIDATED_MANUAL;
  if (!adapterGuess && exactTitle && directManualLike) return TIER.EXACT_TITLE_UNVALIDATED_CANDIDATE;
  if (!adapterGuess && exactTitle && (titleSpecificSupport || verified)) return TIER.EXACT_TITLE_SUPPORT_OR_LIBRARY;
  if (adapterGuess) return TIER.GENERATED_VENDOR_GUESS;
  if (generic) return TIER.GENERIC_BRAND_OR_LIBRARY_PAGE;
  if (!adapterGuess && directManualLike && exactTitle) return TIER.EXACT_TITLE_UNVALIDATED_CANDIDATE;
  return TIER.GENERIC_BRAND_OR_LIBRARY_PAGE;
}

function buildRankedCandidate(candidate = {}, { deadCandidateUrls = new Set() } = {}) {
  const tier = classifyCandidateTier(candidate);
  const urlKey = normalizeUrlKey(candidate?.url || '');
  const dead = !!(urlKey && deadCandidateUrls.has(urlKey));
  const score = toNumber(candidate?.discoveryCandidateScore, toNumber(candidate?.matchScore, 0));
  const discoverySource = `${candidate?.discoverySource || ''}`.trim().toLowerCase();
  const discovered = !!discoverySource && !discoverySource.startsWith('adapter:') && !discoverySource.startsWith('seed:');
  return {
    candidate,
    tier,
    tierRank: tierRank(tier),
    score,
    urlKey,
    dead,
    discovered,
    exactTitle: tier === TIER.EXACT_TITLE_VALIDATED_MANUAL
      || tier === TIER.EXACT_TITLE_UNVALIDATED_CANDIDATE
      || tier === TIER.EXACT_TITLE_SUPPORT_OR_LIBRARY,
  };
}

function compareRankedCandidates(a, b) {
  if (!!a.dead !== !!b.dead) return a.dead ? 1 : -1;
  if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
  if (!!a.discovered !== !!b.discovered) return a.discovered ? -1 : 1;
  return b.score - a.score || `${a.candidate?.url || ''}`.localeCompare(`${b.candidate?.url || ''}`);
}

module.exports = {
  TIER,
  classifyCandidateTier,
  buildRankedCandidate,
  compareRankedCandidates,
  normalizeUrlKey,
};
