const { requestFollowupQuestions, requestTroubleshootingPlan } = require('./openaiService');
const { fetchWebContextForTask } = require('./webContextService');
const { isWeakTaskDescription } = require('../lib/followup');
const { isoNow } = require('../lib/timestamps');

const DEFAULT_SETTINGS = {
  aiEnabled: false,
  aiAutoAttach: false,
  aiUseInternalKnowledge: true,
  aiUseWebSearch: false,
  aiAskFollowups: true,
  aiModel: 'gpt-4.1-mini',
  aiMaxWebSources: 3,
  aiConfidenceThreshold: 0.45,
  aiAllowManualRerun: true,
  aiAllowStaffManualRerun: false,
  aiAllowStaffSaveFixesToLibrary: false,
  aiSaveSuccessfulFixesToLibraryDefault: false,
  aiShortResponseMode: true,
  aiVerboseManagerMode: false
};

function stripText(input = '') {
  return `${input || ''}`
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactExcerpt(text = '', maxLen = 380) {
  return `${text || ''}`.slice(0, maxLen).trim();
}

function dedupeBy(items = [], buildKey = (item) => JSON.stringify(item)) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const key = `${buildKey(item) || ''}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeComparable(value = '') {
  return `${value || ''}`.trim().toLowerCase();
}

async function fetchDocExcerpt(url) {
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);
  const contentType = `${response.headers.get('content-type') || ''}`.toLowerCase();
  if (contentType.includes('pdf') || /\.pdf($|\?|#)/i.test(url)) {
    return { excerpt: `PDF source linked: ${url}`, contentType: contentType || 'application/pdf' };
  }
  const body = await response.text();
  const cleaned = stripText(body);
  return { excerpt: compactExcerpt(cleaned), contentType: contentType || 'text/html' };
}

const MANUAL_CHUNK_SCAN_LIMIT = 120;
const MANUAL_CHUNK_SELECTION_LIMIT = 6;
const MANUAL_CHUNK_DEFAULT_LIMIT = 4;
const MANUAL_CHUNK_INTRO_FALLBACK_LIMIT = 2;
const TASK_KEYWORD_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'have', 'has', 'had',
  'show', 'shows', 'showing', 'error', 'code', 'task', 'asset', 'machine', 'game', 'issue', 'stuck',
  'not', 'does', 'will', 'after', 'before', 'already', 'tried', 'notes', 'title', 'description'
]);

function normalizeCodeToken(value = '') {
  const raw = `${value || ''}`.trim().toUpperCase();
  if (!raw) return '';
  const spaced = raw.replace(/[_]+/g, ' ').replace(/[-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const letterDigit = spaced.match(/^([A-Z]{1,4})\s*(\d{1,4})$/);
  if (letterDigit) return `${letterDigit[1]}${Number(letterDigit[2])}`;
  const numericError = spaced.match(/^(?:ERROR(?:\s+CODE)?|CODE)\s*(\d{1,4})$/);
  if (numericError) return `E${Number(numericError[1])}`;
  return spaced.replace(/\s+/g, '');
}

function stringifyTaskValue(value) {
  if (Array.isArray(value)) return value.map((item) => stringifyTaskValue(item)).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map((item) => stringifyTaskValue(item)).join(' ');
  return `${value || ''}`;
}

function extractTaskCodeTokens(task = {}) {
  const taskBlob = [
    task?.errorCode,
    task?.errorText,
    task?.description,
    task?.title,
    task?.issueCategory,
    task?.symptomTags,
    task?.alreadyTried,
    task?.notes
  ].map((value) => stringifyTaskValue(value)).join(' ');
  const rawCodeTokens = [];
  (taskBlob.match(/\b[A-Za-z]{1,4}[\s-]?\d{1,4}\b/g) || []).forEach((token) => rawCodeTokens.push(token));
  (taskBlob.match(/\b(?:ERROR(?:\s+CODE)?|CODE)\s*[-:# ]?\s*\d{1,4}\b/gi) || []).forEach((token) => rawCodeTokens.push(token));
  const codeTokens = dedupeBy(rawCodeTokens.map((token) => normalizeCodeToken(token)).filter(Boolean), (token) => token);
  const keywordTokens = dedupeBy(
    taskBlob
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !TASK_KEYWORD_STOP_WORDS.has(token)),
    (token) => token
  ).slice(0, 12);
  return { codeTokens, keywordTokens };
}

function buildCodeRegexes(token = '') {
  const match = `${token || ''}`.match(/^([A-Z]{1,4})(\d{1,4})$/);
  if (!match) return [];
  const [, alpha, digits] = match;
  const base = [
    new RegExp(`\\b${alpha}\\s*-?\\s*${digits}\\b`, 'i')
  ];
  if (alpha === 'E') {
    base.push(new RegExp(`\\bERROR(?:\\s+CODE)?\\s*[:#-]?\\s*${digits}\\b`, 'i'));
    base.push(new RegExp(`\\bCODE\\s*[:#-]?\\s*${digits}\\b`, 'i'));
  }
  return base;
}

