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
  { key: 'bay tek', aliases: ['baytek'], sourceTokens: ['baytekent.com', 'betson.com'], categories: ['redemption', 'ticket'] },
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

function tokenize(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((v) => v.trim())
    .filter((v) => v.length >= 2);
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
  return 'Which cabinet type is it (upright/deluxe/SDX) from the manufacturer plate?';
}

function scoreSuggestion({ row, asset, fallbackConfidence, normalizedName, manufacturerSuggestion, followupAnswer, kind = 'documentation' }) {
  const url = `${row?.url || ''}`.trim();
  const title = `${row?.title || row?.label || ''}`.trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (err) {
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
  const manufacturerProfile = getManufacturerProfile(asset?.manufacturer, manufacturerSuggestion, normalizedName, title);
  const titleJoined = title.toLowerCase();
  const isOfficial = !!manufacturerToken && (lowerHost.includes(manufacturerToken) || sourceType === 'manufacturer');
  const isLikelyManual = /manual|operator|service|parts|schematic|instruction/.test(`${titleJoined} ${lowerPath}`);
  const isGenericHomepage = lowerPath === '/' || /^\/(home|index(\.html?)?)?$/.test(lowerPath);

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
  if (manufacturerProfile && /manual|support|docs|service|operators?/.test(lowerPath)) {
    score += 7;
    reasons.push('manufacturer_docs_path_match');
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
  if (manufacturerProfile && !manufacturerProfile.sourceTokens.some((token) => lowerHost.includes(token)) && sourceType !== 'manual_library' && !isOfficial) {
    score -= 10;
    reasons.push('manufacturer_source_mismatch_penalty');
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
  if (bounded < 35) return null;

  return {
    title: row.title || row.label || 'Candidate documentation',
    url,
    confidence: fallbackConfidence,
    sourceType: sourceType || 'other',
    matchScore: bounded,
    isOfficial,
    isLikelyManual,
    matchedManufacturer: manufacturerProfile?.key || '',
    sourceTrustReason: reasons.find((reason) => /manufacturer_trusted_source_match|trusted_manual_host|official_host_match/.test(reason)) || '',
    reason: reasons.slice(0, 4).join(',') || 'basic_match'
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
  return DEAD_PAGE_PATTERNS.some((pattern) => pattern.test(text));
}

async function verifySuggestionUrl(url, fetchImpl = fetch) {
  let headResponse = null;
  try {
    headResponse = await fetchWithTimeout(url, {
      method: 'HEAD',
      headers: { 'user-agent': 'techops-asset-enrichment/1.0' }
    }, VERIFY_TIMEOUT_MS, fetchImpl);
  } catch (error) {
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
    } catch (error) {
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
  const deadByStatus = httpStatus === 404 || httpStatus === 410 || httpStatus >= 500;
  const deadByText = !!pageSnippet && detectDeadPageText(pageSnippet);
  const deadPage = deadByStatus || deadByText;
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
      return {
        ...row,
        ...verification
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
      'arcade game manual',
      'operator manual',
      'service manual',
      'parts manual',
      'redemption game manual',
      'manufacturer documentation'
    ],
    preferredSourceHints: preferredSources,
    notes: 'Prioritize trusted manufacturer/operator documentation for arcade/FEC equipment. Identify likely manufacturer/model/category and provide documentation links. Ask one short actionable follow-up question only if needed.'
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
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId
  }, { merge: true });

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

  const strongSuggestions = suggestions.filter((s) => s.matchScore >= 70 || (s.isOfficial && s.matchScore >= 62));
  const strongVerifiedSuggestions = strongSuggestions.filter((s) => s.verified);
  const hasConfidentSingleMatch = confidence >= confidenceThreshold && strongVerifiedSuggestions.length === 1;
  const topSuggestionScore = suggestions[0]?.matchScore || 0;
  const isAmbiguousTitle = suggestions.length > 1 && topSuggestionScore < 78;
  const hasUnverifiedCandidates = suggestions.some((s) => !s.verified && !s.deadPage && !s.unreachable);
  const hasOnlyFailedVerification = suggestions.length > 0 && !strongVerifiedSuggestions.length;

  const followupQuestion = hasConfidentSingleMatch
    ? ''
    : (isAmbiguousTitle
      ? 'Which cabinet/version is it (upright/cocktail/deluxe) as shown on the manufacturer plate?'
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
}

async function previewAssetDocumentationLookup({ settings, traceId, draftAsset }) {
  const preview = await runLookupPreview({ settings, traceId, draftAsset });
  console.log('previewAssetDocumentationLookup:start', { traceId, assetName: `${draftAsset?.name || ''}`.slice(0, 80) });
  console.log('previewAssetDocumentationLookup:normalized_target', { traceId, normalizedName: preview.normalizedName });
  console.log('previewAssetDocumentationLookup:manufacturer_suggestion', { traceId, likelyManufacturer: preview.likelyManufacturer || '' });
  console.log('previewAssetDocumentationLookup:counts', { traceId, documentationSuggestions: preview.documentationSuggestions.length, supportResources: preview.supportResourcesSuggestion.length });
  console.log('previewAssetDocumentationLookup:status', { traceId, status: preview.status });
  return { ok: true, ...preview };
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
