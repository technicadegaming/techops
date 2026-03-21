const admin = require('firebase-admin');
const { gunzipSync, inflateSync, inflateRawSync } = require('node:zlib');
const { isoNow } = require('../lib/timestamps');
const { cleanDocumentationSuggestions } = require('./assetEnrichmentService');
const { acquireManualToLibrary } = require('./manualAcquisitionService');

function normalizeString(value, max = 240) {
  return `${value || ''}`.trim().slice(0, max);
}

function stripHtml(text = '') {
  return `${text || ''}`
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodePdfLiteralString(raw = '') {
  let output = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== '\\') {
      output += char;
      continue;
    }
    const next = raw[i + 1];
    if (!next) break;
    if (/[0-7]/.test(next)) {
      const octal = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] || next;
      output += String.fromCharCode(parseInt(octal, 8));
      i += octal.length;
      continue;
    }
    const replacements = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      '(': '(',
      ')': ')',
      '\\': '\\'
    };
    output += replacements[next] || next;
    i += 1;
  }
  return output;
}

function decodePdfTextOperators(streamText = '') {
  const segments = [];
  const literalMatches = streamText.match(/\((?:\\.|[^\\()])*\)\s*Tj/g) || [];
  literalMatches.forEach((entry) => {
    const literal = entry.replace(/\)\s*Tj$/, '').replace(/^\(/, '');
    segments.push(decodePdfLiteralString(literal));
  });

  const arrayMatches = streamText.match(/\[(?:.|\n|\r)*?\]\s*TJ/g) || [];
  arrayMatches.forEach((entry) => {
    const body = entry.replace(/\]\s*TJ$/, '').replace(/^\[/, '');
    const arrayLiterals = body.match(/\((?:\\.|[^\\()])*\)/g) || [];
    arrayLiterals.forEach((literal) => {
      segments.push(decodePdfLiteralString(literal.slice(1, -1)));
    });
  });

  return segments.join(' ');
}