function scoreManualChunkForTask(chunkText = '', tokens = {}) {
  const text = `${chunkText || ''}`;
  if (!text) return { score: 0, matchedCodes: [], matchedKeywords: [] };
  const matchedCodes = [];
  const codeTokens = Array.isArray(tokens.codeTokens) ? tokens.codeTokens : [];
  codeTokens.forEach((codeToken) => {
    const regexes = buildCodeRegexes(codeToken);
    if (regexes.some((regex) => regex.test(text))) {
      matchedCodes.push(codeToken);
    }
  });
  const lowered = text.toLowerCase();
  const matchedKeywords = (Array.isArray(tokens.keywordTokens) ? tokens.keywordTokens : []).filter((keyword) => lowered.includes(keyword));
  const mappingCue = /\b(out of|means|indicates|definition|fault|alarm|empty|low|jam|blocked)\b/i.test(text);
  let score = 0;
  if (matchedCodes.length) score += 40 + ((matchedCodes.length - 1) * 15);
  if (matchedCodes.length && mappingCue) score += 12;
  score += Math.min(matchedKeywords.length * 2, 10);
  return { score, matchedCodes, matchedKeywords };
}

async function fetchApprovedManualChunkContext(db, asset = {}, task = {}) {
  const companyId = `${asset.companyId || ''}`.trim();
  const assetId = `${asset.id || ''}`.trim();
  if (!db || !companyId || !assetId) return { items: [], hadManualWithoutExtractedText: false };

  const manualSnap = await db.collection('manuals')
    .where('companyId', '==', companyId)
    .where('assetId', '==', assetId)
    .limit(3)
    .get();

  const manuals = manualSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((manual) => ['completed', 'no_text_extracted'].includes(`${manual.extractionStatus || ''}`))
    .sort((a, b) => {
      const aTime = Date.parse(a.approvedAt || a.updatedAt || 0) || 0;
      const bTime = Date.parse(b.approvedAt || b.updatedAt || 0) || 0;
      return bTime - aTime;
    })
    .slice(0, 2);

  const taskTokens = extractTaskCodeTokens(task);
  const results = [];
  let hadManualWithoutExtractedText = false;
  for (const manual of manuals) {
    const chunkSnap = await db.collection('manuals').doc(manual.id).collection('chunks')
      .orderBy('chunkIndex', 'asc')
      .limit(MANUAL_CHUNK_SCAN_LIMIT)
      .get()
      .catch(() => ({ docs: [] }));
    const chunks = chunkSnap.docs.map((doc) => {
      const data = doc.data() || {};
      const chunkText = compactExcerpt(data?.text || '', 500);
      const chunkIndex = Number(data?.chunkIndex);
      const safeChunkIndex = Number.isFinite(chunkIndex) ? chunkIndex : Number.MAX_SAFE_INTEGER;
      const scoring = scoreManualChunkForTask(chunkText, taskTokens);
      return {
        text: chunkText,
        chunkIndex: safeChunkIndex,
        score: scoring.score,
        matchedCodes: scoring.matchedCodes
      };
    }).filter((chunk) => !!chunk.text);
    if (!chunks.length) {
      hadManualWithoutExtractedText = true;
      continue;
    }
    const matchedChunks = chunks
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex);
    const prioritizedChunks = matchedChunks.slice(0, MANUAL_CHUNK_SELECTION_LIMIT);
    const introFallbackChunks = chunks
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .slice(0, MANUAL_CHUNK_INTRO_FALLBACK_LIMIT)
      .filter((chunk) => !prioritizedChunks.some((selected) => selected.text === chunk.text));
    const selectedChunks = (prioritizedChunks.length
      ? [...prioritizedChunks, ...introFallbackChunks]
      : chunks.sort((a, b) => a.chunkIndex - b.chunkIndex).slice(0, MANUAL_CHUNK_DEFAULT_LIMIT))
      .slice(0, MANUAL_CHUNK_SELECTION_LIMIT);
    const excerpts = selectedChunks.map((chunk) => chunk.text).filter(Boolean);
    if (!excerpts.length) continue;
    const hasCodeMatch = selectedChunks.some((chunk) => Array.isArray(chunk.matchedCodes) && chunk.matchedCodes.length > 0);
    results.push({
      manualId: manual.id,
      title: manual.sourceTitle || manual.fileName || manual.sourceUrl,
      url: manual.sourceUrl || '',
      storagePath: manual.storagePath || '',
      sourceType: hasCodeMatch ? 'approved_manual_code_chunk' : 'approved_manual_chunk',
      excerpts,
      contentType: manual.contentType || 'application/pdf'
    });
  }
  return { items: results, hadManualWithoutExtractedText };
}

