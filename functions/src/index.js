const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');

const { DEFAULT_SETTINGS, runPipeline } = require('./services/taskAiOrchestrator');
const { assertString, sanitizeFollowupAnswers } = require('./lib/validators');
const {
  canAnswerFollowup,
  canRunAssetEnrichment,
  canRunManualAi,
  canSaveToTroubleshootingLibrary,
} = require('./lib/permissions');
const {
  authorizeAssetEnrichment,
  getActiveMembershipForCompany,
  isGlobalAdminRole,
} = require('./lib/enrichmentAuthorization');
const {
  enrichAssetDocumentation,
  previewAssetDocumentationLookup,
  repairLegacyAssetEnrichmentRecord,
} = require('./services/assetEnrichmentService');
const { approveAssetManual } = require('./services/manualIngestionService');

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

admin.initializeApp();
const db = admin.firestore();

function serverTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

async function getUserRole(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? (snap.data().role || 'staff') : 'staff';
}

async function getAiSettings(companyId = null) {
  const normalizedCompanyId = `${companyId || ''}`.trim();
  if (normalizedCompanyId) {
    const scopedSnap = await db.collection('appSettings').doc(`ai_${normalizedCompanyId}`).get();
    if (scopedSnap.exists) return { ...DEFAULT_SETTINGS, ...scopedSnap.data() };
  }
  const snap = await db.collection('appSettings').doc('ai').get();
  return { ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) };
}

async function loadTask(taskId) {
  const taskSnap = await db.collection('tasks').doc(taskId).get();
  if (!taskSnap.exists) throw new HttpsError('not-found', 'Task not found');
  return { id: taskSnap.id, ...taskSnap.data() };
}

function normalizeCompanyId(companyId) {
  return `${companyId || ''}`.trim() || null;
}

async function resolveTaskCompanyContext({ task, requestedCompanyId, userId }) {
  const taskCompanyId = normalizeCompanyId(task.companyId);
  const normalizedRequestedCompanyId = normalizeCompanyId(requestedCompanyId);

  if (taskCompanyId && normalizedRequestedCompanyId && taskCompanyId !== normalizedRequestedCompanyId) {
    throw new HttpsError('invalid-argument', 'taskId/companyId mismatch');
  }

  if (taskCompanyId) {
    return { companyId: taskCompanyId, source: 'task' };
  }

  if (!normalizedRequestedCompanyId) {
    throw new HttpsError('failed-precondition', 'Task is missing company context required for AI.');
  }

  await db.collection('tasks').doc(task.id).set(
    {
      companyId: normalizedRequestedCompanyId,
      aiDebug: {
        companyContextRecoveredAt: serverTimestamp(),
        companyContextRecoveredBy: userId || 'system',
      },
      updatedAt: serverTimestamp(),
      updatedBy: userId || 'system',
    },
    { merge: true },
  );

  return { companyId: normalizedRequestedCompanyId, source: 'request_backfill' };
}

async function authorizeCompanyMember({ uid, companyId, checkAccess }) {
  const globalRole = await getUserRole(uid);
  if (isGlobalAdminRole(globalRole)) {
    return { allowed: true, scope: 'global_admin', globalRole, companyId };
  }

  const normalizedCompanyId = normalizeCompanyId(companyId);
  if (!normalizedCompanyId) {
    const allowed = checkAccess(globalRole);
    return { allowed, scope: 'legacy_no_company', globalRole, companyId: null };
  }

  const membership = await getActiveMembershipForCompany({
    db,
    companyId: normalizedCompanyId,
    uid,
  });
  const companyRole = `${membership?.role || ''}`.trim().toLowerCase();
  const allowed = checkAccess(companyRole);
  return {
    allowed,
    scope: 'company_membership',
    companyRole,
    globalRole,
    companyId: normalizedCompanyId,
  };
}

