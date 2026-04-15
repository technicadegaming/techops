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

async function fetchApprovedManualChunkContext(db, asset = {}) {
  const companyId = `${asset.companyId || ''}`.trim();
  const assetId = `${asset.id || ''}`.trim();
  if (!db || !companyId || !assetId) return [];

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

  const results = [];
  for (const manual of manuals) {
    const chunkSnap = await db.collection('manuals').doc(manual.id).collection('chunks')
      .orderBy('chunkIndex', 'asc')
      .limit(4)
      .get()
      .catch(() => ({ docs: [] }));
    const excerpts = chunkSnap.docs.map((doc) => compactExcerpt(doc.data()?.text || '', 500)).filter(Boolean);
    if (!excerpts.length) continue;
    results.push({
      manualId: manual.id,
      title: manual.sourceTitle || manual.fileName || manual.sourceUrl,
      url: manual.sourceUrl || '',
      storagePath: manual.storagePath || '',
      sourceType: 'approved_manual_chunk',
      excerpts,
      contentType: manual.contentType || 'application/pdf'
    });
  }
  return results;
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

async function buildDocumentationContext(db, asset = null, troubleshootingLibrary = []) {
  if (!asset) return { mode: 'web_internal_only', items: [] };
  const approvedChunkItems = await fetchApprovedManualChunkContext(db, asset).catch(() => []);
  const linkedManualLibraryItem = await fetchManualLibraryContext(db, asset).catch(() => null);
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
  const fallbackCandidates = manualCandidates.length || approvedChunkItems.length ? [] : pickApprovedSuggestions(asset);
  const supportCandidates = Array.isArray(asset.supportResourcesSuggestion)
    ? asset.supportResourcesSuggestion.slice(0, approvedChunkItems.length ? 1 : 2).map((s) => ({ title: s.label || s.title || s.url, url: s.url || s, sourceType: 'support' }))
    : [];

  const selected = dedupeBy([...manualCandidates, ...fallbackCandidates, ...supportCandidates].filter((x) => !!x?.url), (item) => item.url).slice(0, 4);
  const items = [
    ...approvedChunkItems,
    ...(linkedManualLibraryItem ? [linkedManualLibraryItem] : []),
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

  const mode = items.some((x) => x.sourceType === 'approved_manual_chunk')
    ? 'approved_manual_internal'
    : items.some((x) => x.sourceType === 'manual_library_link')
    ? 'manual_library_backed'
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
    return [row.manufacturer, row.gameTitle, row.assetType].some((x) => x && [asset.manufacturer, asset.gameTitle, asset.type, asset.name, asset.normalizedName, asset.family].includes(x));
  }).slice(0, 10);

  const documentationContext = await buildDocumentationContext(db, asset, libraryRecords).catch(() => ({ mode: 'web_internal_only', items: [] }));

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

function buildTaskAiSnapshot({ runId, result, taskId, companyId }) {
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
    }
  };
}

async function runPipeline({ db, taskId, userId, triggerSource, settings, traceId, followupAnswers = [] }) {
  const taskSnap = await db.collection('tasks').doc(taskId).get();
  const taskCompanyId = taskSnap.exists ? `${taskSnap.data()?.companyId || ''}`.trim() : null;
  const runRef = await createAiRun({ db, taskId, userId, triggerSource, model: settings.aiModel, settingsSnapshot: settings, companyId: taskCompanyId || null });
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
            companyId: latestTaskCompanyId || expectedCompanyId || null
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