function pickApprovedSuggestions(asset = {}) {
  const docs = Array.isArray(asset.documentationSuggestions) ? asset.documentationSuggestions : [];
  return docs
    .filter((s) => !!s?.verified)
    .filter((s) => {
      const score = Number(s?.matchScore || 0);
      return score >= 70 || (s?.isOfficial && score >= 62) || s?.approved === true || s?.applied === true;
    })
    .sort((a, b) => Number(b?.matchScore || 0) - Number(a?.matchScore || 0))
    .slice(0, 3)
    .map((s) => ({ title: s.title || s.url, url: s.url, sourceType: 'approved_doc' }));
}


function parseCodeHintValue(code = '', value = '', sourceLabel = '') {
  const cleanCode = normalizeCodeToken(code);
  const cleanMeaning = `${value || ''}`.trim();
  if (!cleanCode || !cleanMeaning) return null;
  return {
    code: cleanCode,
    meaning: cleanMeaning,
    source: `${sourceLabel || ''}`.trim(),
    line: `${cleanCode}: ${cleanMeaning}`
  };
}

function collectAssetCodeHints(asset = {}) {
  const hints = [];
  const troubleshootingCodes = asset?.troubleshootingCodes && typeof asset.troubleshootingCodes === 'object' ? asset.troubleshootingCodes : {};
  Object.entries(troubleshootingCodes).forEach(([code, meaning]) => {
    const parsed = parseCodeHintValue(code, meaning, 'asset.troubleshootingCodes');
    if (parsed) hints.push(parsed);
  });

  const arrayFields = [
    { key: 'knownErrorCodes', label: 'asset.knownErrorCodes' },
    { key: 'errorCodes', label: 'asset.errorCodes' }
  ];
  for (const field of arrayFields) {
    const rows = Array.isArray(asset?.[field.key]) ? asset[field.key] : [];
    rows.forEach((row) => {
      if (!row) return;
      if (typeof row === 'string') {
        const match = row.match(/\b([A-Za-z]\d{1,4})\b\s*[:-]\s*(.+)$/);
        const parsed = parseCodeHintValue(match?.[1] || '', match?.[2] || '', field.label);
        if (parsed) hints.push(parsed);
        return;
      }
      const parsed = parseCodeHintValue(row.code || row.errorCode || row.id, row.meaning || row.description || row.message, row.source || field.label);
      if (parsed) hints.push(parsed);
    });
  }

  return dedupeBy(hints, (item) => `${item.code}|${normalizeComparable(item.meaning)}`);
}