async function enforceRateLimit(taskId, userId) {
  const recent = await db
    .collection('taskAiRuns')
    .where('taskId', '==', taskId)
    .where('createdBy', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (recent.empty) return;

  const last = recent.docs[0].data();
  const lastMs = last.createdAt?.toMillis?.() || 0;
  if (Date.now() - lastMs < 15000) {
    throw new HttpsError('resource-exhausted', 'Please wait before running AI troubleshooting again.');
  }
}

exports.analyzeTaskTroubleshooting = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  console.log('analyzeTaskTroubleshooting:start', {
    taskId: request.data?.taskId,
    uid: request.auth?.uid || null,
  });

  try {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');

    assertString(request.data?.taskId, 'taskId');

    const task = await loadTask(request.data.taskId);
    const requestedCompanyId = normalizeCompanyId(request.data?.companyId);
    const taskContext = await resolveTaskCompanyContext({
      task,
      requestedCompanyId,
      userId: request.auth.uid,
    });

    const authz = await authorizeCompanyMember({
      uid: request.auth.uid,
      companyId: taskContext.companyId,
      checkAccess: canRunManualAi,
    });

    if (!authz.allowed) {
      throw new HttpsError(
        'permission-denied',
        `Insufficient role for AI run in company ${authz.companyId || 'unknown'}`,
      );
    }

    await enforceRateLimit(request.data.taskId, request.auth.uid);

    const settings = await getAiSettings(authz.companyId);

    if (!settings.aiEnabled) {
      throw new HttpsError('failed-precondition', 'AI is disabled by admin settings');
    }

    const result = await runPipeline({
      db,
      taskId: request.data.taskId,
      userId: request.auth.uid,
      triggerSource: 'manual',
      settings,
      traceId: request.rawRequest.headers['x-cloud-trace-context'] || `manual-${Date.now()}`,
    });

    console.log('analyzeTaskTroubleshooting:success', {
      taskId: request.data.taskId,
      result,
    });

    return result;
  } catch (error) {
    console.error('analyzeTaskTroubleshooting:error', {
      taskId: request.data?.taskId || null,
      uid: request.auth?.uid || null,
      message: error?.message || String(error),
      stack: error?.stack || null,
      code: error?.code || null,
    });
    throw error;
  }
});

exports.answerTaskFollowup = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.taskId, 'taskId');
  assertString(request.data?.runId, 'runId');

  const task = await loadTask(request.data.taskId);
  const requestedCompanyId = normalizeCompanyId(request.data?.companyId);
  const taskContext = await resolveTaskCompanyContext({
    task,
    requestedCompanyId,
    userId: request.auth.uid,
  });

  const authz = await authorizeCompanyMember({
    uid: request.auth.uid,
    companyId: taskContext.companyId,
    checkAccess: canAnswerFollowup,
  });
  if (!authz.allowed) {
    throw new HttpsError('permission-denied', 'Insufficient role for follow-up answers');
  }

  const answers = sanitizeFollowupAnswers(request.data.answers || []);
  await db.collection('taskAiFollowups').doc(request.data.runId).set(
    {
      answers,
      status: 'answered',
      updatedAt: serverTimestamp(),
      updatedBy: request.auth.uid,
    },
    { merge: true },
  );

  const settings = await getAiSettings(authz.companyId);
  return runPipeline({
    db,
    taskId: request.data.taskId,
    userId: request.auth.uid,
    triggerSource: 'followup',
    settings,
    traceId: request.rawRequest.headers['x-cloud-trace-context'] || `followup-${Date.now()}`,
    followupAnswers: answers,
  });
});

exports.regenerateTaskTroubleshooting = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  console.log('regenerateTaskTroubleshooting:start', {
    taskId: request.data?.taskId,
    uid: request.auth?.uid || null,
  });

  try {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    assertString(request.data?.taskId, 'taskId');

    const task = await loadTask(request.data.taskId);
    const requestedCompanyId = normalizeCompanyId(request.data?.companyId);
    const taskContext = await resolveTaskCompanyContext({
      task,
      requestedCompanyId,
      userId: request.auth.uid,
    });

    const authz = await authorizeCompanyMember({
      uid: request.auth.uid,
      companyId: taskContext.companyId,
      checkAccess: canRunManualAi,
    });

    if (!authz.allowed) {
      throw new HttpsError(
        'permission-denied',
        `Insufficient role for AI rerun in company ${authz.companyId || 'unknown'}`,
      );
    }

    const settings = await getAiSettings(authz.companyId);

    if (!settings.aiAllowManualRerun) {
      throw new HttpsError('failed-precondition', 'Manual rerun disabled in settings');
    }

    await enforceRateLimit(request.data.taskId, request.auth.uid);

    const result = await runPipeline({
      db,
      taskId: request.data.taskId,
      userId: request.auth.uid,
      triggerSource: 'manual',
      settings,
      traceId: request.rawRequest.headers['x-cloud-trace-context'] || `rerun-${Date.now()}`,
    });

    console.log('regenerateTaskTroubleshooting:success', {
      taskId: request.data.taskId,
      result,
    });

    return result;
  } catch (error) {
    console.error('regenerateTaskTroubleshooting:error', {
      taskId: request.data?.taskId || null,
      uid: request.auth?.uid || null,
      message: error?.message || String(error),
      stack: error?.stack || null,
      code: error?.code || null,
    });
    throw error;
  }
});