function extractPdfText(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const binary = source.toString('binary');
  const streamRegex = /<<(?:.|\n|\r)*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const texts = [];
  let match;
  while ((match = streamRegex.exec(binary))) {
    const rawStream = Buffer.from(match[1], 'binary');
    const candidates = [rawStream];
    for (const decoder of [inflateSync, inflateRawSync, gunzipSync]) {
      try {
        candidates.push(decoder(rawStream));
      } catch {
        // best effort
      }
    }
    candidates.forEach((candidate) => {
      const decoded = decodePdfTextOperators(candidate.toString('latin1'));
      if (decoded.trim()) texts.push(decoded);
    });
  }
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

function extractTextFromBuffer(buffer, contentType = '', sourceUrl = '') {
  const normalizedType = `${contentType || ''}`.toLowerCase();
  if (normalizedType.includes('html')) return stripHtml(Buffer.from(buffer).toString('utf8'));
  if (normalizedType.startsWith('text/')) return Buffer.from(buffer).toString('utf8').replace(/\s+/g, ' ').trim();
  if (normalizedType.includes('pdf') || /\.pdf($|\?|#)/i.test(sourceUrl)) return extractPdfText(buffer);
  return '';
}

function chunkManualText(text = '', options = {}) {
  const normalized = `${text || ''}`.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const targetSize = Math.max(300, Number(options.targetSize || 1200));
  const overlap = Math.max(0, Number(options.overlap || 150));
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = '';

  function pushChunk(value) {
    const textValue = value.trim();
    if (!textValue) return;
    chunks.push({
      text: textValue,
      charCount: textValue.length,
      tokenCountApprox: Math.max(1, Math.ceil(textValue.split(/\s+/).length * 1.15))
    });
  }

  sentences.forEach((sentence) => {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= targetSize) {
      current = candidate;
      return;
    }
    pushChunk(current);
    const carry = current.slice(Math.max(0, current.length - overlap)).trim();
    current = carry ? `${carry} ${sentence}`.slice(-targetSize) : sentence;
    if (current.length > targetSize * 1.25) {
      pushChunk(current.slice(0, targetSize));
      current = current.slice(targetSize - overlap).trim();
    }
  });
  pushChunk(current);
  return chunks.map((chunk, index) => ({ ...chunk, chunkIndex: index }));
}

function guessExtension(contentType = '', sourceUrl = '') {
  if (/\.pdf($|\?|#)/i.test(sourceUrl) || `${contentType}`.toLowerCase().includes('pdf')) return 'pdf';
  if (/html/i.test(contentType)) return 'html';
  if (/text\/plain/i.test(contentType)) return 'txt';
  return 'bin';
}

function buildManualStoragePath(companyId, assetId, manualId, contentType = '', sourceUrl = '') {
  const extension = guessExtension(contentType, sourceUrl);
  return ['companies', companyId, 'manuals', assetId, manualId, `source.${extension}`].join('/');
}

async function approveAssetManual({
  db,
  storage,
  asset,
  userId,
  sourceUrl,
  sourceTitle = '',
  approvedSuggestionIndex = null,
  fetchImpl = fetch
}) {
  const companyId = normalizeString(asset?.companyId, 120);
  const assetId = normalizeString(asset?.id, 120);
  const cleanedSourceUrl = normalizeString(sourceUrl, 2000);
  if (!companyId) throw new Error('Asset companyId is required');
  if (!assetId) throw new Error('Asset id is required');
  if (!cleanedSourceUrl) throw new Error('sourceUrl is required');

  const suggestions = Array.isArray(asset.documentationSuggestions) ? asset.documentationSuggestions : [];
  const reviewableSuggestions = cleanDocumentationSuggestions(suggestions);
  const matchedSuggestion = reviewableSuggestions.find((entry) => `${entry?.url || ''}`.trim() === cleanedSourceUrl)
    || suggestions.find((entry, index) => {
      if (approvedSuggestionIndex !== null && Number(index) === Number(approvedSuggestionIndex)) return true;
      return `${entry?.url || ''}`.trim() === cleanedSourceUrl;
    })
    || {};
  if (!reviewableSuggestions.some((entry) => `${entry?.url || ''}`.trim() === cleanedSourceUrl)) {
    throw new Error('Selected documentation URL is not a reviewable manual candidate');
  }

  const now = isoNow();
  const acquired = await acquireManualToLibrary({
    db,
    storage,
    fetchImpl,
    candidate: {
      ...matchedSuggestion,
      url: cleanedSourceUrl,
      sourcePageUrl: matchedSuggestion.sourcePageUrl || asset.manualSourceUrl || '',
      title: sourceTitle || matchedSuggestion.title || asset.name || cleanedSourceUrl,
    },
    context: {
      originalTitle: asset.name || asset.title || '',
      canonicalTitle: asset.normalizedName || asset.name || asset.title || '',
      normalizedTitle: asset.normalizedName || asset.name || asset.title || '',
      familyTitle: matchedSuggestion.family || asset.family || asset.normalizedName || asset.name || '',
      manufacturer: asset.manufacturer || matchedSuggestion.manufacturer || '',
      manualSourceUrl: matchedSuggestion.sourcePageUrl || asset.manualSourceUrl || '',
      manualUrl: cleanedSourceUrl,
      matchType: matchedSuggestion.matchType || 'exact_manual',
      confidence: Number(matchedSuggestion.confidence || asset.enrichmentConfidence || 0) || 0,
      variant: matchedSuggestion.cabinetVariant || matchedSuggestion.variant || '',
      catalogEntryId: matchedSuggestion.catalogEntryId || asset.manualLookupCatalogMatch?.catalogEntryId || '',
      seededFromWorkbook: matchedSuggestion?.verificationMetadata?.seededFromWorkbook === true,
      notes: matchedSuggestion.reason || '',
    },
  });
  if (!acquired?.manualReady || !acquired.manualLibrary) {
    throw new Error('Unable to acquire a stored shared manual for approval');
  }

  const library = acquired.manualLibrary;
  const assetPatch = {
    manualLinks: Array.from(new Set([...(Array.isArray(asset.manualLinks) ? asset.manualLinks : []), library.storagePath].filter(Boolean))),
    manualLibraryRef: library.id,
    manualStoragePath: library.storagePath || '',
    manualVariant: library.variant || '',
    manualSourceUrl: library.sourcePageUrl || matchedSuggestion.sourcePageUrl || '',
    docsLastReviewedAt: now,
    enrichmentStatus: 'docs_found',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId
  };

  await Promise.all([
    db.collection('assets').doc(assetId).set(assetPatch, { merge: true }),
    db.collection('manualLibrary').doc(library.id).set({
      approvalState: 'approved',
      approved: true,
      approvedBy: userId,
      approvedAt: now,
      reviewRequired: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }),
    db.collection('auditLogs').add({
      action: 'manual_approved',
      entityType: 'manualLibrary',
      entityId: library.id,
      companyId,
      summary: `Approved shared manual for ${asset.name || assetId}`,
      userUid: userId,
      metadata: {
        assetId,
        sourceUrl: cleanedSourceUrl,
        manualLibraryRef: library.id,
        storagePath: library.storagePath || '',
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    })
  ]);

  return {
    ok: true,
    manualId: library.id,
    manualLibraryRef: library.id,
    storagePath: library.storagePath || '',
    extractionStatus: 'completed',
    chunkCount: 0,
    contentType: library.contentType || ''
  };
}

module.exports = {
  approveAssetManual,
  buildManualStoragePath,
  chunkManualText,
  extractPdfText,
  extractTextFromBuffer,
  stripHtml
};