function collectLibraryCodeHints(rows = []) {
  const hints = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const codeFields = [row?.errorCode, row?.code, row?.faultCode];
    const code = codeFields.map((value) => normalizeCodeToken(value)).find(Boolean) || '';
    const meaning = `${row?.codeMeaning || row?.issueSummary || row?.resolutionSummary || row?.successfulFix || ''}`.trim();
    const parsed = parseCodeHintValue(code, meaning, 'troubleshooting_library');
    if (parsed) hints.push(parsed);

    const notesBlob = [row?.notes, row?.resolutionSummary, row?.successfulFix].filter(Boolean).join(' | ');
    const extracted = notesBlob.match(/\b([A-Za-z]\d{1,4})\b\s*[:-]\s*([^|\n]+)/g) || [];
    extracted.forEach((entry) => {
      const match = entry.match(/\b([A-Za-z]\d{1,4})\b\s*[:-]\s*(.+)$/);
      const parsedHint = parseCodeHintValue(match?.[1] || '', match?.[2] || '', 'troubleshooting_library_notes');
      if (parsedHint) hints.push(parsedHint);
    });
  }
  return dedupeBy(hints, (item) => `${item.code}|${normalizeComparable(item.meaning)}`);
}

function buildCodeHintContextItem({ task = {}, asset = {}, troubleshootingLibrary = [] } = {}) {
  const taskCodes = extractTaskCodeTokens(task).codeTokens;
  const assetHints = collectAssetCodeHints(asset);
  const libraryHints = collectLibraryCodeHints(troubleshootingLibrary);
  const allHints = dedupeBy([...assetHints, ...libraryHints], (item) => `${item.code}|${normalizeComparable(item.meaning)}`);
  if (!allHints.length) return null;

  const prioritized = taskCodes.length
    ? allHints.filter((item) => taskCodes.includes(item.code))
    : allHints;
  const selected = (prioritized.length ? prioritized : allHints).slice(0, 6);
  if (!selected.length) return null;
  const titlePrefix = `${asset?.name || task?.assetName || ''}`.trim();
  return {
    sourceType: 'asset_code_hint',
    title: titlePrefix ? `${titlePrefix} known code hints` : 'Known code hints',
    excerpts: selected.map((item) => `${item.line}${item.source ? ` (${item.source})` : ''}`)
  };
}

async function fetchManualLibraryContext(db, asset = {}) {
  const manualLibraryRef = `${asset?.manualLibraryRef || ''}`.trim();
  if (!db || !manualLibraryRef) return null;
  const librarySnap = await db.collection('manualLibrary').doc(manualLibraryRef).get().catch(() => null);
  if (!librarySnap?.exists) return null;
  const record = { id: librarySnap.id, ...librarySnap.data() };
  const linkedUrl = `${record.storagePath || record.resolvedDownloadUrl || record.originalDownloadUrl || ''}`.trim();
  return {
    title: record.canonicalTitle || record.sourceTitle || asset.name || linkedUrl || manualLibraryRef,
    url: linkedUrl,
    sourcePageUrl: `${record.sourcePageUrl || ''}`.trim(),
    sourceType: 'manual_library_link',
    manualLibraryRef: record.id,
    storagePath: `${record.storagePath || ''}`.trim(),
    manufacturer: record.manufacturer || '',
    approvalState: record.approvalState || '',
    excerpts: [
      compactExcerpt([
        record.canonicalTitle ? `Shared manual: ${record.canonicalTitle}` : '',
        record.manufacturer ? `Manufacturer: ${record.manufacturer}` : '',
        record.variant ? `Variant: ${record.variant}` : '',
        record.sourcePageUrl ? `Source page: ${record.sourcePageUrl}` : '',
        record.storagePath ? `Storage path: ${record.storagePath}` : '',
        record.approved === true || record.approvalState === 'approved' ? 'Approval: approved shared manual record.' : 'Approval: shared manual record exists but still needs review.'
      ].filter(Boolean).join(' | '), 500)
    ].filter(Boolean)
  };
}