exports.enrichAssetDocumentation = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.assetId, 'assetId');

  const authz = await authorizeAssetEnrichment({
    db,
    assetId: request.data.assetId,
    uid: request.auth.uid,
    getUserRole,
  });

  if (!authz.allowed) {
    if (authz.scope === 'asset_not_found') throw new HttpsError('not-found', 'Asset not found');
    throw new HttpsError('permission-denied', 'Insufficient role for asset enrichment');
  }

  const settings = await getAiSettings(authz.companyId);
  if (!settings.aiEnabled) {
    return { ok: false, status: 'no_match_yet', message: 'AI is disabled by admin settings' };
  }

  return enrichAssetDocumentation({
    db,
    assetId: request.data.assetId,
    userId: request.auth.uid,
    settings,
    triggerSource: request.data?.trigger || 'manual',
    followupAnswer: `${request.data?.followupAnswer || ''}`.trim(),
    traceId: request.rawRequest.headers['x-cloud-trace-context'] || `asset-${Date.now()}`,
  });
});

exports.previewAssetDocumentationLookup = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.assetName, 'assetName');

  const requestedCompanyId = normalizeCompanyId(request.data?.companyId);
  const authz = await authorizeCompanyMember({
    uid: request.auth.uid,
    companyId: requestedCompanyId,
    checkAccess: canRunAssetEnrichment,
  });
  if (!authz.allowed) {
    throw new HttpsError('permission-denied', 'Insufficient role for asset enrichment');
  }

  const settings = await getAiSettings(authz.companyId);
  if (!settings.aiEnabled) {
    return { ok: false, status: 'no_strong_match', message: 'AI is disabled by admin settings' };
  }

  return previewAssetDocumentationLookup({
    settings,
    traceId: request.rawRequest.headers['x-cloud-trace-context'] || `asset-preview-${Date.now()}`,
    draftAsset: {
      name: `${request.data?.assetName || ''}`.trim(),
      manufacturer: `${request.data?.manufacturer || ''}`.trim(),
      serialNumber: `${request.data?.serialNumber || ''}`.trim(),
      assetId: `${request.data?.assetId || ''}`.trim(),
      followupAnswer: `${request.data?.followupAnswer || ''}`.trim(),
    },
  });
});

exports.repairAssetDocumentationState = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.assetId, 'assetId');

  const authz = await authorizeAssetEnrichment({
    db,
    assetId: request.data.assetId,
    uid: request.auth.uid,
    getUserRole,
  });

  if (!authz.allowed) {
    if (authz.scope === 'asset_not_found') throw new HttpsError('not-found', 'Asset not found');
    throw new HttpsError('permission-denied', 'Insufficient role for asset enrichment');
  }

  const assetRef = db.collection('assets').doc(request.data.assetId);
  const assetSnap = await assetRef.get();
  if (!assetSnap.exists) throw new HttpsError('not-found', 'Asset not found');
  const repaired = await repairLegacyAssetEnrichmentRecord({ asset: assetSnap.data() || {} });

  await assetRef.set({
    documentationSuggestions: repaired.documentationSuggestions,
    supportResourcesSuggestion: repaired.supportResourcesSuggestion,
    enrichmentFollowupQuestion: repaired.enrichmentFollowupQuestion,
    enrichmentStatus: repaired.enrichmentStatus,
    reviewState: repaired.reviewState,
    enrichmentFailedAt: repaired.enrichmentFailedAt,
    enrichmentErrorCode: repaired.enrichmentErrorCode,
    enrichmentErrorMessage: repaired.enrichmentErrorMessage,
    enrichmentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid
  }, { merge: true });

  return { ok: true, assetId: request.data.assetId, ...repaired };
});

