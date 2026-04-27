const admin = require('firebase-admin');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { gunzipSync, inflateSync, inflateRawSync } = require('node:zlib');
const { isoNow } = require('../lib/timestamps');
const { cleanDocumentationSuggestions } = require('./assetEnrichmentService');
const { acquireManualToLibrary } = require('./manualAcquisitionService');
const requireFromHere = createRequire(__filename);

function loadPdfParse() {
  try {
    return requireFromHere('pdf-parse');
  } catch {
    return null;
  }
}

function normalizeString(value, max = 240) {
  return `${value || ''}`.trim().slice(0, max);
}

function safeDecodeURIComponent(value = '') {
  try {
    return decodeURIComponent(value);
  } catch {
    return `${value || ''}`;
  }
}

function inferFileExtension(pathOrUrl = '') {
  const normalized = `${pathOrUrl || ''}`.trim().toLowerCase();
  const match = normalized.match(/\.([a-z0-9]+)(?:$|\?|#)/i);
  return match?.[1] || '';
}

function resolveManualStoragePath(value = '') {
  const raw = `${value || ''}`.trim();
  if (!raw) return { storagePath: '', sourceKind: 'missing', errorCode: 'storage_path_missing' };
  if (/^companies\//i.test(raw) || /^manual-library\//i.test(raw)) {
    return { storagePath: raw, sourceKind: 'bucket_path', errorCode: '' };
  }
  if (/^gs:\/\//i.test(raw)) {
    const withoutScheme = raw.replace(/^gs:\/\//i, '');
    const slashIndex = withoutScheme.indexOf('/');
    const objectPath = slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1) : '';
    return objectPath
      ? { storagePath: safeDecodeURIComponent(objectPath), sourceKind: 'gs_url', errorCode: '' }
      : { storagePath: '', sourceKind: 'gs_url', errorCode: 'storage_path_missing' };
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const isFirebaseStorageHost = parsed.hostname === 'firebasestorage.googleapis.com';
      if (!isFirebaseStorageHost) return { storagePath: '', sourceKind: 'external_url', errorCode: 'unsupported_external_url' };
      const objectMatch = parsed.pathname.match(/\/o\/([^/]+)/);
      const encodedObject = objectMatch?.[1] || '';
      if (!encodedObject) {
        return { storagePath: '', sourceKind: 'firebase_download_url', errorCode: 'firebase_download_url_not_resolved' };
      }
      const decodedObject = safeDecodeURIComponent(encodedObject);
      if (!decodedObject || decodedObject.includes('://')) {
        return { storagePath: '', sourceKind: 'firebase_download_url', errorCode: 'firebase_download_url_not_resolved' };
      }
      return { storagePath: decodedObject, sourceKind: 'firebase_download_url', errorCode: '' };
    } catch {
      return { storagePath: '', sourceKind: 'invalid_url', errorCode: 'firebase_download_url_not_resolved' };
    }
  }
  return { storagePath: safeDecodeURIComponent(raw), sourceKind: 'encoded_path', errorCode: '' };
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

function normalizeExtractedText(value = '') {
  return `${value || ''}`.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractPdfTextRobust(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const legacyText = normalizeExtractedText(extractPdfText(source));
  const minimumPreferredLength = 80;
  const pdfParse = loadPdfParse();
  if (typeof pdfParse !== 'function') {
    return {
      text: legacyText,
      extractionEngine: legacyText ? 'legacy_pdf_operator_parser' : 'none',
      extractionWarning: 'pdf-parse unavailable; used legacy extractor fallback',
    };
  }
  try {
    const parsed = await pdfParse(source);
    const parsedText = normalizeExtractedText(parsed?.text || '');
    if (parsedText.length >= minimumPreferredLength || (parsedText.length > 0 && parsedText.length >= legacyText.length)) {
      return {
        text: parsedText,
        extractionEngine: parsedText ? 'pdf-parse' : 'none',
        extractionWarning: parsedText ? '' : 'pdf-parse returned empty text',
      };
    }
    if (legacyText) {
      return {
        text: legacyText,
        extractionEngine: 'legacy_pdf_operator_parser',
        extractionWarning: 'pdf-parse returned limited text; used legacy extractor fallback',
      };
    }
    return {
      text: parsedText,
      extractionEngine: parsedText ? 'pdf-parse' : 'none',
      extractionWarning: parsedText ? '' : 'pdf-parse returned limited text',
    };
  } catch (error) {
    if (legacyText) {
      return {
        text: legacyText,
        extractionEngine: 'legacy_pdf_operator_parser',
        extractionWarning: `pdf-parse failed: ${`${error?.message || String(error)}`.slice(0, 160)}`,
      };
    }
    return {
      text: '',
      extractionEngine: 'none',
      extractionWarning: `pdf-parse failed: ${`${error?.message || String(error)}`.slice(0, 160)}`,
    };
  }
}

function extractTextFromBuffer(buffer, contentType = '', sourceUrl = '') {
  const normalizedType = `${contentType || ''}`.toLowerCase();
  if (normalizedType.includes('html')) return stripHtml(Buffer.from(buffer).toString('utf8'));
  if (normalizedType.startsWith('text/')) return Buffer.from(buffer).toString('utf8').replace(/\s+/g, ' ').trim();
  if (normalizedType.includes('pdf') || /\.pdf($|\?|#)/i.test(sourceUrl)) return extractPdfText(buffer);
  return '';
}

async function extractTextFromBufferAsync(buffer, contentType = '', sourceUrl = '') {
  const normalizedType = `${contentType || ''}`.toLowerCase();
  if (normalizedType.includes('html')) {
    const text = stripHtml(Buffer.from(buffer).toString('utf8'));
    return { text, extractionEngine: text ? 'html' : 'none', extractedTextLength: text.length, extractionWarning: '' };
  }
  if (normalizedType.startsWith('text/')) {
    const text = normalizeExtractedText(Buffer.from(buffer).toString('utf8'));
    return { text, extractionEngine: text ? 'text' : 'none', extractedTextLength: text.length, extractionWarning: '' };
  }
  if (normalizedType.includes('pdf') || /\.pdf($|\?|#)/i.test(sourceUrl)) {
    const extracted = await extractPdfTextRobust(buffer);
    return {
      text: extracted.text,
      extractionEngine: extracted.extractionEngine,
      extractedTextLength: extracted.text.length,
      extractionWarning: extracted.extractionWarning || '',
    };
  }
  return { text: '', extractionEngine: 'none', extractedTextLength: 0, extractionWarning: '' };
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

function normalizeManualErrorCode(value = '') {
  const raw = `${value || ''}`.trim().toUpperCase();
  if (!raw) return '';
  const normalized = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const direct = normalized.match(/^([A-Z]{1,4})\s*(\d{1,4})$/);
  if (direct) return `${direct[1]}${Number(direct[2])}`;
  const mapped = normalized.match(/^(?:ERROR(?:\s+CODE)?|CODE)\s*[:#-]?\s*(\d{1,4})$/);
  if (mapped) return `E${Number(mapped[1])}`;
  return '';
}

function normalizeManualSnippet(value = '', max = 240) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseManualCodeLead(line = '') {
  const text = `${line || ''}`.trim();
  if (!text) return null;
  const match = text.match(/^(E\s*\d{1,4}|ERROR(?:\s+CODE)?\s*[:#-]?\s*\d{1,4}|CODE\s*[:#-]?\s*\d{1,4})\b[:#-]?\s*(.*)$/i);
  if (!match) return null;
  const rawCode = `${match[1] || ''}`.trim();
  const code = normalizeManualErrorCode(rawCode);
  if (!code) return null;
  return { rawCode, code, remainder: `${match[2] || ''}`.trim() };
}

function finalizeManualCodeDefinition({
  code = '',
  rawCode = '',
  title = '',
  meaning = '',
  resetInstruction = '',
  line = '',
  confidence = 0.8
} = {}) {
  const normalizedCode = normalizeManualErrorCode(code || rawCode);
  const normalizedTitle = normalizeManualSnippet(title, 120);
  const normalizedMeaning = normalizeManualSnippet(meaning, 240);
  if (!normalizedCode || (!normalizedTitle && !normalizedMeaning)) return null;
  return {
    code: normalizedCode,
    rawCode: normalizeManualSnippet(rawCode || code, 40),
    title: normalizedTitle,
    meaning: normalizedMeaning,
    resetInstruction: normalizeManualSnippet(resetInstruction, 140),
    line: normalizeManualSnippet(line, 280),
    confidence: Math.max(0.8, Math.min(Number(confidence || 0.8), 1)),
    source: 'manual_text',
  };
}

function extractManualErrorCodeDefinitions(text = '') {
  const lines = `${text || ''}`.replace(/\r/g, '\n').split('\n');
  const definitions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = `${lines[index] || ''}`.trim();
    const parsed = parseManualCodeLead(line);
    if (!parsed) continue;
    const lookahead = [];
    for (let offset = 1; offset <= 3 && index + offset < lines.length; offset += 1) {
      const nextLine = `${lines[index + offset] || ''}`.trim();
      if (!nextLine) continue;
      if (parseManualCodeLead(nextLine)) break;
      lookahead.push(nextLine);
    }
    const combinedRemainder = [parsed.remainder, ...lookahead].filter(Boolean).join(' ').trim();
    const rawLine = [line, ...lookahead].filter(Boolean).join(' | ');
    const resetMatch = combinedRemainder.match(/\(([^)]*reset[^)]*)\)/i)
      || combinedRemainder.match(/(after[^.]{0,120}reset[^.]*)/i);
    const resetInstruction = resetMatch ? resetMatch[0] : '';
    const bodyWithoutReset = combinedRemainder.replace(resetInstruction, '').replace(/\s+/g, ' ').trim();
    if (!bodyWithoutReset && !resetInstruction) continue;

    if (line.includes('|')) {
      const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
      const title = parts[1] || lookahead[0] || '';
      const meaning = [parts.slice(2).join(' | '), ...lookahead].filter(Boolean).join(' ').replace(title, '').trim();
      const entry = finalizeManualCodeDefinition({
        code: parsed.code,
        rawCode: parsed.rawCode,
        title,
        meaning,
        resetInstruction,
        line: rawLine,
        confidence: 0.97,
      });
      if (entry) definitions.push(entry);
      continue;
    }

    if (/[:-]/.test(parsed.remainder) && parsed.remainder.length <= 240) {
      const segments = parsed.remainder.split(/[:-]/).map((part) => part.trim()).filter(Boolean);
      const title = segments[0] || '';
      const meaning = segments.slice(1).join(' - ');
      const entry = finalizeManualCodeDefinition({
        code: parsed.code,
        rawCode: parsed.rawCode,
        title: meaning ? title : '',
        meaning: meaning || title,
        resetInstruction,
        line: rawLine,
        confidence: 0.95,
      });
      if (entry) definitions.push(entry);
      continue;
    }

    const title = lookahead[0] && lookahead[0].length <= 120 ? lookahead[0] : '';
    const meaning = [parsed.remainder, ...lookahead.slice(title ? 1 : 0)].filter(Boolean).join(' ').trim() || parsed.remainder;
    if (!title && !meaning) continue;
    const entry = finalizeManualCodeDefinition({
      code: parsed.code,
      rawCode: parsed.rawCode,
      title,
      meaning,
      resetInstruction,
      line: rawLine,
      confidence: title && meaning ? 0.94 : 0.85,
    });
    if (entry) definitions.push(entry);
  }
  return dedupeByManualCodeDefinition(definitions);
}

function dedupeByManualCodeDefinition(definitions = []) {
  const seen = new Set();
  return (Array.isArray(definitions) ? definitions : []).filter((entry) => {
    const key = `${entry?.code || ''}|${`${entry?.title || ''}`.toLowerCase()}|${`${entry?.meaning || ''}`.toLowerCase()}`;
    if (!entry?.code || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildManualErrorCodeIndexFromChunks(chunks = [], options = {}) {
  const candidates = [];
  if (typeof chunks === 'string') {
    candidates.push(...extractManualErrorCodeDefinitions(chunks));
  } else {
    (Array.isArray(chunks) ? chunks : []).forEach((chunk) => {
      const text = typeof chunk === 'string' ? chunk : (chunk?.text || '');
      if (text) candidates.push(...extractManualErrorCodeDefinitions(text));
    });
  }
  const deduped = dedupeByManualCodeDefinition(candidates);
  const maxEntries = Math.max(1, Number(options.maxEntries || 100));
  return deduped.slice(0, maxEntries);
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

function createAssetManualId({ companyId = '', assetId = '', manualLibraryRef = '', storagePath = '', sourceUrl = '' } = {}) {
  const stableKey = [companyId, assetId, manualLibraryRef, storagePath, sourceUrl].filter(Boolean).join('::');
  const digest = createHash('sha1').update(stableKey || `${Date.now()}`).digest('hex').slice(0, 24);
  return `manual-${digest}`;
}

async function findExistingAssetManual({ db, companyId = '', assetId = '', manualLibraryRef = '', storagePath = '' } = {}) {
  if (!db || !companyId || !assetId) return null;
  const snap = await db.collection('manuals')
    .where('companyId', '==', companyId)
    .where('assetId', '==', assetId)
    .limit(20)
    .get()
    .catch(() => ({ docs: [] }));
  const rows = (snap.docs || []).map((doc) => ({ id: doc.id, ...doc.data() }));
  return rows.find((row) => (
    (manualLibraryRef && `${row.manualLibraryRef || ''}`.trim() === manualLibraryRef)
    || (storagePath && `${row.storagePath || ''}`.trim() === storagePath)
    || (storagePath && `${row.sharedStoragePath || ''}`.trim() === storagePath)
  )) || null;
}

async function rewriteManualChunks({ db, manualId = '', chunks = [] } = {}) {
  if (!db || !manualId) return;
  const chunkCollection = db.collection('manuals').doc(manualId).collection('chunks');
  if (typeof db.recursiveDelete === 'function') {
    await db.recursiveDelete(chunkCollection).catch(() => null);
  }
  if (!chunks.length) return;
  const batch = typeof db.batch === 'function' ? db.batch() : null;
  const writes = chunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    charCount: chunk.charCount,
    tokenCountApprox: chunk.tokenCountApprox,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }));
  if (batch) {
    writes.forEach((chunk) => batch.set(chunkCollection.doc(`${chunk.chunkIndex}`), chunk));
    await batch.commit();
    return;
  }
  await Promise.all(writes.map((chunk) => chunkCollection.doc(`${chunk.chunkIndex}`).set(chunk)));
}

async function rewriteManualCodeDefinitions({
  db,
  manualId = '',
  manual = {},
  definitions = [],
} = {}) {
  if (!db || !manualId) return { extractedCodeCount: 0 };
  const codeDefinitions = Array.isArray(definitions) ? definitions.slice(0, 100) : [];
  const now = isoNow();
  await db.collection('manuals').doc(manualId).set({
    extractedCodeDefinitions: codeDefinitions,
    extractedCodeCount: codeDefinitions.length,
    extractedCodeUpdatedAt: now,
  }, { merge: true });
  if (!codeDefinitions.length) return { extractedCodeCount: 0 };
  const byCode = new Map();
  codeDefinitions.forEach((entry) => {
    const code = `${entry.code || ''}`.trim();
    if (!code) return;
    const rows = byCode.get(code) || [];
    rows.push(entry);
    byCode.set(code, rows);
  });
  const subCollection = db.collection('manuals').doc(manualId).collection('codeDefinitions');
  await Promise.all(Array.from(byCode.entries()).map(([code, entries]) => {
    const best = entries[0] || {};
    return subCollection.doc(code).set({
      code,
      definitions: entries,
      bestDefinition: best,
      manualId,
      companyId: `${manual.companyId || ''}`.trim(),
      assetId: `${manual.assetId || ''}`.trim(),
      sourceTitle: `${manual.sourceTitle || ''}`.trim(),
      storagePath: `${manual.storagePath || ''}`.trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      extractedCodeUpdatedAt: now,
    }, { merge: true });
  }));
  return { extractedCodeCount: codeDefinitions.length };
}

function deriveManualStatusFromAsset(asset = {}) {
  const manualLibraryRef = normalizeString(asset?.manualLibraryRef, 180);
  const manualStoragePath = normalizeString(asset?.manualStoragePath, 500);
  const manualLinks = Array.isArray(asset?.manualLinks) ? asset.manualLinks.map((entry) => normalizeString(entry, 500)).filter(Boolean) : [];
  if (manualLibraryRef || manualStoragePath || manualLinks.length) return 'manual_attached';
  const supportLinks = Array.isArray(asset?.supportResourcesSuggestion) ? asset.supportResourcesSuggestion.filter((entry) => normalizeString(entry?.url || entry, 500)) : [];
  if (supportLinks.length) return 'support_context_only';
  return 'no_public_manual';
}

async function materializeApprovedManualForAsset({
  db,
  storage,
  asset,
  manualLibrary,
  userId = '',
  sourceUrl = '',
  sourceTitle = '',
} = {}) {
  const companyId = normalizeString(asset?.companyId, 120);
  const assetId = normalizeString(asset?.id, 120);
  const manualLibraryRef = normalizeString(manualLibrary?.id, 180);
  const sharedStoragePath = normalizeString(manualLibrary?.storagePath, 500);
  if (!db || !storage || !companyId || !assetId || !manualLibraryRef || !sharedStoragePath) {
    return { ok: false, skipped: true, reason: 'missing_materialization_inputs', extractionStatus: 'skipped', chunkCount: 0 };
  }

  const existingManual = await findExistingAssetManual({ db, companyId, assetId, manualLibraryRef, storagePath: sharedStoragePath });
  const manualId = existingManual?.id || createAssetManualId({
    companyId,
    assetId,
    manualLibraryRef,
    storagePath: sharedStoragePath,
    sourceUrl: sourceUrl || manualLibrary.resolvedDownloadUrl || manualLibrary.originalDownloadUrl || '',
  });
  const tenantStoragePath = buildManualStoragePath(
    companyId,
    assetId,
    manualId,
    manualLibrary.contentType || '',
    sourceUrl || manualLibrary.originalDownloadUrl || sharedStoragePath,
  );
  const [buffer] = await storage.bucket().file(sharedStoragePath).download();
  await storage.bucket().file(tenantStoragePath).save(buffer, {
    resumable: false,
    contentType: manualLibrary.contentType || 'application/octet-stream',
    metadata: {
      metadata: {
        companyId,
        assetId,
        manualId,
        manualLibraryRef,
        sharedStoragePath,
      }
    }
  });

  const extracted = await extractTextFromBufferAsync(buffer, manualLibrary.contentType || '', sourceUrl || manualLibrary.originalDownloadUrl || sharedStoragePath);
  const extractedText = extracted.text;
  const chunks = chunkManualText(extractedText);
  const extractedCodeDefinitions = buildManualErrorCodeIndexFromChunks(chunks.length ? chunks : extractedText);
  const extractionStatus = chunks.length ? 'completed' : 'no_text_extracted';
  const extractionReason = chunks.length ? 'text_extracted' : 'no_readable_text_found';
  const now = isoNow();
  await db.collection('manuals').doc(manualId).set({
    companyId,
    assetId,
    assetName: asset.name || '',
    manufacturer: manualLibrary.manufacturer || asset.manufacturer || '',
    sourceUrl: sourceUrl || manualLibrary.originalDownloadUrl || manualLibrary.resolvedDownloadUrl || '',
    sourceTitle: sourceTitle || manualLibrary.canonicalTitle || manualLibrary.filename || asset.name || '',
    sourceType: 'approved_doc',
    manualType: 'shared_manual_library',
    cabinetVariant: manualLibrary.variant || asset.manualVariant || '',
    family: manualLibrary.familyTitle || asset.family || asset.name || '',
    manualConfidence: Number(manualLibrary.matchConfidence || 0) || 0,
    approvedBy: userId || existingManual?.approvedBy || '',
    approvedAt: existingManual?.approvedAt || now,
    manualLibraryRef,
    sharedStoragePath,
    storagePath: tenantStoragePath,
    contentType: manualLibrary.contentType || '',
    fileName: tenantStoragePath.split('/').pop() || '',
    byteSize: Buffer.byteLength(buffer),
    sha256: manualLibrary.sha256 || '',
    extractionStatus,
    extractionReason,
    extractionFailureCode: chunks.length ? '' : extractionReason,
    extractionRequestedAt: now,
    extractionStartedAt: now,
    extractionCompletedAt: now,
    extractionFailedAt: null,
    extractionError: '',
    extractionEngine: extracted.extractionEngine || 'none',
    extractedTextLength: extracted.extractedTextLength || extractedText.length || 0,
    extractionWarning: extracted.extractionWarning || '',
    chunkCount: chunks.length,
    extractedCodeDefinitions,
    extractedCodeCount: extractedCodeDefinitions.length,
    extractedCodeUpdatedAt: now,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId || '',
  }, { merge: true });
  await rewriteManualChunks({ db, manualId, chunks });
  await rewriteManualCodeDefinitions({
    db,
    manualId,
    manual: {
      companyId,
      assetId,
      sourceTitle: sourceTitle || manualLibrary.canonicalTitle || manualLibrary.filename || asset.name || '',
      storagePath: tenantStoragePath,
    },
    definitions: extractedCodeDefinitions,
  });

  return {
    ok: true,
    manualId,
    storagePath: tenantStoragePath,
    sharedStoragePath,
    extractionStatus,
    extractionReason,
    chunkCount: chunks.length,
    extractionEngine: extracted.extractionEngine || 'none',
    contentType: manualLibrary.contentType || '',
    extractedCodeCount: extractedCodeDefinitions.length,
  };
}

async function materializeStoredAssetManual({
  db,
  storage,
  asset,
  userId = '',
  storagePath = '',
  sourceUrl = '',
  sourceTitle = '',
  sourceType = 'csv_direct_bootstrap_manual',
  manualType = 'asset_attached_manual',
  contentType = '',
  attachmentMode = '',
  manualProvenance = '',
} = {}) {
  const companyId = normalizeString(asset?.companyId, 120);
  const assetId = normalizeString(asset?.id, 120);
  const resolvedPath = resolveManualStoragePath(storagePath || sourceUrl);
  const normalizedStoragePath = normalizeString(resolvedPath.storagePath, 500);
  if (!db || !storage || !companyId || !assetId || !normalizedStoragePath) {
    return { ok: false, skipped: true, reason: 'missing_materialization_inputs', extractionStatus: 'skipped', chunkCount: 0 };
  }

  const normalizedSourceUrl = normalizeString(sourceUrl, 2000);
  const manualId = createAssetManualId({
    companyId,
    assetId,
    storagePath: normalizedStoragePath,
    sourceUrl: normalizedSourceUrl,
  });
  const fileRef = storage.bucket().file(normalizedStoragePath);
  let buffer;
  try {
    [buffer] = await fileRef.download();
  } catch (error) {
    const code = `${error?.code || ''}`.trim().toLowerCase();
    const message = `${error?.message || String(error)}`.slice(0, 240);
    if (code === '404' || code === 'not-found') {
      return { ok: false, skipped: false, reason: 'storage_object_not_found', extractionStatus: 'storage_object_missing', extractionReason: 'storage_object_not_found', extractionFailureCode: 'storage_object_not_found', extractionError: message, chunkCount: 0, extractionEngine: 'none', storagePath: normalizedStoragePath };
    }
    if (code === '403' || code === 'permission-denied') {
      return { ok: false, skipped: false, reason: 'storage_permission_denied', extractionStatus: 'storage_download_failed', extractionReason: 'storage_permission_denied', extractionFailureCode: 'storage_permission_denied', extractionError: message, chunkCount: 0, extractionEngine: 'none', storagePath: normalizedStoragePath };
    }
    return { ok: false, skipped: false, reason: 'storage_download_failed', extractionStatus: 'storage_download_failed', extractionReason: 'storage_download_failed', extractionFailureCode: 'storage_download_failed', extractionError: message, chunkCount: 0, extractionEngine: 'none', storagePath: normalizedStoragePath };
  }
  const [metadata] = await fileRef.getMetadata().catch(() => [{}]);
  const resolvedContentType = normalizeString(
    contentType || metadata?.contentType || (
      /\.pdf($|\?|#)/i.test(normalizedStoragePath) ? 'application/pdf'
        : /\.html?($|\?|#)/i.test(normalizedStoragePath) ? 'text/html'
          : /\.txt($|\?|#)/i.test(normalizedStoragePath) ? 'text/plain'
            : ''
    ),
    200
  );
  const extension = inferFileExtension(normalizedStoragePath || normalizedSourceUrl);
  const isDoc = extension === 'doc' || extension === 'docx' || /application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/i.test(resolvedContentType);
  if (isDoc) {
    const docReason = extension === 'docx' ? 'unsupported_docx_binary' : 'unsupported_doc_binary';
    const now = isoNow();
    await db.collection('manuals').doc(manualId).set({
      id: manualId,
      manualId,
      companyId,
      assetId,
      assetName: asset.name || '',
      sourceUrl: normalizedSourceUrl || normalizedStoragePath,
      sourceTitle: sourceTitle || asset.name || 'Attached manual',
      sourceType: sourceType || 'csv_direct_bootstrap_manual',
      manualType: manualType || 'asset_attached_manual',
      storagePath: normalizedStoragePath,
      contentType: resolvedContentType || '',
      fileName: normalizedStoragePath.split('/').pop() || '',
      byteSize: Number(metadata?.size || 0) || Buffer.byteLength(buffer || Buffer.alloc(0)),
      approvedBy: userId || '',
      approvedAt: now,
      extractionStatus: 'unsupported_file_type',
      extractionReason: docReason,
      extractionFailureCode: docReason,
      extractionRequestedAt: now,
      extractionStartedAt: now,
      extractionCompletedAt: now,
      extractionFailedAt: null,
      extractionError: 'Unsupported document format for text extraction.',
      extractionEngine: 'none',
      extractedTextLength: 0,
      chunkCount: 0,
      extractedCodeDefinitions: [],
      extractedCodeCount: 0,
      extractedCodeUpdatedAt: now,
      attachmentMode: attachmentMode || '',
      manualProvenance: manualProvenance || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: userId || '',
    }, { merge: true });
    await rewriteManualChunks({ db, manualId, chunks: [] });
    await rewriteManualCodeDefinitions({
      db,
      manualId,
      manual: { companyId, assetId, sourceTitle: sourceTitle || asset.name || 'Attached manual', storagePath: normalizedStoragePath },
      definitions: [],
    });
    return {
      ok: true,
      manualId,
      extractionStatus: 'unsupported_file_type',
      extractionReason: docReason,
      extractionFailureCode: docReason,
      extractionError: 'Unsupported document format for text extraction.',
      chunkCount: 0,
      extractionEngine: 'none',
      storagePath: normalizedStoragePath,
      contentType: resolvedContentType || '',
      extension,
    };
  }
  const extracted = await extractTextFromBufferAsync(buffer, resolvedContentType, normalizedSourceUrl || normalizedStoragePath);
  const extractedText = extracted.text;
  const chunks = chunkManualText(extractedText);
  const extractedCodeDefinitions = buildManualErrorCodeIndexFromChunks(chunks.length ? chunks : extractedText);
  const extractionStatus = chunks.length ? 'completed' : 'no_text_extracted';
  const extractionReason = chunks.length ? 'text_extracted' : 'no_readable_text_found';
  const now = isoNow();
  await db.collection('manuals').doc(manualId).set({
    id: manualId,
    manualId,
    companyId,
    assetId,
    assetName: asset.name || '',
    manufacturer: asset.manufacturer || '',
    sourceUrl: normalizedSourceUrl || normalizedStoragePath,
    sourceTitle: sourceTitle || asset.name || 'Attached manual',
    sourceType: sourceType || 'csv_direct_bootstrap_manual',
    manualType: manualType || 'asset_attached_manual',
    storagePath: normalizedStoragePath,
    contentType: resolvedContentType || '',
    fileName: normalizedStoragePath.split('/').pop() || '',
    byteSize: Number(metadata?.size || 0) || Buffer.byteLength(buffer || Buffer.alloc(0)),
    approvedBy: userId || '',
    approvedAt: now,
    extractionStatus,
    extractionReason,
    extractionFailureCode: chunks.length ? '' : extractionReason,
    extractionRequestedAt: now,
    extractionStartedAt: now,
    extractionCompletedAt: now,
    extractionFailedAt: null,
    extractionError: '',
    extractionEngine: extracted.extractionEngine || 'none',
    extractedTextLength: extracted.extractedTextLength || extractedText.length || 0,
    extractionWarning: extracted.extractionWarning || '',
    chunkCount: chunks.length,
    extractedCodeDefinitions,
    extractedCodeCount: extractedCodeDefinitions.length,
    extractedCodeUpdatedAt: now,
    attachmentMode: attachmentMode || '',
    manualProvenance: manualProvenance || '',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId || '',
  }, { merge: true });
  await rewriteManualChunks({ db, manualId, chunks });
  await rewriteManualCodeDefinitions({
    db,
    manualId,
    manual: {
      companyId,
      assetId,
      sourceTitle: sourceTitle || asset.name || 'Attached manual',
      storagePath: normalizedStoragePath,
    },
    definitions: extractedCodeDefinitions,
  });

  return {
    ok: true,
    manualId,
    extractionStatus,
    extractionReason,
    extractionFailureCode: chunks.length ? '' : extractionReason,
    extractionError: '',
    chunkCount: chunks.length,
    extractionEngine: extracted.extractionEngine || 'none',
    storagePath: normalizedStoragePath,
    contentType: resolvedContentType || '',
    extension,
    sourceKind: resolvedPath.sourceKind,
    extractedCodeCount: extractedCodeDefinitions.length,
  };
}

async function resolveApprovedManualLibraryForAsset({ db, asset = {} } = {}) {
  if (!db || !asset) return { manualLibrary: null, evidence: 'missing_inputs', ambiguous: false };
  const existingRef = normalizeString(asset.manualLibraryRef, 180);
  const explicitPath = normalizeString(asset.manualStoragePath, 500);
  const linkCandidates = [
    explicitPath,
    ...((Array.isArray(asset.manualLinks) ? asset.manualLinks : []).map((entry) => normalizeString(entry, 500))),
  ].filter(Boolean);

  if (existingRef) {
    const snap = await db.collection('manualLibrary').doc(existingRef).get().catch(() => null);
    if (snap?.exists) return { manualLibrary: { id: snap.id, ...snap.data() }, evidence: 'manualLibraryRef', ambiguous: false };
  }

  const approvedSnap = await db.collection('manualLibrary').limit(200).get().catch(() => ({ docs: [] }));
  const matches = (approvedSnap.docs || [])
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((row) => row.approved === true || row.approvalState === 'approved')
    .filter((row) => {
      const values = [
        normalizeString(row.storagePath, 500),
        normalizeString(row.originalDownloadUrl, 2000),
        normalizeString(row.resolvedDownloadUrl, 2000),
      ].filter(Boolean);
      return linkCandidates.some((candidate) => values.includes(candidate));
    });
  const unique = Array.from(new Map(matches.map((row) => [row.id, row])).values());
  if (unique.length === 1) return { manualLibrary: unique[0], evidence: 'exact_path_or_url_match', ambiguous: false };
  return { manualLibrary: null, evidence: unique.length > 1 ? 'ambiguous_match' : 'no_match', ambiguous: unique.length > 1 };
}

async function backfillApprovedAssetManualLinkage({
  db,
  storage,
  asset,
  userId = '',
  dryRun = false,
} = {}) {
  const result = {
    ok: true,
    assetId: normalizeString(asset?.id, 120),
    companyId: normalizeString(asset?.companyId, 120),
    linked: false,
    patchedAsset: false,
    materializedManual: false,
    skipped: false,
    dryRun,
    reason: '',
    evidence: '',
  };
  const { manualLibrary, evidence, ambiguous } = await resolveApprovedManualLibraryForAsset({ db, asset });
  result.evidence = evidence;
  if (!manualLibrary) {
    result.skipped = true;
    result.reason = ambiguous ? 'ambiguous_approved_manual_match' : 'no_approved_manual_match';
    return result;
  }
  result.linked = true;
  const desiredRef = normalizeString(manualLibrary.id, 180);
  const desiredSharedPath = normalizeString(manualLibrary.storagePath, 500);
  const currentRef = normalizeString(asset?.manualLibraryRef, 180);
  const currentPath = normalizeString(asset?.manualStoragePath, 500);
  const conflicts = (
    (currentRef && currentRef !== desiredRef)
    || (currentPath && currentPath !== desiredSharedPath)
  );
  if (conflicts) {
    result.skipped = true;
    result.reason = 'existing_manual_linkage_conflict';
    return result;
  }

  const assetPatch = {};
  if (!currentRef) assetPatch.manualLibraryRef = desiredRef;
  if (!currentPath) assetPatch.manualStoragePath = desiredSharedPath;
  if (!Array.isArray(asset?.manualLinks) || !asset.manualLinks.includes(desiredSharedPath)) {
    assetPatch.manualLinks = Array.from(new Set([...(Array.isArray(asset?.manualLinks) ? asset.manualLinks : []), desiredSharedPath].filter(Boolean)));
  }

  assetPatch.manualStatus = deriveManualStatusFromAsset({ ...asset, ...assetPatch });
  result.patchedAsset = Object.keys(assetPatch).length > 0;
  if (!dryRun && result.patchedAsset) {
    await db.collection('assets').doc(result.assetId).set({
      ...assetPatch,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: userId || '',
    }, { merge: true });
  }

  const existingManual = await findExistingAssetManual({
    db,
    companyId: result.companyId,
    assetId: result.assetId,
    manualLibraryRef: desiredRef,
    storagePath: desiredSharedPath,
  });
  if (existingManual && ['completed', 'no_text_extracted'].includes(`${existingManual.extractionStatus || ''}`)) {
    result.materializedManual = true;
    result.manualId = existingManual.id;
    result.extractionStatus = existingManual.extractionStatus || 'completed';
    result.chunkCount = Number(existingManual.chunkCount || 0) || 0;
    return result;
  }

  if (dryRun) {
    result.materializedManual = true;
    result.manualId = existingManual?.id || createAssetManualId({
      companyId: result.companyId,
      assetId: result.assetId,
      manualLibraryRef: desiredRef,
      storagePath: desiredSharedPath,
    });
    result.extractionStatus = existingManual?.extractionStatus || 'planned';
    result.chunkCount = Number(existingManual?.chunkCount || 0) || 0;
    return result;
  }

  const materialized = await materializeApprovedManualForAsset({
    db,
    storage,
    asset: { ...asset, ...assetPatch },
    manualLibrary,
    userId,
    sourceUrl: manualLibrary.originalDownloadUrl || manualLibrary.resolvedDownloadUrl || '',
    sourceTitle: manualLibrary.canonicalTitle || asset?.name || '',
  });
  result.materializedManual = materialized.ok === true;
  result.manualId = materialized.manualId;
  result.extractionStatus = materialized.extractionStatus;
  result.chunkCount = materialized.chunkCount;
  return result;
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
    manualStatus: 'manual_attached',
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

  const materialized = await materializeApprovedManualForAsset({
    db,
    storage,
    asset: { ...asset, ...assetPatch },
    manualLibrary: library,
    userId,
    sourceUrl: cleanedSourceUrl,
    sourceTitle: sourceTitle || matchedSuggestion.title || asset.name || cleanedSourceUrl,
  });

  return {
    ok: true,
    manualId: materialized.manualId || library.id,
    manualLibraryRef: library.id,
    storagePath: materialized.storagePath || library.storagePath || '',
    sharedStoragePath: library.storagePath || '',
    extractionStatus: materialized.extractionStatus || 'completed',
    chunkCount: materialized.chunkCount || 0,
    contentType: materialized.contentType || library.contentType || ''
  };
}

module.exports = {
  approveAssetManual,
  backfillApprovedAssetManualLinkage,
  buildManualStoragePath,
  buildManualErrorCodeIndexFromChunks,
  chunkManualText,
  createAssetManualId,
  extractManualErrorCodeDefinitions,
  extractPdfTextRobust,
  extractPdfText,
  extractTextFromBuffer,
  extractTextFromBufferAsync,
  materializeStoredAssetManual,
  materializeApprovedManualForAsset,
  normalizeManualErrorCode,
  rewriteManualCodeDefinitions,
  resolveManualStoragePath,
  resolveApprovedManualLibraryForAsset,
  stripHtml
};