/*
Manual context layering:
- manualLibrary is the canonical shared manual record for acquisition/reuse.
- Approved manual source files for a specific company/asset still live under
  companies/{companyId}/manuals/{assetId}/{manualId}/source.pdf and extracted text
  remains in manuals/{manualId}/chunks documents.
- Task troubleshooting should prefer extracted approved chunks first, then the
  asset-linked shared manual record, then troubleshooting fixes, then support/manual URLs.
*/

async function buildDocumentationContext(db, { task = null, asset = null, troubleshootingLibrary = [] } = {}) {
  if (!asset) return { mode: 'web_internal_only', items: [] };
  const manualChunkContext = await fetchApprovedManualChunkContext(db, asset, task).catch(() => ({ items: [], hadManualWithoutExtractedText: false }));
  const approvedChunkItems = Array.isArray(manualChunkContext.items) ? manualChunkContext.items : [];
  const linkedManualLibraryItem = await fetchManualLibraryContext(db, asset).catch(() => null);
  const codeHintItem = buildCodeHintContextItem({ task, asset, troubleshootingLibrary });
  const troubleshootingItems = (Array.isArray(troubleshootingLibrary) ? troubleshootingLibrary : [])
    .filter((row) => row && (row.resolutionSummary || row.fixSummary || row.notes || row.title))
    .slice(0, approvedChunkItems.length ? 3 : 4)
    .map((row) => ({
      title: row.title || row.gameTitle || row.assetType || 'Saved troubleshooting fix',
      url: '',
      sourceType: 'troubleshooting_fix',
      excerpts: [compactExcerpt(row.resolutionSummary || row.fixSummary || row.notes || '', 500)].filter(Boolean),
      confidence: row.confidence || null
    }));
  const manualCandidates = dedupeBy([
    linkedManualLibraryItem,
    ...(asset.manualStoragePath ? [{ title: asset.name || asset.manualStoragePath, url: asset.manualStoragePath, sourceType: 'manual' }] : []),
    ...((asset.manualLinks || []).filter(Boolean).slice(0, 3).map((url) => ({ title: url, url, sourceType: 'manual' })))
  ], (item) => item?.url || `${item?.sourceType || ''}:${item?.manualLibraryRef || ''}`);
  if (!approvedChunkItems.length && manualChunkContext.hadManualWithoutExtractedText && linkedManualLibraryItem) {
    linkedManualLibraryItem.excerpts = dedupeBy([
      ...(Array.isArray(linkedManualLibraryItem.excerpts) ? linkedManualLibraryItem.excerpts : []),
      'Manual link exists but no extracted manual text was available for code lookup.'
    ], (value) => value);
    linkedManualLibraryItem.contextNote = 'manual_link_no_extracted_text';
  }
  const fallbackCandidates = manualCandidates.length || approvedChunkItems.length ? [] : pickApprovedSuggestions(asset);
  const supportCandidates = Array.isArray(asset.supportResourcesSuggestion)
    ? asset.supportResourcesSuggestion.slice(0, approvedChunkItems.length ? 1 : 2).map((s) => ({ title: s.label || s.title || s.url, url: s.url || s, sourceType: 'support' }))
    : [];

  const selected = dedupeBy([...manualCandidates, ...fallbackCandidates, ...supportCandidates].filter((x) => !!x?.url), (item) => item.url).slice(0, 4);
  const items = [
    ...approvedChunkItems,
    ...(linkedManualLibraryItem ? [linkedManualLibraryItem] : []),
    ...(codeHintItem ? [codeHintItem] : []),
    ...troubleshootingItems,
  ];
  for (const source of selected) {
    if (source.sourceType === 'manual_library_link') continue;
    try {
      const fetched = await fetchDocExcerpt(source.url);
      if (!fetched.excerpt) continue;
      items.push({
        title: source.title || source.url,
        url: source.url,
        sourceType: source.sourceType,
        excerpts: [fetched.excerpt],
        contentType: fetched.contentType
      });
    } catch (error) {
      items.push({
        title: source.title || source.url,
        url: source.url,
        sourceType: source.sourceType,
        excerpts: [],
        fetchError: error.message
      });
    }
  }

  const mode = items.some((x) => ['approved_manual_chunk', 'approved_manual_code_chunk'].includes(x.sourceType))
    ? 'approved_manual_internal'
    : items.some((x) => x.sourceType === 'manual_library_link')
    ? 'manual_library_backed'
    : items.some((x) => x.sourceType === 'asset_code_hint')
    ? 'code_hint_backed'
    : items.some((x) => x.sourceType === 'troubleshooting_fix')
    ? 'troubleshooting_backed'
    : items.some((x) => x.sourceType === 'manual')
    ? 'manual_backed'
    : (items.some((x) => x.sourceType === 'approved_doc') ? 'approved_doc_backed' : (items.length ? 'support_backed' : 'web_internal_only'));
  return { mode, items };
}