exports.approveAssetManual = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.assetId, 'assetId');
  assertString(request.data?.sourceUrl, 'sourceUrl');

  const authz = await authorizeAssetEnrichment({
    db,
    assetId: request.data.assetId,
    uid: request.auth.uid,
    getUserRole,
  });

  if (!authz.allowed) {
    if (authz.scope === 'asset_not_found') throw new HttpsError('not-found', 'Asset not found');
    throw new HttpsError('permission-denied', 'Insufficient role for manual approval');
  }

  const assetSnap = await db.collection('assets').doc(request.data.assetId).get();
  if (!assetSnap.exists) throw new HttpsError('not-found', 'Asset not found');

  return approveAssetManual({
    db,
    storage: admin.storage(),
    asset: { id: assetSnap.id, ...assetSnap.data() },
    userId: request.auth.uid,
    sourceUrl: request.data.sourceUrl,
    sourceTitle: `${request.data?.sourceTitle || ''}`.trim(),
    sourceType: `${request.data?.sourceType || ''}`.trim() || 'approved_doc',
    approvedSuggestionIndex: Number.isInteger(request.data?.approvedSuggestionIndex) ? request.data.approvedSuggestionIndex : null,
  });
});

exports.fetchWebContextForTask = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.taskId, 'taskId');

  const task = await loadTask(request.data.taskId);
  const requestedCompanyId = normalizeCompanyId(request.data?.companyId);
  const taskContext = await resolveTaskCompanyContext({
    task,
    requestedCompanyId,
    userId: request.auth.uid,
  });

  const authz = await authorizeCompanyMember({
    uid: request.auth.uid,
    companyId: taskContext.companyId,
    checkAccess: canAnswerFollowup,
  });
  if (!authz.allowed) {
    throw new HttpsError('permission-denied', 'Insufficient role for web context preview');
  }

  const settings = await getAiSettings(authz.companyId);
  return {
    enabled: settings.aiUseWebSearch,
    message: 'Web context fetch runs as part of orchestration pipeline.',
  };
});

exports.saveTaskFixToTroubleshootingLibrary = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.taskId, 'taskId');

  const task = await loadTask(request.data.taskId);
  const requestedCompanyId = normalizeCompanyId(request.data?.companyId);
  const taskContext = await resolveTaskCompanyContext({
    task,
    requestedCompanyId,
    userId: request.auth.uid,
  });

  const authz = await authorizeCompanyMember({
    uid: request.auth.uid,
    companyId: taskContext.companyId,
    checkAccess: canSaveToTroubleshootingLibrary,
  });
  if (!authz.allowed) throw new HttpsError('permission-denied', 'Insufficient role');

  const libRef = db.collection('troubleshootingLibrary').doc();
  await libRef.set({
    id: libRef.id,
    companyId: authz.companyId,
    assetType: request.data.assetType || task.assetType || null,
    manufacturer: request.data.manufacturer || null,
    gameTitle: request.data.gameTitle || null,
    symptomTags: Array.isArray(request.data.symptomTags) ? request.data.symptomTags : [],
    problemSummary: request.data.problemSummary || task.title || '',
    successfulFix: request.data.successfulFix || task.notes || '',
    notes: request.data.notes || '',
    manualReferences: Array.isArray(request.data.manualReferences) ? request.data.manualReferences : [],
    sourceTaskId: request.data.taskId,
    createdAt: serverTimestamp(),
    createdBy: request.auth.uid,
    updatedAt: serverTimestamp(),
    updatedBy: request.auth.uid,
  });

  await db.collection('auditLogs').add({
    action: 'ai_save_to_library',
    entityType: 'troubleshootingLibrary',
    entityId: libRef.id,
    companyId: authz.companyId,
    summary: `Saved fix from task ${request.data.taskId}`,
    userUid: request.auth.uid,
    timestamp: serverTimestamp(),
  });

  return { ok: true, id: libRef.id };
});

exports.onTaskCreatedQueueAi = onDocumentCreated(
  {
    document: 'tasks/{taskId}',
    secrets: [OPENAI_API_KEY],
  },
  async (event) => {
    const taskData = event.data?.data?.() || {};
    const companyId = normalizeCompanyId(taskData.companyId);
    const settings = await getAiSettings(companyId);

    if (!companyId) {
      console.warn('onTaskCreatedQueueAi:missing_company_context', {
        taskId: event.params.taskId,
        createdBy: taskData.createdBy || null,
      });
    }

    if (!settings.aiEnabled) {
      console.log('onTaskCreatedQueueAi:disabled_by_settings', {
        taskId: event.params.taskId,
        companyId,
      });
      return;
    }

    const createdBy = taskData.createdBy || 'system';
    await runPipeline({
      db,
      taskId: event.params.taskId,
      userId: createdBy,
      triggerSource: 'auto_create',
      settings,
      traceId: event.id || `create-${Date.now()}`,
    });
  },
);
