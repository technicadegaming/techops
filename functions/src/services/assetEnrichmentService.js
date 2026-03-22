const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { extractManualLinksFromHtmlPage } = require('./manualDiscoveryService');
const { findCatalogManualMatch, findCatalogManualMatchByEntryId } = require('./manualLookupCatalogService');
const {
  normalizePhrase,
  expandArcadeTitleAliases,
  resolveArcadeTitleFamily
} = require('./arcadeTitleAliasService');

const TRUSTED_MANUAL_HOST_TOKENS = [
  'ipdb.org',
  'arcade-museum.com',
  'arcade-history.com',
  'manual',
  'archive.org'
];

const MANUFACTURER_SOURCE_MAP = [
  {
    key: 'raw thrills',
    aliases: ['rawthrills'],
    sourceTokens: ['rawthrills.com', 'betson.com'],
    preferredSourceTokens: ['rawthrills.com'],
    lowTrustSourceTokens: ['betson.com', 'manualslib.com', 'all-guidesbox.com', 'manualzz.com', 'scribd.com'],
    categories: ['video', 'motion', 'simulator']
  },
  {
    key: 'bay tek',
    aliases: ['baytek', 'bay tek games', 'baytek games', 'bay tek entertainment', 'baytek entertainment'],
    sourceTokens: ['parts.baytekent.com', 'baytekent.com', 'betson.com'],
    preferredSourceTokens: ['parts.baytekent.com', 'baytekent.com'],
    lowTrustSourceTokens: ['betson.com', 'manualslib.com', 'all-guidesbox.com', 'manualzz.com', 'scribd.com'],
    authorizedSourceTokens: ['betson.com'],
    categories: ['redemption', 'ticket']
  },
  {
    key: 'ice',
    aliases: ['innovative concepts in entertainment'],
    sourceTokens: ['support.icegame.com', 'icegame.com', 'betson.com'],
    preferredSourceTokens: ['support.icegame.com', 'icegame.com'],
    lowTrustSourceTokens: ['betson.com', 'manualslib.com', 'all-guidesbox.com', 'manualzz.com', 'scribd.com'],
    authorizedSourceTokens: ['betson.com'],
    categories: ['redemption', 'ticket']
  },
  { key: 'betson', aliases: ['betson enterprises'], sourceTokens: ['betson.com'], categories: ['parts', 'distribution'] },
  { key: 'unis', aliases: ['unis technology', 'unis technologies'], sourceTokens: ['unistop.com', 'unistechnology.com', 'betson.com'], preferredSourceTokens: ['unistop.com', 'unistechnology.com'], authorizedSourceTokens: ['betson.com'], lowTrustSourceTokens: ['manualslib.com', 'all-guidesbox.com'], categories: ['video', 'redemption'] },
  { key: 'sega', aliases: ['sega amusements'], sourceTokens: ['segaarcade.com', 'segaarcade.co.uk', 'arcade', 'manual'], categories: ['video', 'arcade'] },
  { key: 'adrenaline amusements', aliases: ['adrenaline games'], sourceTokens: ['adrenalineamusements.com', 'betson.com'], preferredSourceTokens: ['adrenalineamusements.com'], authorizedSourceTokens: ['betson.com'], lowTrustSourceTokens: ['manualslib.com', 'all-guidesbox.com'], categories: ['redemption', 'ticket'] },
  { key: 'coastal amusements', aliases: [], sourceTokens: ['coastalamusements.com', 'betson.com'], preferredSourceTokens: ['coastalamusements.com'], authorizedSourceTokens: ['betson.com'], lowTrustSourceTokens: ['manualslib.com', 'all-guidesbox.com'], categories: ['redemption', 'crane', 'prize'] },
  { key: 'smart industries', aliases: [], sourceTokens: ['smartind.com', 'betson.com'], categories: ['crane', 'prize'] },
  { key: 'people games', aliases: ['peoplegames'], sourceTokens: ['peoplegames.com', 'betson.com'], categories: ['redemption'] },
  { key: 'moss', aliases: ['moss distributors'], sourceTokens: ['mossdistributing.com'], categories: ['distribution', 'parts'] },
  { key: 'andamiro', aliases: [], sourceTokens: ['andamirousa.com', 'andamiro.com', 'betson.com'], categories: ['redemption', 'ticket'] },
  { key: 'elaut', aliases: [], sourceTokens: ['elaut.com', 'elaut-group.com'], categories: ['crane', 'prize'] },
  { key: 'stern pinball', aliases: ['stern'], sourceTokens: ['sternpinball.com', 'ipdb.org'], categories: ['pinball'] },
  { key: 'bally midway', aliases: ['bally', 'midway', 'bally/midway'], sourceTokens: ['ipdb.org', 'arcade-museum.com', 'archive.org'], categories: ['arcade', 'legacy'] },
  { key: 'namco', aliases: ['bandai namco'], sourceTokens: ['bandainamco-am.co.jp', 'bandainamcoent.com', 'arcade-museum.com'], categories: ['video', 'arcade'] },
  { key: 'komuse', aliases: [], sourceTokens: ['komuse.com'], categories: ['redemption', 'ticket'] },
  { key: 'benchmark games', aliases: ['benchmark'], sourceTokens: ['benchmarkgames.com', 'betson.com'], categories: ['redemption', 'ticket'] },
  { key: 'touchmagix', aliases: ['touch magix'], sourceTokens: ['touchmagix.com'], categories: ['interactive', 'video'] },
  { key: 'wahlap', aliases: ['wahlap technology'], sourceTokens: ['wahlap.com', 'betson.com'], categories: ['video', 'redemption'] },
  { key: 'falgas', aliases: ['falgas usa'], sourceTokens: ['falgas.com', 'falgasusa.com'], categories: ['kiddie', 'ride'] },
  { key: 'lai games', aliases: ['lai'], sourceTokens: ['laigames.com', 'betson.com'], preferredSourceTokens: ['laigames.com'], authorizedSourceTokens: ['betson.com'], lowTrustSourceTokens: ['manualslib.com', 'all-guidesbox.com'], categories: ['redemption', 'video'] },
  { key: 'magic play', aliases: ['magicplay'], sourceTokens: ['magicplay.com.br', 'magicplay'], categories: ['redemption'] },
  { key: 'zamperla', aliases: [], sourceTokens: ['zamperla.com'], categories: ['attraction', 'ride'] }
];

const DEAD_PAGE_PATTERNS = [
  /page not found/i,
  /manual not found/i,
  /not available/i,
  /error\s*(404|410|500)?/i,
  /document no longer exists/i
];

const VERIFY_TIMEOUT_MS = 3500;
const VERIFY_MAX_SUGGESTIONS = 5;
const COMMON_SHORT_TITLE_WORDS = new Set(['the', 'pro', 'plus', 'super', 'game', 'deluxe', 'sport']);
const MANUAL_INTENT_TOKENS = ['manual', 'operator', 'service', 'parts', 'install', 'installation', 'schematic', 'instruction'];

const TERMINAL_ENRICHMENT_STATUSES = new Set(['docs_found', 'no_match_yet', 'followup_needed', 'lookup_failed']);

function buildAssetEnrichmentLogger({ traceId = '', assetId = '', triggerSource = '' } = {}) {
  return (event, payload = {}) => {
    console.log(`assetEnrichment:${event}`, { traceId, assetId, triggerSource, ...payload });
  };
}

function isTerminalEnrichmentStatus(status) {
  return TERMINAL_ENRICHMENT_STATUSES.has(`${status || ''}`.trim());
}

async function writeTerminalFailureState({ assetRef, userId, code, message, log, phase = 'defensive_failure_write' }) {
  const payload = {
    enrichmentStatus: 'lookup_failed',
    enrichmentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    enrichmentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    enrichmentErrorCode: `${code || 'unknown'}`.trim() || 'unknown',
    enrichmentErrorMessage: `${message || 'Asset docs lookup failed.'}`.trim().slice(0, 240),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId
  };
  await assetRef.set(payload, { merge: true });
  log(phase, {
    enrichmentStatus: payload.enrichmentStatus,
    enrichmentErrorCode: payload.enrichmentErrorCode,
    enrichmentErrorMessage: payload.enrichmentErrorMessage
  });
}

const SOFT_404_TEXT_PATTERNS = [
  /sorry[,\s]+the page you are looking for/i,
  /we (?:could|can) not find/i,
  /nothing (?:found|here)/i,
  /access denied/i
];

const GENERIC_DOCUMENTATION_PATH_PATTERNS = [
  /^\/$/,
  /^\/(home|index(\.html?)?)?$/,
  /^\/support\/?$/,
  /^\/service-support\/?$/,
  /^\/services?\/?$/,
  /^\/products\/?$/,
  /^\/downloads?\/?$/,
  /^\/docs?\/?$/,
  /^\/manuals?\/?$/,
  /^\/manuals?\/(?:index|library|hub)?\/?$/,
  /^\/support\/(?:manuals?|downloads?|docs?|library|hub)?\/?$/
];
const GENERIC_SUPPORT_JUNK_PATH_PATTERNS = [
  /^\/$/,
  /^\/(home|index(\.html?)?)?$/,
  /^\/service-support\/?$/,
  /^\/services?\/?$/,
  /^\/parts-service\/?$/,
  /^\/parts\/?$/,
  /^\/blog\/?$/,
  /^\/news\/?$/,
  /^\/terms(?:-conditions)?\/?$/,
  /^\/privacy(?:-policy)?\/?$/,
  /^\/contact(?:-us)?\/?$/
];
const JUNK_URL_FRAGMENT_PATTERNS = [/^respond$/i, /^comments?$/i, /^comment-\d+$/i];
const SUPPORT_ONLY_SOURCE_TYPES = new Set(['support', 'official_site', 'contact', 'parts']);
const REVIEWABLE_DOC_STATE = 'pending_review';
const FOLLOWUP_RESEARCH_STATE = 'followup_needed';
const NO_MATCH_RESEARCH_STATE = 'research_needed';


function tokenize(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((v) => v.trim())
    .filter((v) => v.length >= 2);
}

