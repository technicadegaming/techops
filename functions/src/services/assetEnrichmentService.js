const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { requestAssetDocumentationLookup } = require('./openaiService');

const TRUSTED_MANUAL_HOST_TOKENS = [
  'ipdb.org',
  'arcade-museum.com',
  'arcade-history.com',
  'manual',
  'archive.org'
];

const MANUFACTURER_SOURCE_MAP = [
  { key: 'raw thrills', aliases: ['rawthrills'], sourceTokens: ['rawthrills.com', 'betson.com'], categories: ['video', 'motion', 'simulator'] },
  {
    key: 'bay tek',
    aliases: ['baytek', 'bay tek games', 'baytek games'],
    sourceTokens: ['parts.baytekent.com', 'baytekent.com', 'betson.com'],
    preferredSourceTokens: ['parts.baytekent.com', 'baytekent.com'],
    lowTrustSourceTokens: ['betson.com'],
    categories: ['redemption', 'ticket']
  },
  { key: 'ice', aliases: ['innovative concepts in entertainment'], sourceTokens: ['icegame.com', 'betson.com'], categories: ['redemption', 'ticket'] },
  { key: 'betson', aliases: ['betson enterprises'], sourceTokens: ['betson.com'], categories: ['parts', 'distribution'] },
  { key: 'unis', aliases: ['unis technology', 'unis technologies'], sourceTokens: ['unistop.com', 'unistechnology.com', 'betson.com'], categories: ['video', 'redemption'] },
  { key: 'sega', aliases: ['sega amusements'], sourceTokens: ['segaarcade.com', 'segaarcade.co.uk', 'arcade', 'manual'], categories: ['video', 'arcade'] },
  { key: 'adrenaline amusements', aliases: ['adrenaline games'], sourceTokens: ['adrenalineamusements.com', 'betson.com'], categories: ['redemption', 'ticket'] },
  { key: 'coastal amusements', aliases: [], sourceTokens: ['coastalamusements.com', 'betson.com'], categories: ['redemption', 'crane', 'prize'] },
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
  { key: 'lai games', aliases: ['lai'], sourceTokens: ['laigames.com', 'betson.com'], categories: ['redemption', 'video'] },
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
const SOFT_404_TEXT_PATTERNS = [
  /sorry[,\s]+the page you are looking for/i,
  /we (?:could|can) not find/i,
  /nothing (?:found|here)/i,
  /access denied/i
];


function tokenize(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((v) => v.trim())
    .filter((v) => v.length >= 2);
}

function normalizePhrase(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildExactTitleVariants(assetName, normalizedName) {
  const variants = new Set([normalizePhrase(normalizedName), normalizePhrase(assetName)]);
  return Array.from(variants).filter((entry) => entry && entry.length >= 4);
}

function getManufacturerProfile(...values) {
  const joined = values.filter(Boolean).join(' ').toLowerCase();
  return MANUFACTURER_SOURCE_MAP.find((entry) => {
    const candidates = [entry.key, ...(entry.aliases || [])];
    return candidates.some((candidate) => joined.includes(candidate));
  }) || null;
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

  const sourceType = `${row.sourceType || row.resourceType || 'other'}`.trim().toLowerCase();
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
  const isOfficial = !!manufacturerToken && (lowerHost.includes(manufacturerToken) || sourceType === 'manufacturer');
  const preferredSourceMatch = !!manufacturerProfile && (manufacturerProfile.preferredSourceTokens || []).some((token) => lowerHost.includes(token));
  const lowTrustSourceMatch = !!manufacturerProfile && (manufacturerProfile.lowTrustSourceTokens || []).some((token) => lowerHost.includes(token));
  const isLikelyManual = MANUAL_INTENT_TOKENS.some((token) => `${titleJoined} ${lowerPath}`.includes(token));
  const hasPdfSignal = /\.pdf($|\?|#)|pdf/.test(`${lowerPath} ${titleJoined}`);
  const isGenericHomepage = lowerPath === '/' || /^\/(home|index(\.html?)?)?$/.test(lowerPath);
  const isGenericManualHub = /manuals?|support|docs?|downloads?|products?|category|catalog/.test(lowerPath) && !hasStrongTitleMatch;
  const isDistributorLike = sourceType === 'distributor' || /distributor|betson/.test(lowerHost);

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

  if (isGenericHomepage) {
    score -= 22;
    reasons.push('generic_homepage_penalty');
  }
  if (isGenericManualHub) {
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

  const bounded = Math.max(0, Math.min(100, score));
  const minimumScore = kind === 'documentation' ? 48 : 40;
  if (bounded < minimumScore) return null;

  return {
    title: row.title || row.label || 'Candidate documentation',
    url,
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
    reason: reasons.slice(0, 8).join(',') || 'basic_match'
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
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
}

function normalizeSupportContacts(rows) {
  if (!Array.isArray(rows)) return [];
  const trustedContact = rows
    .map((row) => ({
      label: `${row?.label || ''}`.trim().slice(0, 80),
      value: `${row?.value || ''}`.trim().slice(0, 180),
      contactType: `${row?.contactType || 'other'}`.trim().toLowerCase() || 'other'
    }))
    .filter((row) => row.value)
    .filter((row) => {
      if (row.contactType === 'email') return /@/.test(row.value);
      if (row.contactType === 'phone') return /\d{7,}/.test(row.value.replace(/\D/g, ''));
      if (row.contactType === 'form') return /^https?:\/\//i.test(row.value);
      return row.value.length >= 4;
    });
  return trustedContact.slice(0, 5);
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
  const deadPage = deadByStatus || deadByText || redirectedToLikelyError || deadByContentType;
  const verified = response.ok && !deadPage;

  return {
    verified,
    unreachable: false,
    deadPage,
    verificationStatus: verified ? 'verified' : (deadPage ? 'dead_page' : 'unverified'),
    httpStatus
  };
}

async function verifyDocumentationSuggestions(suggestions, fetchImpl = fetch) {
  const bounded = Array.isArray(suggestions) ? suggestions.slice(0, VERIFY_MAX_SUGGESTIONS) : [];
  const verifiedRows = await Promise.all(
    bounded.map(async (row) => {
      const verification = await verifySuggestionUrl(row.url, fetchImpl);
      const strongMatch = Number(row.matchScore || 0) >= 72 && !!row.exactTitleMatch && !!row.exactManualMatch;
      const aliveAndStrong = verification.verified && strongMatch;
      return {
        ...row,
        ...verification,
        verified: aliveAndStrong,
        verificationStatus: aliveAndStrong ? 'verified' : verification.verificationStatus
      };
    })
  );

  return verifiedRows.sort((a, b) => {
    if (!!a.verified !== !!b.verified) return a.verified ? -1 : 1;
    return Number(b.matchScore || 0) - Number(a.matchScore || 0);
  });
}

function buildLookupContext(asset, assetId, followupAnswer = '') {
  const manufacturerProfile = getManufacturerProfile(asset.manufacturer, asset.name, followupAnswer);
  const preferredSources = manufacturerProfile?.sourceTokens || [];
  return {
    assetName: asset.name || '',
    manufacturer: asset.manufacturer || '',
    serialNumber: asset.serialNumber || '',
    assetId: asset.id || assetId,
    followupAnswer: `${followupAnswer || asset.enrichmentFollowupAnswer || ''}`.trim(),
    lookupTargets: [
      'arcade manual for [title] by [manufacturer]',
      'operator manual for [title] by [manufacturer]',
      'service manual for [title] by [manufacturer]',
      'parts manual for [title] by [manufacturer]',
      'install manual for [title] by [manufacturer]',
      'exact title official support page by manufacturer'
    ],
    preferredSourceHints: preferredSources,
    notes: 'Prioritize exact title + manufacturer documentation for arcade/FEC equipment. Prefer manufacturer-specific parts/support/manual hosts (for Bay Tek: parts.baytekent.com before baytekent.com before distributors/manual libraries), then exact-title official support pages, and only then exact-title secondary sources. Ask one short actionable follow-up question only if needed.'
  };
}

async function runLookupPreview({ settings, traceId, draftAsset }) {
  const context = buildLookupContext(draftAsset || {}, draftAsset?.assetId, draftAsset?.followupAnswer);
  const { parsed } = await requestAssetDocumentationLookup({
    model: settings.aiModel || 'gpt-4.1-mini',
    traceId,
    context
  });

  const confidence = Number(parsed?.confidence || 0);
  const normalizedName = parsed?.normalizedName || draftAsset?.name || '';
  const manufacturerSuggestion = parsed?.likelyManufacturer || '';
  const manufacturerProfile = getManufacturerProfile(draftAsset?.manufacturer, manufacturerSuggestion, normalizedName, parsed?.likelyCategory);

  const documentationSuggestions = normalizeDocumentationSuggestions({
    links: parsed?.documentationLinks,
    confidence,
    asset: draftAsset || {},
    normalizedName,
    manufacturerSuggestion,
    followupAnswer: context.followupAnswer
  });

  const supportResourcesSuggestion = normalizeDocumentationSuggestions({
    links: parsed?.supportResources,
    confidence,
    asset: draftAsset || {},
    normalizedName,
    manufacturerSuggestion,
    followupAnswer: context.followupAnswer,
    kind: 'support'
  });

  const supportContactsSuggestion = normalizeSupportContacts(parsed?.supportContacts);
  const confidenceThreshold = settings.aiConfidenceThreshold || 0.45;
  const status = confidence >= confidenceThreshold && documentationSuggestions.length
    ? 'found_suggestions'
    : (parsed?.oneFollowupQuestion ? 'needs_follow_up' : 'no_strong_match');

  return {
    status,
    normalizedName,
    likelyManufacturer: manufacturerSuggestion,
    likelyCategory: parsed?.likelyCategory || '',
    confidence,
    oneFollowupQuestion: parsed?.oneFollowupQuestion || '',
    topMatchReason: parsed?.topMatchReason || '',
    alternateNames: Array.isArray(parsed?.alternateNames) ? parsed.alternateNames : [],
    searchHints: Array.isArray(parsed?.searchHints) ? parsed.searchHints : [],
    documentationSuggestions,
    supportResourcesSuggestion,
    supportContactsSuggestion,
    matchedManufacturer: manufacturerProfile?.key || ''
  };
}

async function enrichAssetDocumentation({ db, assetId, userId, settings, triggerSource, followupAnswer, traceId }) {
  const assetRef = db.collection('assets').doc(assetId);
  const assetSnap = await assetRef.get();
  if (!assetSnap.exists) throw new HttpsError('not-found', 'Asset not found');
  const asset = assetSnap.data() || {};

  await assetRef.set({
    enrichmentStatus: triggerSource === 'post_save' ? 'searching_docs' : 'in_progress',
    enrichmentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    enrichmentFailedAt: null,
    enrichmentErrorCode: '',
    enrichmentErrorMessage: '',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId
  }, { merge: true });

  try {
    const preview = await runLookupPreview({
    settings,
    traceId,
    draftAsset: { ...asset, assetId, followupAnswer }
  });

  const confidence = Number(preview?.confidence || 0);
  const normalizedName = preview?.normalizedName || asset.name || '';
  const manufacturerSuggestion = preview?.likelyManufacturer || '';
  const manufacturerProfile = getManufacturerProfile(asset?.manufacturer, manufacturerSuggestion, normalizedName, preview?.likelyCategory);
  const suggestions = await verifyDocumentationSuggestions(preview.documentationSuggestions || []);
  const confidenceThreshold = settings.aiConfidenceThreshold || 0.45;

  const strongSuggestions = suggestions.filter((s) => {
    const scoreGate = s.matchScore >= 80 || (s.isOfficial && s.matchScore >= 76);
    const exactGate = !!s.exactTitleMatch && !!s.exactManualMatch;
    return scoreGate && exactGate;
  });
  const strongVerifiedSuggestions = strongSuggestions.filter((s) => s.verified && s.trustedSource);
  const hasConfidentSingleMatch = confidence >= confidenceThreshold && strongVerifiedSuggestions.length === 1;
  const topSuggestionScore = suggestions[0]?.matchScore || 0;
  const isAmbiguousTitle = suggestions.length > 1 && topSuggestionScore < 78;
  const hasUnverifiedCandidates = suggestions.some((s) => !s.verified && !s.deadPage && !s.unreachable);
  const hasOnlyFailedVerification = suggestions.length > 0 && !strongVerifiedSuggestions.length;

  const followupQuestion = hasConfidentSingleMatch
    ? ''
    : (isAmbiguousTitle
      ? 'What exact cabinet nameplate text or subtitle/version appears under the logo (for example DX/Deluxe/SDX)?'
      : buildFollowupQuestion({
        parsedQuestion: preview?.oneFollowupQuestion,
        profile: manufacturerProfile,
        likelyCategory: preview?.likelyCategory,
        hasOnlyFailedVerification
      }));
  const shouldSetManufacturer = !asset.manufacturer && confidence >= Math.max(0.75, confidenceThreshold) && manufacturerSuggestion;

  const status = strongVerifiedSuggestions.length
    ? (hasConfidentSingleMatch ? 'docs_found' : 'needs_follow_up')
    : (hasUnverifiedCandidates ? 'needs_follow_up' : 'no_match_yet');

  const updatePayload = {
    normalizedName,
    documentationSuggestions: suggestions,
    enrichmentConfidence: confidence,
    enrichmentFollowupQuestion: followupQuestion,
    enrichmentStatus: status,
    enrichmentFailedAt: null,
    enrichmentErrorCode: '',
    enrichmentErrorMessage: '',
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
  if (Array.isArray(preview.supportResourcesSuggestion) && preview.supportResourcesSuggestion.length) updatePayload.supportResourcesSuggestion = preview.supportResourcesSuggestion;
  if (Array.isArray(preview.supportContactsSuggestion) && preview.supportContactsSuggestion.length) updatePayload.supportContactsSuggestion = preview.supportContactsSuggestion;
  if (Array.isArray(preview.alternateNames) && preview.alternateNames.length) updatePayload.alternateNames = preview.alternateNames;
  if (Array.isArray(preview.searchHints) && preview.searchHints.length) updatePayload.searchHints = preview.searchHints;
  if (preview.topMatchReason) updatePayload.topMatchReason = preview.topMatchReason;
  if (manufacturerProfile?.key) updatePayload.matchedManufacturer = manufacturerProfile.key;
  if (shouldSetManufacturer) updatePayload.manufacturer = manufacturerSuggestion;

  await assetRef.set(updatePayload, { merge: true });

  await db.collection('auditLogs').add({
    action: 'asset_enrichment_run',
    entityType: 'assets',
    entityId: assetId,
    summary: `Asset enrichment ${triggerSource || 'manual'} for ${assetId}`,
    userUid: userId,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    confidence,
    suggestions: suggestions.length
  });

  return {
    ok: true,
    assetId,
    confidence,
    status,
    followupQuestion,
    suggestions
  };
  } catch (error) {
    const code = `${error?.code || ''}`.trim() || 'unknown';
    const message = `${error?.message || error || 'Asset docs lookup failed.'}`.trim();
    await assetRef.set({
      enrichmentStatus: 'docs_failed',
      enrichmentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      enrichmentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
      enrichmentErrorCode: code,
      enrichmentErrorMessage: message.slice(0, 240),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: userId
    }, { merge: true });
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
  getManufacturerProfile,
  buildFollowupQuestion
};


/*
Approved manual ingestion is implemented separately so the current asset review/admin flow can:
- keep using documentationSuggestions/manualLinks for approval UI
- persist company-scoped source files and Firestore metadata after approval
- produce manuals/{manualId}/chunks records for later task-AI evidence retrieval
*/
