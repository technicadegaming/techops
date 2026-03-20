const admin = require('firebase-admin');
const { gunzipSync, inflateSync, inflateRawSync } = require('node:zlib');
const { randomUUID, createHash } = require('node:crypto');
const { isoNow } = require('../lib/timestamps');
const { cleanDocumentationSuggestions } = require('./assetEnrichmentService');

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

async function fetchManualSource(sourceUrl) {
  const response = await fetch(sourceUrl, {
    headers: { 'user-agent': 'techops-manual-ingestion/1.0' }
  });
  if (!response.ok) throw new Error(`Manual fetch failed with status ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: `${response.headers.get('content-type') || ''}`.toLowerCase() || 'application/octet-stream'
  };
}

async function persistManualChunks({ db, manualId, chunkDocs }) {
  const batch = db.batch();
  chunkDocs.forEach((chunk) => {
    const ref = db.collection('manuals').doc(manualId).collection('chunks').doc(`${chunk.chunkIndex}`);
    batch.set(ref, chunk);
  });
  await batch.commit();
}

async function approveAssetManual({
  db,
  storage,
  asset,
  userId,
  sourceUrl,
  sourceTitle = '',
  sourceType = 'approved_doc',
  approvedSuggestionIndex = null
}) {
  const companyId = normalizeString(asset?.companyId, 120);
  const assetId = normalizeString(asset?.id, 120);
  const cleanedSourceUrl = normalizeString(sourceUrl, 2000);
  if (!companyId) throw new Error('Asset companyId is required');
  if (!assetId) throw new Error('Asset id is required');
  if (!cleanedSourceUrl) throw new Error('sourceUrl is required');

  const existingSnap = await db.collection('manuals')
    .where('companyId', '==', companyId)
    .where('assetId', '==', assetId)
    .where('sourceUrl', '==', cleanedSourceUrl)
    .limit(1)
    .get();

  const manualId = existingSnap.empty ? `manual_${randomUUID()}` : existingSnap.docs[0].id;
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
  const baseRecord = {
    id: manualId,
    manualId,
    companyId,
    assetId,
    sourceUrl: cleanedSourceUrl,
    sourceTitle: normalizeString(sourceTitle || matchedSuggestion.title || asset.name || cleanedSourceUrl, 240),
    manufacturer: normalizeString(asset.manufacturer || matchedSuggestion.manufacturer || '', 120),
    assetTitle: normalizeString(asset.name || asset.title || '', 160),
    sourceType: normalizeString(sourceType || matchedSuggestion.sourceType || 'approved_doc', 40),
    matchedManufacturer: normalizeString(asset.matchedManufacturer || matchedSuggestion.matchedManufacturer || '', 120),
    manualType: normalizeString(matchedSuggestion.manualType || matchedSuggestion.linkType || '', 80),
    cabinetVariant: normalizeString(matchedSuggestion.cabinetVariant || matchedSuggestion.variant || '', 160),
    family: normalizeString(matchedSuggestion.family || asset.family || '', 160),
    manualConfidence: Number(matchedSuggestion.confidence || asset.enrichmentConfidence || 0) || 0,
    assetLocationId: normalizeString(asset.locationId || asset.assetLocationId || '', 120),
    assetLocationName: normalizeString(asset.locationName || asset.locationLabel || '', 160),
    approvedBy: userId,
    approvedAt: now,
    extractionStatus: 'pending',
    extractionRequestedAt: now,
    extractionStartedAt: now,
    extractionCompletedAt: null,
    extractionFailedAt: null,
    extractionError: '',
    chunkCount: 0,
    byteSize: 0,
    sha256: '',
    storagePath: '',
    contentType: '',
    fileName: ''
  };

  await db.collection('manuals').doc(manualId).set({
    ...baseRecord,
    updatedAt: now,
    updatedBy: userId,
    createdAt: existingSnap.empty ? now : existingSnap.docs[0].data()?.createdAt || now,
    createdBy: existingSnap.empty ? userId : existingSnap.docs[0].data()?.createdBy || userId
  }, { merge: true });

  try {
    const { buffer, contentType } = await fetchManualSource(cleanedSourceUrl);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const storagePath = buildManualStoragePath(companyId, assetId, manualId, contentType, cleanedSourceUrl);
    const fileName = storagePath.split('/').pop() || 'source.bin';

    await storage.bucket().file(storagePath).save(buffer, {
      resumable: false,
      contentType,
      metadata: {
        metadata: {
          companyId,
          assetId,
          manualId,
          sourceUrl: cleanedSourceUrl
        }
      }
    });

    const extractedText = extractTextFromBuffer(buffer, contentType, cleanedSourceUrl);
    const chunks = chunkManualText(extractedText).map((chunk) => ({
      id: `${manualId}_${chunk.chunkIndex}`,
      manualId,
      companyId,
      assetId,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      tokenCountApprox: chunk.tokenCountApprox,
      charCount: chunk.charCount,
      pageNumber: null,
      sourceTitle: baseRecord.sourceTitle,
      sourceUrl: cleanedSourceUrl,
      manualType: baseRecord.manualType,
      cabinetVariant: baseRecord.cabinetVariant,
      family: baseRecord.family,
      manufacturer: baseRecord.manufacturer,
      manualConfidence: baseRecord.manualConfidence,
      createdAt: now,
      updatedAt: now
    }));

    await db.recursiveDelete(db.collection('manuals').doc(manualId).collection('chunks')).catch(() => {});
    if (chunks.length) await persistManualChunks({ db, manualId, chunkDocs: chunks });

    const assetPatch = {
      manualLinks: Array.from(new Set([...(Array.isArray(asset.manualLinks) ? asset.manualLinks : []), cleanedSourceUrl])),
      approvedManualIds: Array.from(new Set([...(Array.isArray(asset.approvedManualIds) ? asset.approvedManualIds : []), manualId])),
      docsLastReviewedAt: now,
      enrichmentStatus: asset.enrichmentStatus === 'followup_needed' ? 'verified_manual_found' : (asset.enrichmentStatus || 'verified_manual_found'),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: userId
    };

    await Promise.all([
      db.collection('assets').doc(assetId).set(assetPatch, { merge: true }),
      db.collection('manuals').doc(manualId).set({
        storagePath,
        contentType,
        fileName,
        byteSize: buffer.length,
        sha256,
        extractionStatus: chunks.length ? 'completed' : 'no_text_extracted',
        extractionCompletedAt: isoNow(),
        extractionFailedAt: null,
        extractionError: chunks.length ? '' : 'No extractable text detected from source file.',
        chunkCount: chunks.length,
        updatedAt: isoNow(),
        updatedBy: userId
      }, { merge: true }),
      db.collection('auditLogs').add({
        action: 'manual_approved',
        entityType: 'manuals',
        entityId: manualId,
        companyId,
        summary: `Approved manual for ${asset.name || assetId}`,
        userUid: userId,
        metadata: {
          assetId,
          sourceUrl: cleanedSourceUrl,
          storagePath,
          extractionStatus: chunks.length ? 'completed' : 'no_text_extracted',
          chunkCount: chunks.length
        },
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      })
    ]);

    return {
      ok: true,
      manualId,
      storagePath,
      extractionStatus: chunks.length ? 'completed' : 'no_text_extracted',
      chunkCount: chunks.length,
      contentType
    };
  } catch (error) {
    await db.collection('manuals').doc(manualId).set({
      extractionStatus: 'failed',
      extractionFailedAt: isoNow(),
      extractionError: normalizeString(error?.message || String(error), 500),
      updatedAt: isoNow(),
      updatedBy: userId
    }, { merge: true });
    throw error;
  }
}

module.exports = {
  approveAssetManual,
  buildManualStoragePath,
  chunkManualText,
  extractPdfText,
  extractTextFromBuffer,
  stripHtml
};