async function gatherContext(db, taskId) {
  const taskSnap = await db.collection('tasks').doc(taskId).get();
  if (!taskSnap.exists) throw new Error('Task not found');
  const task = { id: taskSnap.id, ...taskSnap.data() };
  const companyId = `${task.companyId || ''}`.trim();
  const assetId = task.assetId || null;
  const assetSnap = assetId ? await db.collection('assets').doc(assetId).get() : null;
  const asset = assetSnap?.exists ? { id: assetSnap.id, ...assetSnap.data() } : null;

  const libraryQuery = companyId
    ? db.collection('troubleshootingLibrary').where('companyId', '==', companyId).limit(30)
    : db.collection('troubleshootingLibrary').where('companyId', '==', null).limit(30);

  const [relatedTasksSnap, notesSnap, librarySnap] = await Promise.all([
    assetId ? db.collection('tasks').where('assetId', '==', assetId).orderBy('updatedAt', 'desc').limit(8).get() : Promise.resolve({ docs: [] }),
    assetId ? db.collection('notes').where('assetId', '==', assetId).orderBy('updatedAt', 'desc').limit(10).get() : Promise.resolve({ docs: [] }),
    libraryQuery.get()
  ]);

  const relatedTasks = relatedTasksSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((row) => row.id !== taskId);
  const recentNotes = notesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const libraryRecords = librarySnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((row) => {
    if (!asset) return true;
    const assetTerms = new Set([
      asset.id,
      asset.name,
      asset.normalizedName,
      asset.title,
      asset.gameTitle,
      asset.manufacturer,
      asset.type,
      asset.assetType,
      asset.family,
      asset.cabinetVariant
    ].map(normalizeComparable).filter(Boolean));
    const rowTerms = [
      row.assetId,
      row.assetName,
      row.gameTitle,
      row.title,
      row.manufacturer,
      row.assetType,
      row.type,
      row.family,
      row.cabinetVariant
    ].map(normalizeComparable).filter(Boolean);
    return rowTerms.some((term) => assetTerms.has(term));
  }).slice(0, 10);

  const documentationContext = await buildDocumentationContext(db, { task, asset, troubleshootingLibrary: libraryRecords }).catch(() => ({ mode: 'web_internal_only', items: [] }));

  return {
    task,
    asset,
    assetHistory: asset?.history || [],
    relatedTasks,
    recentNotes,
    manuals: asset?.manualLinks || [],
    troubleshootingLibrary: libraryRecords,
    documentationContext,
    assetContext: asset ? {
      locationId: asset.locationId || asset.assetLocationId || null,
      locationName: asset.locationName || asset.locationLabel || null,
      cabinetVariant: asset.cabinetVariant || null,
      family: asset.family || null
    } : null
  };
}

async function createAiRun({ db, taskId, userId, triggerSource, model, settingsSnapshot, companyId = null }) {
  const runRef = db.collection('taskAiRuns').doc();
  await runRef.set({
    id: runRef.id,
    taskId,
    status: 'queued',
    triggerSource,
    model,
    settingsSnapshot,
    companyId: companyId || null,
    createdAt: isoNow(),
    createdBy: userId,
    updatedAt: isoNow(),
    updatedBy: userId
  });
  return runRef;
}

async function writeAudit(db, payload) {
  await db.collection('auditLogs').add({
    ...payload,
    timestamp: isoNow()
  });
}