function buildExactTitleVariants(assetName, normalizedName) {
  const rawVariants = expandArcadeTitleAliases([normalizedName, assetName]).map((value) => normalizePhrase(value));
  const variants = new Set();
  for (const variant of rawVariants.filter((entry) => entry && entry.length >= 3)) {
    variants.add(variant);
    variants.add(variant.replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim());
    variants.add(variant.replace(/\barcade\b/g, ' ').replace(/\s+/g, ' ').trim());
    variants.add(variant.replace(/\band\b/g, ' ').replace(/\barcade\b/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return Array.from(variants).filter((entry) => entry && entry.length >= 3);
}

function pathHasTitleEvidence(lowerPath, titleVariants) {
  const normalizedPath = normalizePhrase(lowerPath.replace(/\//g, ' '));
  return titleVariants.some((variant) => normalizedPath.includes(variant));
}

function isStrictlyGenericDocumentationPage(lowerPath, titleVariants) {
  const genericPath = GENERIC_DOCUMENTATION_PATH_PATTERNS.some((pattern) => pattern.test(lowerPath));
  if (!genericPath) return false;
  return !pathHasTitleEvidence(lowerPath, titleVariants);
}

function isGenericSupportJunkPage(lowerPath, titleVariants) {
  const genericPath = GENERIC_SUPPORT_JUNK_PATH_PATTERNS.some((pattern) => pattern.test(lowerPath));
  if (!genericPath) return false;
  return !pathHasTitleEvidence(lowerPath, titleVariants);
}

function normalizeAssetMatchKey(assetName = '', normalizedName = '') {
  return normalizePhrase(normalizedName || assetName);
}

function sanitizeSuggestionUrl(rawUrl = '') {
  const value = `${rawUrl || ''}`.trim();
  if (!value) return '';
  if (/^manual-library\/.+\.(pdf|docx?)$/i.test(value)) return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(parsed.protocol)) return '';
  const fragment = `${parsed.hash || ''}`.replace(/^#/, '').trim();
  if (fragment && JUNK_URL_FRAGMENT_PATTERNS.some((pattern) => pattern.test(fragment))) parsed.hash = '';
  return parsed.toString();
}

function normalizeSuggestionTitle(entry = {}) {
  return `${entry?.title || entry?.label || ''}`.trim().replace(/\s+/g, ' ').slice(0, 180);
}

function isDirectDocumentationFileSuggestion(entry = {}) {
  const url = `${entry?.resolvedUrl || entry?.url || ''}`.trim().toLowerCase();
  if (!url) return false;
  return /\.pdf($|\?|#)|\/wp-content\/uploads\/|\/manuals?\/[^/]+\.(pdf|docx?)($|\?|#)|^manual-library\/.+\.(pdf|docx?)$/.test(url);
}

function isSeededCatalogManualCandidate(entry = {}) {
  const matchStatus = `${entry?.matchStatus || ''}`.trim().toLowerCase();
  const lookupMethod = `${entry?.lookupMethod || ''}`.trim().toLowerCase();
  const seededFromWorkbook = !!entry?.verificationMetadata?.seededFromWorkbook;
  return isDirectDocumentationFileSuggestion(entry)
    && !!entry?.exactTitleMatch
    && !!entry?.exactManualMatch
    && !!entry?.trustedSource
    && !entry?.deadPage
    && (seededFromWorkbook || matchStatus === 'catalog_exact' || lookupMethod === 'workbook_seed_exact_pdf');
}

function hasSeededDirectManualProof(entry = {}) {
  return `${entry?.lookupMethod || ''}`.trim().toLowerCase() === 'workbook_seed_exact_pdf'
    && !!`${entry?.catalogEntryId || ''}`.trim()
    && entry?.verificationMetadata?.hasDirectManual === true;
}

function rehydrateSeededManualDocumentationSuggestions({
  asset = {},
  documentationSuggestions = [],
  supportResourcesSuggestion = [],
  normalizedName = '',
  manufacturerSuggestion = '',
  followupAnswer = ''
} = {}) {
  if (cleanDocumentationSuggestions(documentationSuggestions).length > 0) return [];

  const evidenceRows = [
    ...(Array.isArray(documentationSuggestions) ? documentationSuggestions : []),
    ...(Array.isArray(supportResourcesSuggestion) ? supportResourcesSuggestion : []),
    asset?.manualLookupCatalogMatch || null
  ].filter(Boolean);

  const catalogEntryIds = Array.from(new Set(evidenceRows
    .filter(hasSeededDirectManualProof)
    .map((row) => `${row?.catalogEntryId || ''}`.trim())
    .filter(Boolean)));

  if (!catalogEntryIds.length) return [];

  const rehydratedLinks = catalogEntryIds.flatMap((catalogEntryId) => {
    const catalogMatch = findCatalogManualMatchByEntryId(catalogEntryId);
    if (!catalogMatch?.entry?.verification?.hasDirectManual) return [];
    return Array.isArray(catalogMatch.documentationSuggestions)
      ? catalogMatch.documentationSuggestions.filter((entry) => hasSeededDirectManualProof(entry))
      : [];
  });

  return normalizeDocumentationSuggestions({
    links: rehydratedLinks,
    confidence: Math.max(Number(asset?.enrichmentConfidence || 0), 0.95),
    asset,
    normalizedName: normalizedName || asset?.normalizedName || asset?.name || '',
    manufacturerSuggestion: manufacturerSuggestion || asset?.manufacturerSuggestion || asset?.manufacturer || '',
    followupAnswer: followupAnswer || asset?.enrichmentFollowupAnswer || ''
  });
}

function isTitleSpecificManualBearingHtmlSuggestion(entry = {}) {
  const verificationKind = `${entry?.verificationKind || ''}`.trim().toLowerCase();
  if (verificationKind !== 'manual_html') return false;
  if (!entry?.exactTitleMatch || !(entry?.trustedSource || entry?.isOfficial)) return false;

  let lowerPath = '';
  let lowerHost = '';
  try {
    const parsed = new URL(`${entry?.resolvedUrl || entry?.url || ''}`);
    lowerPath = parsed.pathname.toLowerCase();
    lowerHost = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }

  const titleVariants = buildExactTitleVariants(entry?.assetName || entry?.normalizedName, entry?.normalizedName || entry?.assetName);
  if (!titleVariants.length) return false;
  if (isStrictlyGenericDocumentationPage(lowerPath, titleVariants) || isGenericSupportJunkPage(lowerPath, titleVariants)) return false;
  const normalizedTitle = normalizePhrase(`${entry?.title || entry?.label || ''}`);
  const hasTitlePathEvidence = pathHasTitleEvidence(lowerPath, titleVariants);
  const hasTitleTextEvidence = titleVariants.some((variant) => normalizedTitle.includes(variant));
  const manualEvidenceText = normalizePhrase([
    entry?.title || '',
    entry?.label || '',
    entry?.notes || '',
    entry?.url || '',
    entry?.resolvedUrl || '',
  ].join(' '));
  const hasManualPathSignal = /games?|support|product|parts|downloads?|manual|service|install/.test(lowerPath);
  const hasExplicitManualProof = [
    /\bmanuals?\b/,
    /\boperator\b/,
    /\bservice manuals?\b/,
    /\bparts manuals?\b/,
    /\binstall(?:ation)?(?: guide| manual)?\b/,
    /\bdownloads?\b/,
    /\bpdf\b/,
    /\.pdf\b/,
    /\.docx?\b/,
  ].some((pattern) => pattern.test(manualEvidenceText));
  const genericSupportHost = /(^|\.)rawthrills\.com$/.test(lowerHost) && /^\/service\/?$/.test(lowerPath);
  return !genericSupportHost
    && hasManualPathSignal
    && hasExplicitManualProof
    && (hasTitlePathEvidence || hasTitleTextEvidence);
}

function sanitizeManualCandidate(entry = {}) {
  const sanitized = { ...entry };
  if (sanitized.cachedManual && sanitized.manualStoragePath && !sanitized.url) sanitized.url = sanitized.manualStoragePath;
  if (!sanitized.url) return sanitized;
  const isDirectFile = isDirectDocumentationFileSuggestion(sanitized);
  const manualBearingHtml = isTitleSpecificManualBearingHtmlSuggestion(sanitized);
  const sourceType = `${sanitized.sourceType || sanitized.resourceType || ''}`.trim().toLowerCase();
  if (isAmbiguousManualCandidate(sanitized)) {
    sanitized.exactManualMatch = false;
    sanitized.matchType = 'family_match_needs_review';
  }
  if (!isDirectFile && sanitized.verificationKind === 'manual_html' && !manualBearingHtml) {
    sanitized.verificationKind = 'support_html';
    sanitized.verified = false;
    sanitized.exactManualMatch = false;
    if (SUPPORT_ONLY_SOURCE_TYPES.has(sourceType)) sanitized.reviewable = false;
  }
  return sanitized;
}

function isReusableVerifiedManual(entry = {}, matchedManufacturer = '') {
  if (!isPreservableVerifiedManualSuggestion(entry)) return false;
  const entryManufacturer = normalizePhrase(entry.matchedManufacturer || entry.manufacturer || '');
  const normalizedManufacturer = normalizePhrase(matchedManufacturer);
  if (normalizedManufacturer && entryManufacturer && entryManufacturer !== normalizedManufacturer) return false;
  return true;
}

function collectReusableVerifiedManuals({ asset = {}, matchedManufacturer = '', manualRecords = [], siblingAssets = [] }) {
  const assetMatchKey = normalizeAssetMatchKey(asset.name, asset.normalizedName);
  if (!assetMatchKey || !matchedManufacturer) return [];

  const manualSuggestions = (Array.isArray(manualRecords) ? manualRecords : []).flatMap((manual) => {
    const manualAssetMatchKey = normalizeAssetMatchKey(manual.assetTitle, manual.normalizedName);
    const manualManufacturer = normalizePhrase(manual.matchedManufacturer || manual.manufacturer || '');
    if (manualAssetMatchKey !== assetMatchKey || manualManufacturer !== normalizePhrase(matchedManufacturer)) return [];
    const url = `${manual.sourceUrl || ''}`.trim();
    if (!url) return [];
    return [{
      title: manual.sourceTitle || manual.assetTitle || asset.name || url,
      url,
      sourceType: manual.sourceType || 'approved_doc',
      matchScore: 100,
      exactTitleMatch: true,
      exactManualMatch: true,
      verified: true,
      trustedSource: true,
      matchedManufacturer,
      reusedVerifiedManual: true,
      reason: 'reused_verified_manual_record'
    }];
  });

  const siblingSuggestions = (Array.isArray(siblingAssets) ? siblingAssets : []).flatMap((candidate) => {
    const candidateAssetMatchKey = normalizeAssetMatchKey(candidate.name, candidate.normalizedName);
    const candidateManufacturer = normalizePhrase(candidate.matchedManufacturer || candidate.manufacturer || '');
    if (candidateAssetMatchKey !== assetMatchKey || candidateManufacturer !== normalizePhrase(matchedManufacturer)) return [];
    return (Array.isArray(candidate.documentationSuggestions) ? candidate.documentationSuggestions : [])
      .filter((entry) => isReusableVerifiedManual(entry, matchedManufacturer))
      .map((entry) => ({
        ...entry,
        matchedManufacturer,
        reusedVerifiedManual: true,
        reason: entry.reason ? `${entry.reason},reused_verified_manual_asset` : 'reused_verified_manual_asset'
      }));
  });

  return dedupeDocumentationSuggestions([...manualSuggestions, ...siblingSuggestions]).slice(0, 5);
}

const { findApprovedManualLibraryRecord } = require('./manualLibraryService');

async function findReusableVerifiedManuals({ db, asset = {}, assetId = '', companyId = '', matchedManufacturer = '' }) {
  const normalizedManufacturer = normalizePhrase(matchedManufacturer);
  const assetMatchKey = normalizeAssetMatchKey(asset.name, asset.normalizedName);
  if (!db || !companyId || !normalizedManufacturer || !assetMatchKey) return [];

  const libraryHit = await findApprovedManualLibraryRecord({
    db,
    canonicalTitle: asset.normalizedName || asset.name || '',
    manufacturer: matchedManufacturer,
    familyTitle: asset.family || asset.normalizedName || asset.name || '',
  }).catch(() => null);
  const librarySuggestions = libraryHit ? [{
    title: libraryHit.filename || libraryHit.canonicalTitle || asset.name || libraryHit.storagePath,
    url: libraryHit.storagePath || '',
    sourcePageUrl: libraryHit.sourcePageUrl || '',
    sourceType: 'manual_library',
    matchScore: 100,
    exactTitleMatch: true,
    exactManualMatch: true,
    verified: true,
    trustedSource: true,
    matchedManufacturer,
    manualLibraryRef: libraryHit.id,
    manualStoragePath: libraryHit.storagePath || '',
    reusedVerifiedManual: true,
    reason: 'reused_shared_manual_library'
  }] : [];

  const [manualSnap, assetSnap] = await Promise.all([
    db.collection('manuals')
      .where('companyId', '==', companyId)
      .limit(50)
      .get()
      .catch(() => ({ docs: [] })),
    db.collection('assets')
      .where('companyId', '==', companyId)
      .where('matchedManufacturer', '==', matchedManufacturer)
      .limit(20)
      .get()
      .catch(() => ({ docs: [] }))
  ]);

  const manualRecords = (manualSnap.docs || []).map((doc) => doc.data?.() || {});
  const siblingAssets = (assetSnap.docs || [])
    .filter((doc) => doc.id !== assetId)
    .map((doc) => doc.data?.() || {});

  return [
    ...librarySuggestions,
    ...collectReusableVerifiedManuals({
      asset,
      matchedManufacturer: normalizedManufacturer,
      manualRecords,
      siblingAssets
    })
  ].slice(0, 5);
}

function getManufacturerProfile(...values) {
  const inferred = values
    .map((value) => resolveArcadeTitleFamily({ title: value, manufacturer: '' }))
    .find((entry) => entry?.manufacturer);
  const joined = values.filter(Boolean).join(' ').toLowerCase();
  return MANUFACTURER_SOURCE_MAP.find((entry) => {
    const candidates = [entry.key, ...(entry.aliases || [])];
    return candidates.some((candidate) => joined.includes(candidate))
      || (inferred?.manufacturer && candidates.some((candidate) => normalizePhrase(inferred.manufacturer).includes(normalizePhrase(candidate))));
  }) || null;
}

function selectBestSupportResource(supportResources = [], titleVariants = []) {
  const exactTitleSupport = (supportResources || []).find((entry) => {
    const combined = normalizePhrase(`${entry?.title || ''} ${entry?.url || ''}`);
    return titleVariants.some((variant) => combined.includes(variant));
  });
  return exactTitleSupport || (supportResources || [])[0] || null;
}

function isAmbiguousManualCandidate(entry = {}) {
  const manualType = `${entry?.manualType || entry?.linkType || ''}`.trim().toLowerCase();
  const joined = `${entry?.title || ''} ${entry?.notes || ''} ${entry?.sourcePageUrl || ''} ${entry?.url || ''}`.toLowerCase();
  return /install_guide|upgrade[_ -]?kit/.test(manualType) || /install guide|upgrade kit/.test(joined);
}

function classifyManualMatchSummary({
  inputTitle = '',
  titleFamily = {},
  documentationSuggestions = [],
  supportResourcesSuggestion = [],
  supportContactsSuggestion = [],
  confidence = 0,
  topMatchReason = '',
  catalogMatch = null
} = {}) {
  const titleVariants = buildExactTitleVariants(inputTitle, titleFamily.canonicalTitle || inputTitle);
  const manualCandidates = cleanDocumentationSuggestions(documentationSuggestions);
  const supportCandidates = cleanSupportResourcesSuggestion(supportResourcesSuggestion, manualCandidates);
  const bestManual = manualCandidates[0] || null;
  const bestSupport = selectBestSupportResource(supportCandidates, titleVariants);
  const supportEmail = (supportContactsSuggestion || []).find((entry) => `${entry?.contactType || ''}`.toLowerCase() === 'email')?.value || '';
  const supportPhone = (supportContactsSuggestion || []).find((entry) => ['phone', 'telephone'].includes(`${entry?.contactType || ''}`.toLowerCase()))?.value || '';
  const catalogMatchStatus = `${catalogMatch?.matchStatus || ''}`.toLowerCase();
  const ambiguousManual = bestManual && isAmbiguousManualCandidate(bestManual);
  const variantWarning = titleFamily.variantWarning
    || (ambiguousManual ? 'Candidate documentation appears to be install-guide or upgrade-kit evidence, so the exact base cabinet manual still needs review.' : '')
    || ((catalogMatchStatus === 'catalog_family' || catalogMatchStatus === 'catalog_variant')
      ? 'Likely title family match, but the exact cabinet/model variant still needs review.'
      : '');
  const bestManualUrl = `${bestManual?.url || ''}`.trim();
  const bestManualSourceUrl = `${bestManual?.sourcePageUrl || ''}`.trim();
  const bestSupportUrl = `${bestSupport?.url || ''}`.trim();
  const isManualPageWithDownload = !!bestManual
    && `${bestManual?.verificationKind || ''}`.trim().toLowerCase() === 'manual_html'
    && !/\.pdf($|\?|#)/i.test(bestManualUrl);
  const exactManual = !!bestManual && !variantWarning && !isManualPageWithDownload;
  const manualPageWithDownload = !!bestManual && !variantWarning && isManualPageWithDownload;
  const titleSpecificSupport = !!bestSupportUrl && titleVariants.some((variant) => normalizePhrase(`${bestSupport?.title || ''} ${bestSupportUrl}`).includes(variant));
  const titleSpecificSource = !bestManual && titleSpecificSupport;
  const supportOnly = !bestManual && !titleSpecificSupport && supportCandidates.length > 0;
  const familyReview = !!variantWarning && (!!bestManual || !!bestSupport || !!catalogMatch);
  const matchType = exactManual
    ? 'exact_manual'
    : (manualPageWithDownload
      ? 'manual_page_with_download'
      : (familyReview
        ? 'family_match_needs_review'
        : (titleSpecificSource
          ? 'title_specific_source'
          : (supportOnly ? 'support_only' : 'unresolved'))));
  const manualSourceUrl = bestManualSourceUrl || (manualPageWithDownload ? bestManualUrl : '');
  const supportUrl = bestSupportUrl || supportCandidates[0]?.url || '';
  const manualReady = ['exact_manual', 'manual_page_with_download'].includes(matchType);
  const notes = [
    matchType ? `matchType: ${matchType}` : '',
    titleFamily.matchedAlias && titleFamily.matchedAlias !== titleFamily.canonicalTitle ? `normalized from: ${titleFamily.matchedAlias}` : '',
    titleFamily.manufacturer ? `manufacturer: ${titleFamily.manufacturer}` : '',
    bestManual?.sourceType ? `manual source: ${bestManual.sourceType}` : '',
    bestSupport?.sourceType ? `support source: ${bestSupport.sourceType}` : '',
    variantWarning || '',
    topMatchReason || ''
  ].filter(Boolean).join(' | ');

  const status = manualReady ? 'docs_found' : ((supportUrl || variantWarning) ? 'followup_needed' : 'no_match_yet');
  return {
    inputTitle,
    canonicalTitle: titleFamily.canonicalTitle || inputTitle,
    assetNameOriginal: inputTitle,
    assetNameNormalized: titleFamily.canonicalTitle || inputTitle,
    manufacturer: titleFamily.manufacturer || '',
    manufacturerInferred: !!(titleFamily.manufacturer),
    model: '',
    category: '',
    matchType,
    manualReady,
    confidence: Number(confidence || 0),
    matchConfidence: Number(confidence || 0),
    matchNotes: notes,
    manualUrl: manualReady ? (bestManual?.url || '') : '',
    manualSourceUrl,
    supportEmail,
    supportPhone,
    supportUrl,
    alternateTitles: Array.from(new Set(titleFamily.alternateTitles || [])).filter(Boolean),
    variantWarning,
    reviewRequired: !manualReady,
    searchEvidence: [bestManual?.url, bestManual?.sourcePageUrl, bestSupportUrl].filter(Boolean),
    status
  };
}

function buildFollowupQuestion({ parsedQuestion, profile, likelyCategory, hasOnlyFailedVerification }) {
  if (hasOnlyFailedVerification) {
    return 'Is the cabinet nameplate manufacturer and model readable (photo text is fine)?';
  }
  const category = `${likelyCategory || ''}`.toLowerCase();
  if (/crane|claw|prize/.test(category) || (profile?.categories || []).some((c) => ['crane', 'prize'].includes(c))) {
    return 'Is this a prize/crane game, and what exact model text appears on the marquee?';
  }
  if (/redemption|ticket/.test(category) || (profile?.categories || []).some((c) => ['redemption', 'ticket'].includes(c))) {
    return 'Is this ticket/redemption, and what subtitle/version appears under the game logo?';
  }
  if (parsedQuestion && !/exact manual link|provide.*url|share.*url|lookup/i.test(parsedQuestion)) {
    return parsedQuestion;
  }
  return 'What exact cabinet nameplate text appears under/near the game logo (including subtitle/version/model)?';
}

function normalizeSuggestionSourceType(sourceType, { lowerHost, lowTrustSourceMatch }) {
  const raw = `${sourceType || 'other'}`.trim().toLowerCase() || 'other';
  if (lowTrustSourceMatch && /manufacturer|official_site|support|parts/.test(raw)) return 'distributor';
  if (/betson/.test(lowerHost)) return 'distributor';
  return raw;
}

function getDocumentationSuggestionRank(entry = {}) {
  const sourceType = `${entry.sourceType || entry.resourceType || 'other'}`.trim().toLowerCase();
  const url = `${entry.url || ''}`.toLowerCase();
  const verified = !!entry.verified;
  const exactTitleMatch = !!entry.exactTitleMatch;
  const exactManualMatch = !!entry.exactManualMatch;
  const verificationKind = `${entry.verificationKind || ''}`.trim().toLowerCase();
  const isDirectFile = /\.pdf($|\?|#)|\/wp-content\/uploads\/|\/manuals?\/[^/]+\.(pdf|docx?)($|\?|#)/.test(url);
  const isManualLibrary = sourceType === 'manual_library';
  const isSupportResource = ['support', 'official_site', 'contact'].includes(sourceType) && !exactManualMatch;
  const isMirror = ['distributor', 'other'].includes(sourceType);
  const isTitleSpecificPage = exactTitleMatch && /support|parts|downloads?|manual|service|install|product/.test(url);
  const isVerifiedManualBearingPage = verified && verificationKind === 'manual_html' && exactTitleMatch && !isDirectFile;

  if (verified && isDirectFile) return 0;
  if (isVerifiedManualBearingPage) return 1;
  if (verified && exactTitleMatch && exactManualMatch) return 1;
  if (verified && isTitleSpecificPage) return 2;
  if (verified && isManualLibrary) return 3;
  if (verified && isMirror) return 4;
  if (isSupportResource) return 6;
  return 5;
}

function compareDocumentationSuggestions(a = {}, b = {}) {
  const rankDiff = getDocumentationSuggestionRank(a) - getDocumentationSuggestionRank(b);
  if (rankDiff !== 0) return rankDiff;
  if (!!a.verified !== !!b.verified) return a.verified ? -1 : 1;
  if (!!a.exactManualMatch !== !!b.exactManualMatch) return a.exactManualMatch ? -1 : 1;
  if (!!a.exactTitleMatch !== !!b.exactTitleMatch) return a.exactTitleMatch ? -1 : 1;
  if (Number(b.matchScore || 0) !== Number(a.matchScore || 0)) return Number(b.matchScore || 0) - Number(a.matchScore || 0);
  return `${a.url || ''}`.localeCompare(`${b.url || ''}`);
}

function scoreSuggestion({ row, asset, fallbackConfidence, normalizedName, manufacturerSuggestion, followupAnswer, kind = 'documentation' }) {
  const url = `${row?.url || ''}`.trim();
  const title = `${row?.title || row?.label || ''}`.trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(parsedUrl.protocol)) return null;
  const lowerUrl = url.toLowerCase();
  const lowerHost = parsedUrl.hostname.toLowerCase();
  const lowerPath = parsedUrl.pathname.toLowerCase();
  if (lowerHost.length < 4 || /\.(png|jpg|gif|webp|svg|zip|exe)$/i.test(lowerPath)) return null;
  if (/(redirect|tracker|utm_|clickid=|javascript:|mailto:)/i.test(lowerUrl)) return null;

  const assetTokens = new Set([
    ...tokenize(asset?.name),
    ...tokenize(normalizedName),
    ...tokenize(asset?.manufacturer),
    ...tokenize(manufacturerSuggestion),
    ...tokenize(followupAnswer || asset?.enrichmentFollowupAnswer)
  ]);
  const titleTokens = tokenize(title);

  let score = Math.round(Math.max(0.2, fallbackConfidence) * 25);
  const reasons = [];

  const manufacturerToken = tokenize(asset?.manufacturer || manufacturerSuggestion)[0];
  const manufacturerPhrase = normalizePhrase(asset?.manufacturer || manufacturerSuggestion);
  const manufacturerProfile = getManufacturerProfile(asset?.manufacturer, manufacturerSuggestion, normalizedName, title);
  const titleJoined = title.toLowerCase();
  const combinedText = normalizePhrase(`${title} ${lowerPath} ${lowerHost}`);
  const titleVariants = buildExactTitleVariants(asset?.name, normalizedName);
  const shortTitle = titleVariants.some((variant) => {
    const words = variant.split(' ').filter(Boolean);
    const commonOnly = words.every((word) => COMMON_SHORT_TITLE_WORDS.has(word));
    return words.length <= 2 && variant.length <= 9 && commonOnly;
  });
  const hasExactTitleMatch = titleVariants.some((variant) => combinedText.includes(variant));
  const hasStrongTitleMatch = hasExactTitleMatch || titleVariants.some((variant) => {
    const words = variant.split(' ').filter(Boolean);
    return words.length >= 2 && words.filter((word) => combinedText.includes(word)).length >= Math.max(2, words.length - 1);
  });
  const hasManufacturerAliasMatch = !!manufacturerProfile && [manufacturerProfile.key, ...(manufacturerProfile.aliases || [])]
    .map((alias) => normalizePhrase(alias))
    .filter(Boolean)
    .some((alias) => combinedText.includes(alias));
  const hasTitleManufacturerCombo = hasStrongTitleMatch && ((!!manufacturerPhrase && combinedText.includes(manufacturerPhrase)) || hasManufacturerAliasMatch);
  const preferredSourceMatch = !!manufacturerProfile && (manufacturerProfile.preferredSourceTokens || []).some((token) => lowerHost.includes(token));
  const authorizedSourceMatch = !!manufacturerProfile && (manufacturerProfile.authorizedSourceTokens || []).some((token) => lowerHost.includes(token));
  const lowTrustSourceMatch = !!manufacturerProfile && (manufacturerProfile.lowTrustSourceTokens || []).some((token) => lowerHost.includes(token));
  const sourceType = normalizeSuggestionSourceType(row.sourceType || row.resourceType, { lowerHost, lowTrustSourceMatch });
  const isOfficial = !!manufacturerToken && (lowerHost.includes(manufacturerToken) || sourceType === 'manufacturer');
  const isLikelyManual = MANUAL_INTENT_TOKENS.some((token) => `${titleJoined} ${lowerPath}`.includes(token));
  const hasPdfSignal = /\.pdf($|\?|#)|pdf/.test(`${lowerPath} ${titleJoined}`);
  const isGenericHomepage = lowerPath === '/' || /^\/(home|index(\.html?)?)?$/.test(lowerPath);
  const isGenericManualHub = /manuals?|support|docs?|downloads?|products?|category|catalog/.test(lowerPath) && !hasStrongTitleMatch;
  const isStrictGenericDocumentationPage = isStrictlyGenericDocumentationPage(lowerPath, titleVariants);
  const isGenericSupportJunk = isGenericSupportJunkPage(lowerPath, titleVariants);
  const isDistributorLike = sourceType === 'distributor' || /distributor|betson/.test(lowerHost);
  const hasDirectManualSignal = hasPdfSignal || /download|operator|service|parts|install|manual/.test(`${lowerPath} ${titleJoined}`);
  const isTitleSpecificSupportPage = hasStrongTitleMatch && isOfficial && /support|parts|downloads?|manual|service|install|product/.test(lowerPath);

  if (sourceType === 'manufacturer' || sourceType === 'official_site' || sourceType === 'support' || sourceType === 'parts' || sourceType === 'contact') {
    score += 14;
    reasons.push('manufacturer_source');
  }
  if (sourceType === 'manual_library' || sourceType === 'distributor') {
    score += 12;
    reasons.push('manual_library_source');
  }
  if (isOfficial) {
    score += 12;
    reasons.push('official_host_match');
  }
  if (isLikelyManual) {
    score += 12;
    reasons.push('manual_keyword_match');
  }
  if (TRUSTED_MANUAL_HOST_TOKENS.some((token) => lowerHost.includes(token))) {
    score += 9;
    reasons.push('trusted_manual_host');
  }
  if (manufacturerProfile && manufacturerProfile.sourceTokens.some((token) => lowerHost.includes(token))) {
    score += 18;
    reasons.push('manufacturer_trusted_source_match');
  }
  if (preferredSourceMatch) {
    score += 16;
    reasons.push('manufacturer_preferred_source_match');
  }
  if (authorizedSourceMatch) {
    score += 10;
    reasons.push('manufacturer_authorized_source_match');
  }
  if (manufacturerProfile && /manual|support|docs|service|operators?/.test(lowerPath)) {
    score += 7;
    reasons.push('manufacturer_docs_path_match');
  }

  if (hasStrongTitleMatch) {
    score += 20;
    reasons.push('strong_title_phrase_match');
  }
  if (hasExactTitleMatch) {
    score += 12;
    reasons.push('exact_title_phrase_match');
  }
  if (hasTitleManufacturerCombo) {
    score += 20;
    reasons.push('exact_title_manufacturer_match');
  }
  if (hasStrongTitleMatch && (isLikelyManual || hasPdfSignal)) {
    score += 26;
    reasons.push('exact_title_manual_match');
  }
  if (hasStrongTitleMatch && isOfficial && /support|product|manual|service|parts|install/.test(lowerPath)) {
    score += 14;
    reasons.push('exact_title_official_support_match');
  }

  const overlapCount = titleTokens.filter((token) => assetTokens.has(token)).length;
  score += Math.min(22, overlapCount * 5);
  if (overlapCount >= 3) reasons.push('strong_title_overlap');

  if (titleJoined && normalizedName && titleJoined.includes(`${normalizedName}`.toLowerCase())) {
    score += 15;
    reasons.push('exact_normalized_name');
  }

  if (kind === 'documentation' && isGenericHomepage) {
    score -= 22;
    reasons.push('generic_homepage_penalty');
  }
  if (kind === 'documentation' && isStrictGenericDocumentationPage) {
    score -= 40;
    reasons.push('generic_documentation_landing_penalty');
  }
  if (kind === 'documentation' && isGenericManualHub) {
    score -= 18;
    reasons.push('generic_manual_hub_penalty');
  }
  if (kind === 'documentation' && isGenericManualHub && !hasExactTitleMatch) {
    score -= 20;
    reasons.push('generic_manual_hub_exact_title_penalty');
  }
  if (isDistributorLike && !hasStrongTitleMatch) {
    score -= 24;
    reasons.push('generic_distributor_penalty');
  }
  if (sourceType === 'manual_library' && !hasStrongTitleMatch) {
    score -= 22;
    reasons.push('generic_library_penalty');
  }
  if ((sourceType === 'manual_library' || isDistributorLike) && !hasExactTitleMatch) {
    score -= 18;
    reasons.push('secondary_source_exact_title_penalty');
  }
  if (lowTrustSourceMatch) {
    score -= 8;
    reasons.push('manufacturer_low_trust_source_penalty');
    if (!(hasExactTitleMatch && hasTitleManufacturerCombo && (isLikelyManual || hasPdfSignal))) {
      score -= 20;
      reasons.push('manufacturer_low_trust_source_strictness_penalty');
    }
  }
  if (/forum|reddit|facebook|youtube|pinterest/.test(lowerHost)) {
    score -= 14;
    reasons.push('low_value_host_penalty');
  }
  if (title && overlapCount === 0) {
    score -= 12;
    reasons.push('title_mismatch_penalty');
  }
  if (!title && sourceType !== 'manufacturer') {
    score -= 8;
    reasons.push('missing_title_penalty');
  }

  const modelInAsset = tokenize(asset?.name).find((token) => /\d/.test(token) && token.length >= 3);
  if (modelInAsset && title && !titleJoined.includes(modelInAsset)) {
    score -= 10;
    reasons.push('model_mismatch_penalty');
  }
  const hostMatchesManufacturerEcosystem = !!manufacturerProfile && manufacturerProfile.sourceTokens.some((token) => lowerHost.includes(token));
  if (manufacturerProfile && !hostMatchesManufacturerEcosystem && sourceType !== 'manual_library' && !isOfficial) {
    score -= 16;
    reasons.push('manufacturer_source_mismatch_penalty');
  }

  const manufacturerRequiredForManual = !!manufacturerPhrase || !!manufacturerProfile;
  const manufacturerMatchStrong = !manufacturerRequiredForManual || hasTitleManufacturerCombo || hostMatchesManufacturerEcosystem || isOfficial;
  if (kind === 'documentation' && (!hasStrongTitleMatch || !manufacturerMatchStrong)) {
    score -= 30;
    reasons.push('strict_exactness_penalty');
  }
  if (kind === 'documentation' && !hasDirectManualSignal && !isTitleSpecificSupportPage) {
    score -= 32;
    reasons.push('missing_direct_manual_signal_penalty');
  }
  if (kind === 'documentation' && (sourceType === 'manual_library' || isDistributorLike) && !(hasExactTitleMatch && hasTitleManufacturerCombo)) {
    score -= 16;
    reasons.push('secondary_source_strictness_penalty');
  }

  if (shortTitle && hasStrongTitleMatch && !(hasTitleManufacturerCombo || isLikelyManual || isOfficial || manufacturerProfile)) {
    score -= 18;
    reasons.push('short_title_weak_signal_penalty');
  }
  if (manufacturerProfile && /pinball/.test((manufacturerProfile.categories || []).join(' ')) && !/pinball|ipdb|stern|bally|midway/.test(`${lowerHost} ${titleJoined}`)) {
    score -= 8;
    reasons.push('category_mismatch_penalty');
  }

  if (kind === 'support' && /official_site|support|parts|contact/.test(sourceType)) {
    score += 8;
    reasons.push('support_resource_bias');
  }
  if (kind === 'support' && isGenericSupportJunk) {
    score -= 40;
    reasons.push('generic_support_junk_penalty');
    if (!hasStrongTitleMatch || !hasDirectManualSignal) return null;
  }

  if (kind === 'documentation') {
    const rejectForGenericLanding = (isGenericHomepage || isStrictGenericDocumentationPage || isGenericManualHub)
      && !(hasStrongTitleMatch && (hasDirectManualSignal || isTitleSpecificSupportPage));
    const rejectForWeakEvidence = !hasStrongTitleMatch || !manufacturerMatchStrong || (!hasDirectManualSignal && !isTitleSpecificSupportPage);
    if (rejectForGenericLanding) return null;
    if ((sourceType === 'manual_library' || isDistributorLike) && !(hasExactTitleMatch && (hasTitleManufacturerCombo || (hasDirectManualSignal && !!manufacturerProfile)))) {
      return null;
    }
    if (rejectForWeakEvidence) return null;
  }

  const bounded = Math.max(0, Math.min(100, score));
  const minimumScore = kind === 'documentation' ? 48 : 40;
  if (bounded < minimumScore) return null;

  const suggestion = {
    title: row.title || row.label || 'Candidate documentation',
    url,
    assetName: asset?.name || '',
    normalizedName: normalizedName || asset?.normalizedName || asset?.name || '',
    confidence: fallbackConfidence,
    sourceType: sourceType || 'other',
    matchScore: bounded,
    isOfficial,
    isLikelyManual,
    exactTitleMatch: hasExactTitleMatch,
    exactManualMatch: hasStrongTitleMatch && (isLikelyManual || hasPdfSignal),
    trustedSource: isOfficial || !!manufacturerProfile || TRUSTED_MANUAL_HOST_TOKENS.some((token) => lowerHost.includes(token)),
    matchedManufacturer: manufacturerProfile?.key || '',
    sourceTrustReason: (preferredSourceMatch
      ? 'manufacturer_preferred_source_match'
      : (reasons.find((reason) => /manufacturer_trusted_source_match|trusted_manual_host|official_host_match/.test(reason)) || '')),
    reason: reasons.slice(0, 8).join(',') || 'basic_match',
    lookupMethod: row.lookupMethod || '',
    matchStatus: row.matchStatus || '',
    verificationMetadata: row.verificationMetadata || null,
    notes: row.notes || '',
    catalogEntryId: row.catalogEntryId || '',
    linkType: row.linkType || ''
  };

  return {
    ...suggestion,
    rankTier: getDocumentationSuggestionRank(suggestion)
  };
}

function normalizeDocumentationSuggestions({ links, confidence, asset, normalizedName, manufacturerSuggestion, followupAnswer, kind = 'documentation' }) {
  if (!Array.isArray(links)) return [];
  const fallbackConfidence = Math.max(0.35, Number(confidence) || 0);

  return links
    .map((row) => scoreSuggestion({
      row,
      asset,
      fallbackConfidence,
      normalizedName,
      manufacturerSuggestion,
      followupAnswer,
      kind
    }))
    .filter(Boolean)
    .sort(compareDocumentationSuggestions)
    .slice(0, 5);
}

function isLiveManualCandidate(entry = {}) {
  if (!entry?.url || entry?.deadPage) return false;
  const directFile = isDirectDocumentationFileSuggestion(entry);
  const manualBearingHtml = isTitleSpecificManualBearingHtmlSuggestion(entry);
  if (isSeededCatalogManualCandidate(entry)) return true;
  if (entry?.unreachable) return false;
  if (!entry?.verified || !entry?.exactTitleMatch) return false;
  if (manualBearingHtml) return true;
  if (directFile) return !!entry?.exactManualMatch;
  const sourceType = `${entry?.sourceType || entry?.resourceType || ''}`.toLowerCase();
  if (SUPPORT_ONLY_SOURCE_TYPES.has(sourceType)) return false;
  return !!entry?.exactManualMatch;
}

function isManualUsableSuggestion(entry = {}) {
  if (!isLiveManualCandidate(entry)) return false;
  if (isAmbiguousManualCandidate(entry)) return false;
  const url = `${entry?.url || ''}`.toLowerCase();
  const sourceType = `${entry?.sourceType || entry?.resourceType || ''}`.toLowerCase();
  const manualBearingHtml = isTitleSpecificManualBearingHtmlSuggestion(entry);
  if (SUPPORT_ONLY_SOURCE_TYPES.has(sourceType) && !manualBearingHtml && !/\.pdf($|\?|#)|manual|operator|service|install|parts/.test(url)) return false;
  return true;
}

function isMeaningfulSupportResource(entry = {}) {
  const url = `${entry?.url || ''}`.trim();
  if (!url || entry?.deadPage || entry?.unreachable) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const lowerPath = parsed.pathname.toLowerCase();
  const lowerUrl = url.toLowerCase();
  const genericSupportHub = /^\/(support|service-support|services?)\/?$/.test(lowerPath);
  const supportishSourceType = SUPPORT_ONLY_SOURCE_TYPES.has(`${entry?.sourceType || entry?.resourceType || ''}`.toLowerCase());
  if (isGenericSupportJunkPage(lowerPath, buildExactTitleVariants(entry?.assetName, entry?.normalizedName)) && !(genericSupportHub && supportishSourceType)) return false;
  if (/\/wp-comments-post\.php|\/feed\/?$/.test(lowerPath)) return false;
  if (JUNK_URL_FRAGMENT_PATTERNS.some((pattern) => pattern.test(`${parsed.hash || ''}`.replace(/^#/, '')))) return false;
  return /support|manual|service|help|product|game|parts|download|docs?/.test(lowerUrl)
    || SUPPORT_ONLY_SOURCE_TYPES.has(`${entry?.sourceType || entry?.resourceType || ''}`.toLowerCase())
    || Number(entry?.matchScore || 0) >= 45;
}


function isPreservableVerifiedManualSuggestion(entry = {}) {
  const url = `${entry?.url || ''}`.trim().toLowerCase();
  if (!url) return false;
  if (!isManualUsableSuggestion(entry)) return false;
  const directFile = isDirectDocumentationFileSuggestion(entry);
  return directFile || getDocumentationSuggestionRank(entry) <= 1;
}

function dedupeDocumentationSuggestions(rows = []) {
  const sorted = rows
    .map((row) => ({ ...row, url: sanitizeSuggestionUrl(row?.url || '') }))
    .filter((row) => row?.url)
    .map((row) => ({ ...row, title: normalizeSuggestionTitle(row) || row.title || row.url, rankTier: getDocumentationSuggestionRank(row) }))
    .sort(compareDocumentationSuggestions);
  const seen = new Set();
  return sorted.filter((row) => {
    const key = `${row.url || ''}`.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeDocumentationSuggestions({ existingSuggestions, nextSuggestions, preserveExistingCandidates = false }) {
  const preserved = preserveExistingCandidates
    ? (Array.isArray(existingSuggestions) ? existingSuggestions : [])
    : (Array.isArray(existingSuggestions) ? existingSuggestions : []).filter(isPreservableVerifiedManualSuggestion);
  return dedupeDocumentationSuggestions([
    ...(Array.isArray(nextSuggestions) ? nextSuggestions : []),
    ...preserved
  ]).slice(0, 5);
}

function hasUsableVerifiedManualSuggestion(suggestions = []) {
  return (Array.isArray(suggestions) ? suggestions : []).some((entry) => isManualUsableSuggestion(entry));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = VERIFY_TIMEOUT_MS, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      redirect: 'follow',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function detectDeadPageText(rawText) {
  const text = `${rawText || ''}`.slice(0, 3000);
  return DEAD_PAGE_PATTERNS.some((pattern) => pattern.test(text)) || SOFT_404_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function detectVerificationKind(url = '', contentType = '', snippet = '') {
  const lowerUrl = `${url || ''}`.toLowerCase();
  const lowerType = `${contentType || ''}`.toLowerCase();
  const lowerSnippet = `${snippet || ''}`.toLowerCase();
  const isPdf = /application\/pdf/.test(lowerType) || /\.pdf($|\?|#)/.test(lowerUrl);
  const isHtml = /text\/html|application\/xhtml\+xml/.test(lowerType) || (!lowerType && /^https?:/.test(lowerUrl));
  const manualSignal = /\bmanuals?\b|\boperator\b|\bservice manuals?\b|\bparts manuals?\b|\binstall(?:ation)?(?: guide| manual)?\b|\bdownloads?\b|\bpdf\b/.test(`${lowerUrl} ${lowerSnippet}`);
  if (isPdf) return 'direct_pdf';
  if (isHtml && manualSignal) return 'manual_html';
  if (isHtml) return 'support_html';
  return 'other';
}

function isCachedManualCandidate(entry = {}) {
  return !!(`${entry?.cachedManual || ''}` === 'true' || entry?.cachedManual === true || `${entry?.manualLibraryRef || ''}`.trim() || `${entry?.manualStoragePath || ''}`.trim() || `${entry?.sourceType || ''}`.trim().toLowerCase() === 'manual_library');
}

async function verifySuggestionUrl(url, fetchImpl = fetch) {
  let headResponse = null;
  try {
    headResponse = await fetchWithTimeout(url, {
      method: 'HEAD',
      headers: { 'user-agent': 'techops-asset-enrichment/1.0' }
    }, VERIFY_TIMEOUT_MS, fetchImpl);
  } catch {
    headResponse = null;
  }

  const shouldFallbackToGet = !headResponse || [400, 403, 405, 501].includes(headResponse.status) || (headResponse.status >= 404);

  let getResponse = null;
  let pageSnippet = '';
  if (shouldFallbackToGet || (headResponse && headResponse.ok)) {
    try {
      getResponse = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'user-agent': 'techops-asset-enrichment/1.0',
          range: 'bytes=0-2500'
        }
      }, VERIFY_TIMEOUT_MS, fetchImpl);
      pageSnippet = await getResponse.text();
    } catch {
      if (!headResponse) {
        return {
          verified: false,
          unreachable: true,
          deadPage: false,
          verificationStatus: 'unreachable',
          httpStatus: null
        };
      }
    }
  }

  const response = getResponse || headResponse;
  if (!response) {
    return {
      verified: false,
      unreachable: true,
      deadPage: false,
      verificationStatus: 'unreachable',
      httpStatus: null
    };
  }

  const httpStatus = Number(response.status) || null;
  const contentType = `${response.headers?.get?.('content-type') || ''}`.toLowerCase();
  const resolvedUrl = `${response.url || ''}`.toLowerCase();
  const sourceUrl = `${url || ''}`.toLowerCase();
  const redirectedToLikelyError = resolvedUrl && sourceUrl && resolvedUrl !== sourceUrl && /404|error|not[-_ ]?found/.test(resolvedUrl);
  const deadByStatus = httpStatus === 404 || httpStatus === 410 || httpStatus >= 500;
  const deadByContentType = !!contentType && !/text\/html|application\/pdf|text\/plain/.test(contentType);
  const deadByText = !!pageSnippet && detectDeadPageText(pageSnippet);
  const verificationKind = detectVerificationKind(url, contentType, pageSnippet);
  const directPdf = verificationKind === 'direct_pdf';
  const deadPage = deadByStatus || deadByText || redirectedToLikelyError || deadByContentType;
  const verified = response.ok && !deadPage && (directPdf || verificationKind === 'manual_html');

  return {
    verified,
    unreachable: false,
    deadPage,
    verificationStatus: verified ? 'verified' : (deadPage ? 'dead_page' : 'unverified'),
    httpStatus,
    contentType,
    directPdf,
    verificationKind,
    soft404: deadByText,
    resolvedUrl: response.url || url
  };
}

async function verifyDocumentationSuggestions(suggestions, fetchImpl = fetch) {
  const bounded = Array.isArray(suggestions) ? suggestions.slice(0, VERIFY_MAX_SUGGESTIONS) : [];
  const verifiedRows = await Promise.all(
    bounded.map(async (row) => {
      if (isCachedManualCandidate(row)) {
        return sanitizeManualCandidate({
          ...row,
          url: row.url || row.manualStoragePath || '',
          verified: true,
          deadPage: false,
          unreachable: false,
          verificationStatus: row.verificationStatus || 'cached_manual',
          verificationKind: row.verificationKind || 'direct_pdf',
          directPdf: true,
          trustedSource: row.trustedSource !== false,
          exactTitleMatch: row.exactTitleMatch !== false,
          exactManualMatch: row.exactManualMatch !== false,
        });
      }
      const verification = await verifySuggestionUrl(row.url, fetchImpl);
      const manualHtmlCandidate = {
        ...row,
        ...verification
      };
      const strongExactManual = Number(row.matchScore || 0) >= 72 && !!row.exactTitleMatch && !!row.exactManualMatch;
      const seededCatalogManual = isSeededCatalogManualCandidate({
        ...row,
        ...verification
      });
      const strongMatch = verification.verificationKind === 'manual_html'
        ? (strongExactManual && isTitleSpecificManualBearingHtmlSuggestion(manualHtmlCandidate))
        : strongExactManual;
      const strongManualBearingPage = verification.verified
        && Number(row.matchScore || 0) >= 68
        && isTitleSpecificManualBearingHtmlSuggestion(manualHtmlCandidate);
      const aliveAndStrong = seededCatalogManual || (verification.verified && (strongMatch || strongManualBearingPage));
      return sanitizeManualCandidate({
        ...row,
        ...verification,
        verified: aliveAndStrong,
        verificationStatus: aliveAndStrong
          ? (seededCatalogManual && !verification.verified ? 'seed_verified' : 'verified')
          : verification.verificationStatus
      });
    })
  );

  return verifiedRows
    .map((row) => ({ ...row, rankTier: getDocumentationSuggestionRank(row) }))
    .sort(compareDocumentationSuggestions);
}

function cleanDocumentationSuggestions(rows = []) {
  return dedupeDocumentationSuggestions(rows)
    .map((entry) => sanitizeManualCandidate(entry))
    .filter((entry) => isManualUsableSuggestion(entry));
}

function cleanSupportResourcesSuggestion(rows = [], documentationSuggestions = []) {
  const docUrls = new Set(cleanDocumentationSuggestions(documentationSuggestions).map((entry) => `${entry.url || ''}`.trim().toLowerCase()));
  return dedupeDocumentationSuggestions(rows)
    .filter((entry) => !docUrls.has(`${entry.url || ''}`.trim().toLowerCase()))
    .filter((entry) => !isManualUsableSuggestion(entry))
    .filter((entry) => isMeaningfulSupportResource(entry))
    .slice(0, 5);
}

function hasMeaningfulSupportContext(rows = []) {
  return cleanSupportResourcesSuggestion(rows).length > 0;
}

function resolveTerminalEnrichmentStatus({ documentationSuggestions = [], supportResourcesSuggestion = [], followupQuestion = '', hadFailure = false, manualMatchSummary = null }) {
  if (hadFailure) return 'lookup_failed';
  const manualReady = typeof manualMatchSummary?.manualReady === 'boolean'
    ? manualMatchSummary.manualReady
    : cleanDocumentationSuggestions(documentationSuggestions).length > 0;
  if (manualReady) return 'docs_found';
  if (`${followupQuestion || ''}`.trim() || hasMeaningfulSupportContext(supportResourcesSuggestion)) return 'followup_needed';
  return 'no_match_yet';
}

function deriveDocumentationReviewState(asset = {}) {
  const current = `${asset.reviewState || ''}`.trim();
  if (['approved', 'rejected'].includes(current)) return current;
  const status = `${asset.enrichmentStatus || ''}`.trim();
  const liveDocs = cleanDocumentationSuggestions(asset.documentationSuggestions || []);
  if (liveDocs.length || status === 'docs_found') return REVIEWABLE_DOC_STATE;
  if (status === 'followup_needed' || `${asset.enrichmentFollowupQuestion || ''}`.trim() || hasMeaningfulSupportContext(asset.supportResourcesSuggestion || [])) return FOLLOWUP_RESEARCH_STATE;
  if (status === 'no_match_yet') return NO_MATCH_RESEARCH_STATE;
  return current || 'idle';
}

function cleanFinalEnrichmentResult(asset = {}) {
  const initialDocumentationSuggestions = cleanDocumentationSuggestions(asset.documentationSuggestions || []);
  const rehydratedDocumentationSuggestions = rehydrateSeededManualDocumentationSuggestions({
    asset,
    documentationSuggestions: asset.documentationSuggestions || [],
    supportResourcesSuggestion: asset.supportResourcesSuggestion || [],
    normalizedName: asset.normalizedName || asset.name || '',
    manufacturerSuggestion: asset.manufacturerSuggestion || asset.manufacturer || '',
    followupAnswer: asset.enrichmentFollowupAnswer || ''
  });
  const documentationSuggestions = initialDocumentationSuggestions.length
    ? initialDocumentationSuggestions
    : cleanDocumentationSuggestions(rehydratedDocumentationSuggestions);
  const supportResourcesSuggestion = cleanSupportResourcesSuggestion(asset.supportResourcesSuggestion || [], documentationSuggestions);
  const enrichmentFollowupQuestion = `${asset.enrichmentFollowupQuestion || ''}`.trim();
  const manualMatchSummary = classifyManualMatchSummary({
    inputTitle: asset.name || asset.normalizedName || '',
    titleFamily: resolveArcadeTitleFamily({ title: asset.normalizedName || asset.name || '', manufacturer: asset.manufacturerSuggestion || asset.manufacturer || '' }),
    documentationSuggestions,
    supportResourcesSuggestion,
    supportContactsSuggestion: asset.supportContactsSuggestion || [],
    confidence: Number(asset.enrichmentConfidence || 0),
    topMatchReason: asset.topMatchReason || '',
    catalogMatch: asset.manualLookupCatalogMatch || null
  });
  const enrichmentStatus = resolveTerminalEnrichmentStatus({
    documentationSuggestions,
    supportResourcesSuggestion,
    followupQuestion: enrichmentFollowupQuestion,
    hadFailure: false,
    manualMatchSummary
  });
  const reviewState = deriveDocumentationReviewState({
    ...asset,
    documentationSuggestions,
    supportResourcesSuggestion,
    enrichmentStatus,
    enrichmentFollowupQuestion
  });
  return {
    documentationSuggestions,
    supportResourcesSuggestion,
    manualMatchSummary,
    enrichmentFollowupQuestion: enrichmentStatus === 'docs_found' ? '' : enrichmentFollowupQuestion,
    enrichmentStatus,
    reviewState
  };
}

async function repairLegacyAssetEnrichmentRecord({ asset = {}, verifySuggestions = verifyDocumentationSuggestions }) {
  const rehydratedSeededDocs = rehydrateSeededManualDocumentationSuggestions({
    asset,
    documentationSuggestions: asset.documentationSuggestions || [],
    supportResourcesSuggestion: asset.supportResourcesSuggestion || [],
    normalizedName: asset.normalizedName || asset.name || '',
    manufacturerSuggestion: asset.manufacturerSuggestion || asset.manufacturer || '',
    followupAnswer: asset.enrichmentFollowupAnswer || ''
  });
  const docsToVerify = Array.isArray(asset.documentationSuggestions) && asset.documentationSuggestions.length
    ? asset.documentationSuggestions
    : rehydratedSeededDocs;
  const verifiedDocs = Array.isArray(docsToVerify) && docsToVerify.length
    ? await verifySuggestions(docsToVerify)
    : [];
  const cleaned = cleanFinalEnrichmentResult({
    ...asset,
    documentationSuggestions: verifiedDocs.length ? verifiedDocs : (asset.documentationSuggestions || []),
    supportResourcesSuggestion: asset.supportResourcesSuggestion || []
  });
  const hasExceptionContext = !!(`${asset.enrichmentErrorCode || ''}`.trim() || `${asset.enrichmentErrorMessage || ''}`.trim() || asset.enrichmentFailedAt);
  const shouldRetainFailureMetadata = cleaned.enrichmentStatus === 'lookup_failed' && hasExceptionContext;
  return {
    ...cleaned,
    enrichmentFailedAt: shouldRetainFailureMetadata ? asset.enrichmentFailedAt : null,
    enrichmentErrorCode: shouldRetainFailureMetadata ? asset.enrichmentErrorCode : '',
    enrichmentErrorMessage: shouldRetainFailureMetadata ? asset.enrichmentErrorMessage : ''
  };
}

async function recoverCatalogSourcePageManuals({ catalogMatch, draftAsset, normalizedName, manufacturerSuggestion, manufacturerProfile, fetchImpl = fetch }) {
  const sourcePages = (catalogMatch?.supportResources || []).filter((entry) => entry?.url);
  if (!sourcePages.length) return [];
  const recovered = [];
  for (const page of sourcePages.slice(0, 2)) {
    let verification = null;
    try {
      verification = await verifySuggestionUrl(page.url, fetchImpl);
    } catch {
      verification = { deadPage: false, unreachable: true };
    }
    if (verification.deadPage || verification.unreachable) continue;
    const extracted = await extractManualLinksFromHtmlPage({
      pageUrl: page.url,
      pageTitle: page.title || draftAsset?.name || normalizedName,
      manufacturer: manufacturerSuggestion || draftAsset?.manufacturer || '',
      titleVariants: buildExactTitleVariants(draftAsset?.name, normalizedName),
      manufacturerProfile,
      fetchImpl,
      logEvent: () => {}
    }).catch(() => []);
    recovered.push(...extracted.map((entry) => ({ ...entry, sourcePageUrl: page.url, recoveredFromCatalogSourcePage: true })));
  }
  return recovered;
}

async function shouldDiscoverAfterCatalogMatch({ catalogMatch, confidence, draftAsset, normalizedName, manufacturerSuggestion, followupAnswer, fetchImpl = fetch }) {
  if (!catalogMatch) return true;
  const normalizedCatalogSuggestions = normalizeDocumentationSuggestions({
    links: catalogMatch.documentationSuggestions,
    confidence: Math.max(confidence, Number(catalogMatch.confidence || 0.95)),
    asset: draftAsset || {},
    normalizedName,
    manufacturerSuggestion,
    followupAnswer
  });
  if (!normalizedCatalogSuggestions.length) return true;

  const verifiedCatalogSuggestions = await verifyDocumentationSuggestions(normalizedCatalogSuggestions, fetchImpl);
  const hasHealthyCatalogSuggestion = cleanDocumentationSuggestions(verifiedCatalogSuggestions).length > 0;
  return !hasHealthyCatalogSuggestion;
}

async function runLookupPreview({ settings, traceId, draftAsset, fetchImpl = fetch }) {
  const { researchAssetTitles } = require('./manualResearchService');
  const result = await researchAssetTitles({
    db: admin.firestore(),
    settings,
    companyId: `${draftAsset?.companyId || ''}`.trim() || 'preview',
    titles: [{
      originalTitle: `${draftAsset?.name || ''}`.trim(),
      manufacturerHint: `${draftAsset?.manufacturer || ''}`.trim(),
      assetId: `${draftAsset?.assetId || ''}`.trim(),
    }],
    includeInternalDocs: true,
    maxWebSources: Number(settings.manualResearchMaxWebSources || 5),
    traceId,
    fetchImpl,
  });
  const [entry] = result.results || [];
  const titleFamily = resolveArcadeTitleFamily({
    title: draftAsset?.name || '',
    manufacturer: draftAsset?.manufacturer || '',
  });
  const confidence = Number(entry?.confidence || 0);
  const confidenceThreshold = settings.aiConfidenceThreshold || 0.45;
  const hasPreviewManual = Array.isArray(entry?.documentationSuggestions)
    && entry.documentationSuggestions.some((doc) => `${doc?.url || ''}`.trim() && doc.exactManualMatch);
  const status = confidence >= confidenceThreshold && hasPreviewManual
    ? 'found_suggestions'
    : (entry?.reviewRequired ? 'needs_follow_up' : 'no_strong_match');

  return {
    status,
    normalizedName: entry?.normalizedTitle || draftAsset?.name || '',
    likelyManufacturer: entry?.manufacturer || draftAsset?.manufacturer || '',
    likelyCategory: '',
    confidence,
    oneFollowupQuestion: entry?.reviewRequired && entry?.variantWarning ? entry.variantWarning : '',
    topMatchReason: entry?.matchNotes || '',
    alternateNames: Array.from(new Set(titleFamily.alternateTitles || [])).filter(Boolean),
    searchHints: [],
    documentationSuggestions: entry?.documentationSuggestions || [],
    supportResourcesSuggestion: entry?.supportResourcesSuggestion || [],
    supportContactsSuggestion: entry?.supportContactsSuggestion || [],
    assetResearchSummary: entry?.manualMatchSummary || entry,
    manualMatchSummary: entry?.manualMatchSummary || entry,
    matchType: entry?.matchType || '',
    manualReady: entry?.manualReady === true,
    manualUrl: entry?.manualUrl || '',
    manualLibraryRef: entry?.manualLibraryRef || '',
    manualStoragePath: entry?.manualStoragePath || '',
    manualSourceUrl: entry?.manualSourceUrl || '',
    supportUrl: entry?.supportUrl || '',
    supportEmail: entry?.supportEmail || '',
    supportPhone: entry?.supportPhone || '',
    matchNotes: entry?.matchNotes || '',
    variantWarning: entry?.variantWarning || '',
    reviewRequired: entry?.reviewRequired !== false,
    matchedManufacturer: normalizePhrase(entry?.manufacturer || ''),
    pipelineMeta: entry?.pipelineMeta || {},
    catalogMatch: null,
  };
}

function buildSingleAssetDocLog(event, payload = {}) {
  try { console.log(`singleAssetDocs:${event}`, payload); } catch (error) { void error; }
}

function buildSingleAssetDocumentationFields({ preview = {}, cleanedResult = {}, matchedManufacturer = '', existingAsset = {} } = {}) {
  const manualMatchSummary = cleanedResult.manualMatchSummary || preview.manualMatchSummary || {};
  const documentationSuggestions = Array.isArray(cleanedResult.documentationSuggestions) ? cleanedResult.documentationSuggestions : [];
  const topManual = documentationSuggestions.find((entry) => isManualUsableSuggestion(entry)) || documentationSuggestions[0] || null;
  const supportResources = Array.isArray(cleanedResult.supportResourcesSuggestion) ? cleanedResult.supportResourcesSuggestion : [];
  const supportResource = supportResources.find((entry) => `${entry?.url || ''}`.trim()) || null;
  const manualLibraryRef = `${manualMatchSummary.manualLibraryRef || topManual?.manualLibraryRef || existingAsset.manualLibraryRef || ''}`.trim();
  const manualStoragePath = `${manualMatchSummary.manualStoragePath || topManual?.manualStoragePath || existingAsset.manualStoragePath || ''}`.trim();
  const manualUrl = `${manualStoragePath || manualMatchSummary.manualUrl || topManual?.url || ''}`.trim();
  const manualLinks = manualUrl ? [manualUrl] : [];
  return {
    manualLinks,
    manualLibraryRef,
    manualStoragePath,
    manualSourceUrl: `${manualMatchSummary.manualSourceUrl || topManual?.sourcePageUrl || preview.manualSourceUrl || existingAsset.manualSourceUrl || ''}`.trim(),
    supportUrl: `${manualMatchSummary.supportUrl || supportResource?.url || preview.supportUrl || existingAsset.supportUrl || ''}`.trim(),
    matchType: `${manualMatchSummary.matchType || preview.matchType || ''}`.trim(),
    manualReady: manualMatchSummary.manualReady === true,
    matchedManufacturer: matchedManufacturer || `${preview.matchedManufacturer || ''}`.trim(),
  };
}

async function enrichAssetDocumentation({ db, assetId, userId, settings, triggerSource, followupAnswer, traceId, dependencies = {} }) {
  const startedAt = Date.now();
  const assetRef = db.collection('assets').doc(assetId);
  const assetSnap = await assetRef.get();
  if (!assetSnap.exists) throw new HttpsError('not-found', 'Asset not found');
  const asset = assetSnap.data() || {};
  const runLookup = dependencies.runLookupPreview || runLookupPreview;
  const verifySuggestions = dependencies.verifyDocumentationSuggestions || verifyDocumentationSuggestions;
  const findReusableManuals = dependencies.findReusableVerifiedManuals || findReusableVerifiedManuals;
  const log = buildAssetEnrichmentLogger({ traceId, assetId, triggerSource });
  const callablePath = 'enrichAssetDocumentation';

  log('start', {
    existingStatus: asset.enrichmentStatus || 'idle',
    followupProvided: Boolean(`${followupAnswer || ''}`.trim())
  });
  buildSingleAssetDocLog('start', {
    assetId,
    title: asset.name || '',
    manufacturer: asset.manufacturer || '',
    callablePath,
    triggerSource,
  });

  await assetRef.set({
    enrichmentStatus: triggerSource === 'post_save' ? 'searching_docs' : 'in_progress',
    enrichmentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    enrichmentFailedAt: null,
    enrichmentErrorCode: '',
    enrichmentErrorMessage: '',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId
  }, { merge: true });

  let terminalStatus = '';
  try {
    const preview = await runLookup({
      settings,
      traceId,
      draftAsset: { ...asset, assetId, followupAnswer }
    });

    const confidence = Number(preview?.confidence || 0);
    const pipelineMeta = preview?.pipelineMeta || preview?.assetResearchSummary?.pipelineMeta || {};
    const normalizedName = preview?.normalizedName || asset.name || '';
    const manufacturerSuggestion = preview?.likelyManufacturer || '';
    const manufacturerProfile = getManufacturerProfile(asset?.manufacturer, manufacturerSuggestion, normalizedName, preview?.likelyCategory);
    const matchedManufacturer = manufacturerProfile?.key || normalizePhrase(manufacturerSuggestion);

    buildSingleAssetDocLog('stage1_result', {
      assetId,
      title: asset.name || normalizedName || '',
      manufacturer: asset.manufacturer || manufacturerSuggestion || '',
      callablePath,
      stage2Ran: pipelineMeta.stage2Ran === true,
      acquisitionSucceeded: pipelineMeta.acquisitionSucceeded === true,
      acquisitionState: pipelineMeta.acquisitionState || '',
      manualLibraryRef: pipelineMeta.manualLibraryRef || preview?.manualLibraryRef || '',
      matchType: preview?.matchType || '',
      manualReady: preview?.manualReady === true,
      elapsedMs: Date.now() - startedAt,
    });

    if (pipelineMeta.stage2Ran === true) {
      buildSingleAssetDocLog('stage2_invoked', {
        assetId,
        title: asset.name || normalizedName || '',
        manufacturer: asset.manufacturer || manufacturerSuggestion || '',
        callablePath,
        stage1MatchType: pipelineMeta.stage1MatchType || '',
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (['started', 'timed_out', 'failed', 'succeeded', 'no_manual'].includes(`${pipelineMeta.acquisitionState || ''}`)) {
      buildSingleAssetDocLog('acquisition_start', {
        assetId,
        title: asset.name || normalizedName || '',
        manufacturer: asset.manufacturer || manufacturerSuggestion || '',
        callablePath,
        acquisitionState: pipelineMeta.acquisitionState || '',
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (pipelineMeta.acquisitionState === 'timed_out') {
      buildSingleAssetDocLog('acquisition_timeout', {
        assetId,
        title: asset.name || normalizedName || '',
        manufacturer: asset.manufacturer || manufacturerSuggestion || '',
        callablePath,
        reason: pipelineMeta.acquisitionError || 'Manual acquisition timed out.',
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (pipelineMeta.acquisitionState === 'failed') {
      buildSingleAssetDocLog('acquisition_failed', {
        assetId,
        title: asset.name || normalizedName || '',
        manufacturer: asset.manufacturer || manufacturerSuggestion || '',
        callablePath,
        reason: pipelineMeta.acquisitionError || 'Manual acquisition failed.',
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (pipelineMeta.sourcePageExtracted === true) {
      buildSingleAssetDocLog('source_page_extracted', {
        assetId,
        title: asset.name || normalizedName || '',
        manufacturer: asset.manufacturer || manufacturerSuggestion || '',
        callablePath,
        sourcePageUrl: preview?.manualSourceUrl || '',
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (pipelineMeta.acquisitionSucceeded === true) {
      buildSingleAssetDocLog('manual_acquired', {
        assetId,
        title: asset.name || normalizedName || '',
        manufacturer: asset.manufacturer || manufacturerSuggestion || '',
        callablePath,
        manualLibraryRef: pipelineMeta.manualLibraryRef || preview?.manualLibraryRef || '',
        manualStoragePath: pipelineMeta.manualStoragePath || preview?.manualStoragePath || '',
        elapsedMs: Date.now() - startedAt,
      });
    }

    log('catalog_match_decision', {
      matchedManufacturer: matchedManufacturer || '',
      catalogMatch: Boolean(preview?.catalogMatch),
      previewDocumentationSuggestions: Array.isArray(preview?.documentationSuggestions) ? preview.documentationSuggestions.length : 0
    });
    log('discovery_start', {
      searchHints: Array.isArray(preview?.searchHints) ? preview.searchHints.length : 0
    });
    log('discovery_complete', {
      documentationSuggestions: Array.isArray(preview?.documentationSuggestions) ? preview.documentationSuggestions.length : 0,
      supportResourcesSuggestion: Array.isArray(preview?.supportResourcesSuggestion) ? preview.supportResourcesSuggestion.length : 0
    });

    const catalogMatch = preview?.catalogMatch
      ? findCatalogManualMatch({
        assetName: asset?.name || '',
        normalizedName,
        manufacturer: manufacturerSuggestion || asset?.manufacturer || '',
        manufacturerProfile,
        alternateNames: Array.isArray(preview?.alternateNames) ? preview.alternateNames : []
      })
      : null;
    const catalogSuggestions = catalogMatch
      ? normalizeDocumentationSuggestions({
        links: catalogMatch.documentationSuggestions,
        confidence: Math.max(confidence, Number(catalogMatch.confidence || 0.95)),
        asset: asset || {},
        normalizedName,
        manufacturerSuggestion,
        followupAnswer
      })
      : [];
    const reusedSuggestions = await findReusableManuals({
      db,
      asset: { ...asset, normalizedName },
      assetId,
      companyId: asset.companyId || '',
      matchedManufacturer
    });
    const suggestions = mergeDocumentationSuggestions({
      existingSuggestions: asset.documentationSuggestions || [],
      nextSuggestions: [
        ...(await verifySuggestions([...(preview.documentationSuggestions || []), ...catalogSuggestions])),
        ...reusedSuggestions
      ]
    });
    const confidenceThreshold = settings.aiConfidenceThreshold || 0.45;

    const strongSuggestions = suggestions.filter((s) => {
      const scoreGate = s.matchScore >= 80 || (s.isOfficial && s.matchScore >= 76);
      const exactGate = !!s.exactTitleMatch && !!s.exactManualMatch;
      return scoreGate && exactGate;
    });
    const strongVerifiedSuggestions = strongSuggestions.filter((s) => s.verified && s.trustedSource);
    const hasUsableVerifiedManual = hasUsableVerifiedManualSuggestion(suggestions);
    const hasConfidentSingleMatch = confidence >= confidenceThreshold && strongVerifiedSuggestions.length === 1;
    const topSuggestionScore = suggestions[0]?.matchScore || 0;
    const isAmbiguousTitle = suggestions.length > 1 && topSuggestionScore < 78;
    const hasOnlyFailedVerification = suggestions.length > 0 && !strongVerifiedSuggestions.length;
    const hasMeaningfulSupportOrFollowupContext = hasMeaningfulSupportContext(preview.supportResourcesSuggestion || [])
      || !!(`${preview?.oneFollowupQuestion || ''}`.trim());

    const followupQuestion = hasUsableVerifiedManual
      ? ''
      : (!suggestions.length && !hasMeaningfulSupportOrFollowupContext
        ? ''
      : (hasConfidentSingleMatch
        ? ''
        : (isAmbiguousTitle
          ? 'What exact cabinet nameplate text or subtitle/version appears under the logo (for example DX/Deluxe/SDX)?'
          : buildFollowupQuestion({
            parsedQuestion: preview?.oneFollowupQuestion,
            profile: manufacturerProfile,
            likelyCategory: preview?.likelyCategory,
            hasOnlyFailedVerification
          }))));
    const shouldSetManufacturer = !asset.manufacturer && confidence >= Math.max(0.75, confidenceThreshold) && manufacturerSuggestion;

    const cleanedResult = cleanFinalEnrichmentResult({
      ...asset,
      name: asset.name || normalizedName,
      normalizedName,
      manufacturer: asset.manufacturer || manufacturerSuggestion || '',
      manufacturerSuggestion,
      enrichmentConfidence: confidence,
      topMatchReason: preview.topMatchReason || '',
      manualLookupCatalogMatch: preview.catalogMatch || null,
      supportContactsSuggestion: preview.supportContactsSuggestion || [],
      documentationSuggestions: suggestions,
      supportResourcesSuggestion: preview.supportResourcesSuggestion || [],
      enrichmentFollowupQuestion: followupQuestion
    });
    const status = resolveTerminalEnrichmentStatus({
      documentationSuggestions: cleanedResult.documentationSuggestions,
      supportResourcesSuggestion: cleanedResult.supportResourcesSuggestion,
      followupQuestion: cleanedResult.enrichmentFollowupQuestion,
      manualMatchSummary: cleanedResult.manualMatchSummary
    });
    terminalStatus = status;

    log('final_counts', {
      documentationSuggestions: cleanedResult.documentationSuggestions.length,
      supportResourcesSuggestion: cleanedResult.supportResourcesSuggestion.length
    });

    const manualFields = buildSingleAssetDocumentationFields({
      preview,
      cleanedResult,
      matchedManufacturer,
      existingAsset: asset,
    });

    const updatePayload = {
      normalizedName,
      documentationSuggestions: cleanedResult.documentationSuggestions,
      enrichmentConfidence: confidence,
      enrichmentFollowupQuestion: cleanedResult.enrichmentFollowupQuestion,
      enrichmentStatus: status,
      enrichmentFailedAt: null,
      enrichmentErrorCode: '',
      enrichmentErrorMessage: '',
      reviewState: cleanedResult.reviewState,
      manualMatchSummary: cleanedResult.manualMatchSummary,
      manualLinks: manualFields.manualLinks,
      manualLibraryRef: manualFields.manualLibraryRef,
      manualStoragePath: manualFields.manualStoragePath,
      manualSourceUrl: manualFields.manualSourceUrl,
      supportUrl: manualFields.supportUrl,
      enrichmentCandidates: [
        manufacturerSuggestion,
        preview?.likelyCategory,
        preview?.normalizedName
      ].filter(Boolean).slice(0, 5),
      enrichmentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: userId
    };

    const followupAnswerText = `${followupAnswer || asset.enrichmentFollowupAnswer || ''}`.trim();
    if (followupAnswerText) {
      updatePayload.enrichmentFollowupAnswer = followupAnswerText;
      updatePayload.enrichmentFollowupAnsweredAt = admin.firestore.FieldValue.serverTimestamp();
    }

    if (manufacturerSuggestion) updatePayload.manufacturerSuggestion = manufacturerSuggestion;
    updatePayload.supportResourcesSuggestion = cleanedResult.supportResourcesSuggestion;
    if (Array.isArray(preview.supportContactsSuggestion) && preview.supportContactsSuggestion.length) updatePayload.supportContactsSuggestion = preview.supportContactsSuggestion;
    if (Array.isArray(preview.alternateNames) && preview.alternateNames.length) updatePayload.alternateNames = preview.alternateNames;
    if (Array.isArray(preview.searchHints) && preview.searchHints.length) updatePayload.searchHints = preview.searchHints;
    if (preview.topMatchReason) updatePayload.topMatchReason = preview.topMatchReason;
    if (manualFields.matchedManufacturer) updatePayload.matchedManufacturer = manualFields.matchedManufacturer;
    if (preview.catalogMatch) updatePayload.manualLookupCatalogMatch = {
      ...preview.catalogMatch,
      verificationMetadata: preview.catalogMatch.verificationMetadata || catalogMatch?.entry?.verification || null
    };
    if (shouldSetManufacturer) updatePayload.manufacturer = manufacturerSuggestion;

    await assetRef.set(updatePayload, { merge: true });
    log('terminal_status_write', { enrichmentStatus: status });
    if (manualFields.manualLibraryRef || manualFields.manualStoragePath) {
      buildSingleAssetDocLog('library_attached', {
        assetId,
        title: asset.name || normalizedName || '',
        manufacturer: asset.manufacturer || manufacturerSuggestion || '',
        callablePath,
        manualLibraryRef: manualFields.manualLibraryRef,
        manualStoragePath: manualFields.manualStoragePath,
        elapsedMs: Date.now() - startedAt,
      });
    }

    await db.collection('auditLogs').add({
      action: 'asset_enrichment_run',
      entityType: 'assets',
      entityId: assetId,
      summary: `Asset enrichment ${triggerSource || 'manual'} for ${assetId}`,
      userUid: userId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      confidence,
      suggestions: cleanedResult.documentationSuggestions.length
    });

    buildSingleAssetDocLog('final_result', {
      assetId,
      title: asset.name || normalizedName || '',
      manufacturer: asset.manufacturer || manufacturerSuggestion || '',
      callablePath,
      stage2Ran: pipelineMeta.stage2Ran === true,
      acquisitionSucceeded: pipelineMeta.acquisitionSucceeded === true,
      manualLibraryRef: manualFields.manualLibraryRef,
      matchType: manualFields.matchType || cleanedResult.manualMatchSummary?.matchType || '',
      manualReady: manualFields.manualReady || cleanedResult.manualMatchSummary?.manualReady === true,
      finalStatus: status,
      elapsedMs: Date.now() - startedAt,
    });

    return {
      ok: true,
      assetId,
      confidence,
      status,
      followupQuestion: cleanedResult.enrichmentFollowupQuestion,
      suggestions: cleanedResult.documentationSuggestions
    };
  } catch (error) {
    const code = `${error?.code || ''}`.trim() || 'unknown';
    const message = `${error?.message || error || 'Asset docs lookup failed.'}`.trim();
    if (!isTerminalEnrichmentStatus(terminalStatus)) {
      await writeTerminalFailureState({
        assetRef,
        userId,
        code,
        message,
        log
      });
    }
    throw error;
  }
}

async function previewAssetDocumentationLookup({ settings, traceId, draftAsset }) {
  const normalizedTarget = `${draftAsset?.name || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  console.log('previewAssetDocumentationLookup:start', {
    traceId,
    normalizedTarget,
    manufacturerInput: `${draftAsset?.manufacturer || ''}`.trim().slice(0, 80)
  });

  try {
    const preview = await runLookupPreview({ settings, traceId, draftAsset });
    console.log('previewAssetDocumentationLookup:end', {
      traceId,
      normalizedTarget,
      manufacturerSuggestion: preview.likelyManufacturer || '',
      documentationSuggestions: preview.documentationSuggestions.length,
      supportResources: preview.supportResourcesSuggestion.length,
      supportContacts: preview.supportContactsSuggestion.length,
      status: preview.status
    });
    return { ok: true, ...preview };
  } catch (error) {
    console.error('previewAssetDocumentationLookup:error', {
      traceId,
      normalizedTarget,
      message: error?.message || String(error)
    });
    throw error;
  }
}

module.exports = {
  enrichAssetDocumentation,
  previewAssetDocumentationLookup,
  normalizeDocumentationSuggestions,
  detectDeadPageText,
  verifySuggestionUrl,
  verifyDocumentationSuggestions,
  getDocumentationSuggestionRank,
  compareDocumentationSuggestions,
  isPreservableVerifiedManualSuggestion,
  mergeDocumentationSuggestions,
  collectReusableVerifiedManuals,
  findReusableVerifiedManuals,
  getManufacturerProfile,
  buildFollowupQuestion,
  classifyManualMatchSummary,
  shouldDiscoverAfterCatalogMatch,
  hasUsableVerifiedManualSuggestion,
  cleanDocumentationSuggestions,
  cleanSupportResourcesSuggestion,
  cleanFinalEnrichmentResult,
  resolveTerminalEnrichmentStatus,
  deriveDocumentationReviewState,
  repairLegacyAssetEnrichmentRecord,
  runLookupPreview,
  recoverCatalogSourcePageManuals,
  isSeededCatalogManualCandidate,
  hasSeededDirectManualProof,
  rehydrateSeededManualDocumentationSuggestions
};


/*
Approved manual ingestion is implemented separately so the current asset review/admin flow can:
- keep using documentationSuggestions/manualLinks for approval UI
- persist company-scoped source files and Firestore metadata after approval
- produce manuals/{manualId}/chunks records for later task-AI evidence retrieval
*/
