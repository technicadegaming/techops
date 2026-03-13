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

function scoreSuggestion({ row, asset, fallbackConfidence, normalizedName, manufacturerSuggestion, followupAnswer }) {
  const url = `${row?.url || ''}`.trim();
  const title = `${row?.title || ''}`.trim();
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

  const sourceType = `${row.sourceType || 'other'}`.trim().toLowerCase();
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
  const titleJoined = title.toLowerCase();
  const isOfficial = !!manufacturerToken && (lowerHost.includes(manufacturerToken) || sourceType === 'manufacturer');
  const isLikelyManual = /manual|operator|service|parts|schematic|instruction/.test(`${titleJoined} ${lowerPath}`);
  const isGenericHomepage = lowerPath === '/' || /^\/(home|index(\.html?)?)?$/.test(lowerPath);

  if (sourceType === 'manufacturer') {
    score += 14;
    reasons.push('manufacturer_source');
  }
  if (sourceType === 'manual_library') {
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

  const overlapCount = titleTokens.filter((token) => assetTokens.has(token)).length;
  score += Math.min(22, overlapCount * 5);
  if (overlapCount >= 3) reasons.push('strong_title_overlap');

  if (titleJoined && normalizedName && titleJoined.includes(`${normalizedName}`.toLowerCase())) {
    score += 15;
    reasons.push('exact_normalized_name');
  }

  if (isGenericHomepage) {
    score -= 16;
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

  const bounded = Math.max(0, Math.min(100, score));
  if (bounded < 35) return null;

  return {
    title: row.title || 'Candidate documentation',
    url,
    confidence: fallbackConfidence,
    sourceType: sourceType || 'other',
    matchScore: bounded,
    isOfficial,
    isLikelyManual,
    reason: reasons.slice(0, 4).join(',') || 'basic_match'
  };
}

function normalizeDocumentationSuggestions({ links, confidence, asset, normalizedName, manufacturerSuggestion, followupAnswer }) {
  if (!Array.isArray(links)) return [];
  const fallbackConfidence = Math.max(0.35, Number(confidence) || 0);

  return links
    .map((row) => scoreSuggestion({
      row,
      asset,
      fallbackConfidence,
      normalizedName,
      manufacturerSuggestion,
      followupAnswer
    }))
    .filter(Boolean)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
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
      'manufacturer documentation'
    ],
    notes: 'Identify likely manufacturer/model/category and provide documentation links. Ask one short follow-up question only if needed.'
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

  const context = buildLookupContext(asset, assetId, followupAnswer);
  const { parsed } = await requestAssetDocumentationLookup({
    model: settings.aiModel || 'gpt-4.1-mini',
    traceId,
    context
  });

  const confidence = Number(parsed?.confidence || 0);
  const normalizedName = parsed?.normalizedName || asset.name || '';
  const manufacturerSuggestion = parsed?.likelyManufacturer || '';
  const normalizedSuggestions = normalizeDocumentationSuggestions({
    links: parsed?.documentationLinks,
    confidence,
    asset,
    normalizedName,
    manufacturerSuggestion,
    followupAnswer: context.followupAnswer
  });
  const suggestions = await verifyDocumentationSuggestions(normalizedSuggestions);
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
    : (hasOnlyFailedVerification
      ? 'Please share the exact manual title or a working URL from the cabinet nameplate.'
    : (isAmbiguousTitle
      ? 'Which cabinet/version is it (upright/cocktail/deluxe) as shown on the manufacturer plate?'
      : (parsed?.oneFollowupQuestion || 'Can you confirm the manufacturer and exact model from the nameplate?')));
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
      parsed?.likelyCategory,
      parsed?.normalizedName
    ].filter(Boolean).slice(0, 5),
    enrichmentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId
  };

  if (context.followupAnswer) {
    updatePayload.enrichmentFollowupAnswer = context.followupAnswer;
    updatePayload.enrichmentFollowupAnsweredAt = admin.firestore.FieldValue.serverTimestamp();
  }

  if (manufacturerSuggestion) updatePayload.manufacturerSuggestion = manufacturerSuggestion;
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

module.exports = {
  enrichAssetDocumentation,
  normalizeDocumentationSuggestions,
  detectDeadPageText,
  verifySuggestionUrl,
  verifyDocumentationSuggestions
};