function buildTaskAiSnapshot({ runId, result, taskId, companyId, documentationContext = {} }) {
  const parsed = result?.parsed || {};
  const updatedAt = isoNow();
  return {
    currentAiRunId: runId,
    aiStatus: 'completed',
    aiUpdatedAt: updatedAt,
    aiFrontlineSummary: parsed.shortFrontlineVersion || parsed.conciseIssueSummary || '',
    aiNextSteps: Array.isArray(parsed.diagnosticSteps) ? parsed.diagnosticSteps.slice(0, 8) : [],
    aiFollowupQuestions: [],
    aiFixState: 'pending_review',
    aiLastCompletedRunSnapshot: {
      runId,
      taskId,
      companyId: companyId || null,
      completedAt: updatedAt,
      summary: parsed.conciseIssueSummary || '',
      frontline: parsed.shortFrontlineVersion || '',
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null,
      nextSteps: Array.isArray(parsed.diagnosticSteps) ? parsed.diagnosticSteps.slice(0, 8) : [],
      followupQuestions: [],
      probableCauses: Array.isArray(parsed.probableCauses) ? parsed.probableCauses.slice(0, 6) : []
      ,
      documentationMode: documentationContext.mode || 'web_internal_only',
      documentationSources: Array.isArray(documentationContext.items) ? documentationContext.items.slice(0, 6) : []
    }
  };
}

