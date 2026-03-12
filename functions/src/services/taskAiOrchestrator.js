const { requestFollowupQuestions, requestTroubleshootingPlan } = require('./openaiService');
const { fetchWebContextForTask } = require('./webContextService');
const { isWeakTaskDescription } = require('../lib/followup');

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

async function gatherContext(db, taskId) {
  const taskSnap = await db.collection('tasks').doc(taskId).get();
  if (!taskSnap.exists) throw new Error('Task not found');
  const task = { id: taskSnap.id, ...taskSnap.data() };
  const assetId = task.assetId || null;
  const assetSnap = assetId ? await db.collection('assets').doc(assetId).get() : null;
  const asset = assetSnap?.exists ? { id: assetSnap.id, ...assetSnap.data() } : null;

  const [relatedTasksSnap, notesSnap, librarySnap] = await Promise.all([
    assetId ? db.collection('tasks').where('assetId', '==', assetId).orderBy('updatedAt', 'desc').limit(8).get() : Promise.resolve({ docs: [] }),
    assetId ? db.collection('notes').where('assetId', '==', assetId).orderBy('updatedAt', 'desc').limit(10).get() : Promise.resolve({ docs: [] }),
    db.collection('troubleshootingLibrary').limit(30).get()
  ]);

  const relatedTasks = relatedTasksSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((row) => row.id !== taskId);
  const recentNotes = notesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const libraryRecords = librarySnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((row) => {
    if (!asset) return true;
    return [row.manufacturer, row.gameTitle, row.assetType].some((x) => x && [asset.manufacturer, asset.gameTitle, asset.type].includes(x));
  }).slice(0, 10);

  return {
    task,
    asset,
    assetHistory: asset?.history || [],
    relatedTasks,
    recentNotes,
    manuals: asset?.manualLinks || [],
    troubleshootingLibrary: libraryRecords
  };
}

async function createAiRun({ db, taskId, userId, triggerSource, model, settingsSnapshot }) {
  const runRef = db.collection('taskAiRuns').doc();
  await runRef.set({
    id: runRef.id,
    taskId,
    status: 'queued',
    triggerSource,
    model,
    settingsSnapshot,
    createdAt: new Date().toISOString(),
    createdBy: userId,
    updatedAt: new Date().toISOString(),
    updatedBy: userId
  });
  return runRef;
}

async function writeAudit(db, payload) {
  await db.collection('auditLogs').add({
    ...payload,
    timestamp: new Date().toISOString()
  });
}

async function runPipeline({ db, taskId, userId, triggerSource, settings, traceId, followupAnswers = [] }) {
  const runRef = await createAiRun({ db, taskId, userId, triggerSource, model: settings.aiModel, settingsSnapshot: settings });
  try {
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
          updatedAt: new Date().toISOString(),
          updatedBy: userId
        }, { merge: true });
        await db.collection('taskAiFollowups').doc(runRef.id).set({
          id: runRef.id,
          taskId,
          runId: runRef.id,
          questions: followup.questions,
          answers: [],
          status: 'pending',
          createdAt: new Date().toISOString(),
          createdBy: userId,
          updatedAt: new Date().toISOString(),
          updatedBy: userId
        }, { merge: true });
        await writeAudit(db, { action: 'ai_followup_required', entityType: 'taskAiRuns', entityId: runRef.id, summary: `Follow-up required for task ${taskId}`, userUid: userId, traceId });
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
      rawResponseMeta: { ...result.responseMeta, traceId },
      shortFrontlineVersion: result.parsed.shortFrontlineVersion,
      detailedManagerVersion: result.parsed.detailedManagerVersion,
      updatedAt: new Date().toISOString(),
      updatedBy: userId
    }, { merge: true });

    if (settings.aiAutoAttach) {
      await db.collection('tasks').doc(taskId).set({
        aiSummary: {
          runId: runRef.id,
          status: 'completed',
          summary: result.parsed.conciseIssueSummary,
          probableCauses: result.parsed.probableCauses,
          diagnosticSteps: result.parsed.diagnosticSteps,
          confidence: result.parsed.confidence,
          updatedAt: new Date().toISOString()
        }
      }, { merge: true });
    }

    await writeAudit(db, { action: 'ai_run_completed', entityType: 'taskAiRuns', entityId: runRef.id, summary: `AI run completed for task ${taskId}`, userUid: userId, traceId });
    return { runId: runRef.id, status: 'completed' };
  } catch (error) {
    await runRef.set({ status: 'failed', error: error.message, updatedAt: new Date().toISOString(), updatedBy: userId }, { merge: true });
    await writeAudit(db, { action: 'ai_run_failed', entityType: 'taskAiRuns', entityId: runRef.id, summary: `AI run failed for task ${taskId}: ${error.message}`, userUid: userId, traceId });
    return { runId: runRef.id, status: 'failed', error: error.message };
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  runPipeline,
  isWeakTaskDescription
};