async function runPipeline({ db, taskId, userId, triggerSource, settings, traceId, followupAnswers = [], sourceRunId = '' }) {
  const taskSnap = await db.collection('tasks').doc(taskId).get();
  const taskCompanyId = taskSnap.exists ? `${taskSnap.data()?.companyId || ''}`.trim() : null;
  const sourceRunIdClean = `${sourceRunId || ''}`.trim();
  const runRef = await createAiRun({ db, taskId, userId, triggerSource, model: settings.aiModel, settingsSnapshot: settings, companyId: taskCompanyId || null });
  if (sourceRunIdClean && sourceRunIdClean !== runRef.id) {
    await db.collection('taskAiRuns').doc(sourceRunIdClean).set({
      followupStatus: 'answered',
      continuedByRunId: runRef.id,
      followupContinuedAt: isoNow(),
      updatedAt: isoNow(),
      updatedBy: userId
    }, { merge: true });
  }
  try {
    await runRef.set({
      status: 'running',
      startedAt: isoNow(),
      updatedAt: isoNow(),
      updatedBy: userId
    }, { merge: true });

    const context = await gatherContext(db, taskId);

    if (settings.aiAskFollowups && triggerSource !== 'followup' && isWeakTaskDescription(context.task)) {
      const followup = await requestFollowupQuestions({ model: settings.aiModel, traceId, context });
      if (followup.needsFollowup && followup.questions.length) {
        await runRef.set({
          status: 'followup_required',
          followupQuestions: followup.questions,
          rawResponseMeta: { traceId, responseId: followup.responseId },
          internalContextSummary: {
            relatedTaskCount: context.relatedTasks.length,
            noteCount: context.recentNotes.length,
            libraryCount: context.troubleshootingLibrary.length
          },
          documentationMode: context.documentationContext?.mode || 'web_internal_only',
          updatedAt: isoNow(),
          updatedBy: userId
        }, { merge: true });
        await db.collection('tasks').doc(taskId).set({
          currentAiRunId: runRef.id,
          aiStatus: 'followup_required',
          aiUpdatedAt: isoNow(),
          aiFollowupQuestions: followup.questions.slice(0, 8),
          updatedAt: isoNow(),
          updatedBy: userId
        }, { merge: true });
        await db.collection('taskAiFollowups').doc(runRef.id).set({
          id: runRef.id,
          taskId,
          runId: runRef.id,
          questions: followup.questions,
          answers: [],
          status: 'pending',
          companyId: context.task.companyId || null,
          createdAt: isoNow(),
          createdBy: userId,
          updatedAt: isoNow(),
          updatedBy: userId
        }, { merge: true });
        await writeAudit(db, { action: 'ai_followup_required', entityType: 'taskAiRuns', entityId: runRef.id, companyId: context.task.companyId || null, summary: `Follow-up required for task ${taskId}`, userUid: userId, traceId });
        return { runId: runRef.id, status: 'followup_required' };
      }
    }

    const webContext = await fetchWebContextForTask({ db, taskId, settings, traceId }).catch(() => ({ summary: null, sources: [], failed: true }));
    const fullContext = { ...context, followupAnswers, webContext };
    const result = await requestTroubleshootingPlan({ model: settings.aiModel, traceId, settings, context: fullContext });

    await runRef.set({
      taskId,
      assetId: context.task.assetId || null,
      status: 'completed',
      internalContextSummary: {
        relatedTaskCount: context.relatedTasks.length,
        noteCount: context.recentNotes.length,
        libraryCount: context.troubleshootingLibrary.length
      },
      webContextSummary: webContext.summary,
      finalSummary: result.parsed.conciseIssueSummary,
      probableCauses: result.parsed.probableCauses,
      immediateChecks: result.parsed.immediateChecks,
      diagnosticSteps: result.parsed.diagnosticSteps,
      recommendedFixes: result.parsed.recommendedFixes,
      toolsNeeded: result.parsed.toolsNeeded,
      partsPossiblyNeeded: result.parsed.partsPossiblyNeeded,
      safetyNotes: result.parsed.safetyNotes,
      confidence: result.parsed.confidence,
      citations: result.parsed.citations,
      documentationMode: context.documentationContext?.mode || 'web_internal_only',
      documentationSources: context.documentationContext?.items || [],
      rawResponseMeta: { ...result.responseMeta, traceId },
      shortFrontlineVersion: result.parsed.shortFrontlineVersion,
      detailedManagerVersion: result.parsed.detailedManagerVersion,
      updatedAt: isoNow(),
      updatedBy: userId
    }, { merge: true });

    const latestTaskSnap = await db.collection('tasks').doc(taskId).get();
    if (latestTaskSnap.exists) {
      const latestTask = latestTaskSnap.data() || {};
      const latestTaskCompanyId = `${latestTask.companyId || ''}`.trim();
      const expectedCompanyId = `${context.task.companyId || ''}`.trim();
      if (!expectedCompanyId || !latestTaskCompanyId || latestTaskCompanyId === expectedCompanyId) {
        await db.collection('tasks').doc(taskId).set({
          ...buildTaskAiSnapshot({
            runId: runRef.id,
            result,
            taskId,
            companyId: latestTaskCompanyId || expectedCompanyId || null,
            documentationContext: context.documentationContext || {}
          }),
          updatedAt: isoNow(),
          updatedBy: userId
        }, { merge: true });
      }
    }

    if (settings.aiAutoAttach) {
      await db.collection('tasks').doc(taskId).set({
        aiSummary: {
          runId: runRef.id,
          status: 'completed',
          summary: result.parsed.conciseIssueSummary,
          probableCauses: result.parsed.probableCauses,
          diagnosticSteps: result.parsed.diagnosticSteps,
          confidence: result.parsed.confidence,
          updatedAt: isoNow()
        }
      }, { merge: true });
    }

    await writeAudit(db, { action: 'ai_run_completed', entityType: 'taskAiRuns', entityId: runRef.id, companyId: context.task.companyId || null, summary: `AI run completed for task ${taskId}`, userUid: userId, traceId });
    return { runId: runRef.id, status: 'completed' };
  } catch (error) {
    await runRef.set({
      status: 'failed',
      error: error.message,
      failureCode: `${error?.code || 'unknown'}`.trim() || 'unknown',
      updatedAt: isoNow(),
      updatedBy: userId
    }, { merge: true });
    await db.collection('tasks').doc(taskId).set({
      currentAiRunId: runRef.id,
      aiStatus: 'failed',
      aiUpdatedAt: isoNow(),
      updatedAt: isoNow(),
      updatedBy: userId
    }, { merge: true });
    await writeAudit(db, { action: 'ai_run_failed', entityType: 'taskAiRuns', entityId: runRef.id, companyId: taskCompanyId || null, summary: `AI run failed for task ${taskId}: ${error.message}`, userUid: userId, traceId });
    return { runId: runRef.id, status: 'failed', error: error.message };
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  runPipeline,
  isWeakTaskDescription,
  buildDocumentationContext,
  gatherContext
};
