const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

const { DEFAULT_SETTINGS, runPipeline } = require('./services/taskAiOrchestrator');
const { assertString, sanitizeFollowupAnswers } = require('./lib/validators');
const {
  canAnswerFollowup,
  canRunAssetEnrichment,
  canRunManualAi,
  canSaveToTroubleshootingLibrary,
  normalizeRole,
} = require('./lib/permissions');
const { toMillis } = require('./lib/rateLimit');
const { isoNow } = require('./lib/timestamps');
const {
  authorizeAssetEnrichment,
  getActiveMembershipForCompany,
  isGlobalAdminRole,
} = require('./lib/enrichmentAuthorization');
const { normalizeAssetEnrichmentTriggerSource } = require('./lib/assetEnrichmentTriggers');
const { resolveManualAttachAssetId, summarizeManualAttachUrl } = require('./lib/manualAttachCallable');
const {
  enrichAssetDocumentation,
  previewAssetDocumentationLookup,
  planAssetDocumentationStateRepair,
  planSingleAssetManualLiveRepair,
  resolveForcedTerminalStatus,
} = require('./services/assetEnrichmentService');
const {
  approveAssetManual,
  backfillApprovedAssetManualLinkage,
  createAssetManualId,
  materializeStoredAssetManual,
  resolveManualStoragePath,
} = require('./services/manualIngestionService');
const { researchAssetTitles } = require('./services/manualResearchService');
const {
  finalizeOnboardingBootstrap,
} = require('./services/onboardingBootstrapService');
const {
  bootstrapAttachManualFromCsvHint,
} = require('./services/csvBootstrapManualAttachService');
const {
  attachAssetManualFromUrl,
  attachAssetManualFromStoragePath,
} = require('./services/assetManualAttachService');
const { OPENAI_API_KEY } = require('./services/openaiService');

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

async function finalizeAssetEnrichmentWhenAiDisabled({ assetId, userId }) {
  const assetRef = db.collection('assets').doc(assetId);
  const assetSnap = await assetRef.get();
  if (!assetSnap.exists) throw new HttpsError('not-found', 'Asset not found');
  const asset = assetSnap.data() || {};
  const terminalStatus = resolveForcedTerminalStatus({ asset });
  await assetRef.set({
    enrichmentStatus: terminalStatus,
    enrichmentPhase: 'terminalized',
    enrichmentUpdatedAt: serverTimestamp(),
    enrichmentHeartbeatAt: serverTimestamp(),
    enrichmentFailedAt: null,
    enrichmentErrorCode: '',
    enrichmentErrorMessage: '',
    updatedAt: serverTimestamp(),
    updatedBy: userId,
  }, { merge: true });
  return terminalStatus;
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
  const lastMs = toMillis(last.createdAt);
  if (Date.now() - lastMs < 15000) {
    throw new HttpsError('resource-exhausted', 'Please wait before running AI troubleshooting again.');
  }
}

exports.finalizeOnboardingBootstrap = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  return finalizeOnboardingBootstrap({
    db,
    auth: request.auth,
    companyId: request.data?.companyId,
    requireLocation: true,
  });
});

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

    const settings = await getAiSettings(taskContext.companyId);
    const authz = await authorizeCompanyMember({
      uid: request.auth.uid,
      companyId: taskContext.companyId,
      checkAccess: (role) => canRunManualAi(role, settings),
    });

    if (!authz.allowed) {
      throw new HttpsError(
        'permission-denied',
        `Insufficient role for AI run in company ${authz.companyId || 'unknown'}`,
      );
    }

    await enforceRateLimit(request.data.taskId, request.auth.uid);

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

  await db.collection('taskAiRuns').doc(request.data.runId).set({
    followupStatus: 'answered',
    followupAnsweredAt: serverTimestamp(),
    updatedAt: isoNow(),
    updatedBy: request.auth.uid,
  }, { merge: true });

  const settings = await getAiSettings(authz.companyId);
  const pipelineResult = await runPipeline({
    db,
    taskId: request.data.taskId,
    userId: request.auth.uid,
    triggerSource: 'followup',
    settings,
    traceId: request.rawRequest.headers['x-cloud-trace-context'] || `followup-${Date.now()}`,
    followupAnswers: answers,
    sourceRunId: request.data.runId,
  });

  if (`${pipelineResult?.runId || ''}`.trim()) {
    await db.collection('taskAiRuns').doc(request.data.runId).set({
      followupStatus: 'answered',
      continuedByRunId: pipelineResult.runId,
      followupContinuedAt: serverTimestamp(),
      updatedAt: isoNow(),
      updatedBy: request.auth.uid,
    }, { merge: true });
  }

  return pipelineResult;
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

    const settings = await getAiSettings(taskContext.companyId);
    const authz = await authorizeCompanyMember({
      uid: request.auth.uid,
      companyId: taskContext.companyId,
      checkAccess: (role) => canRunManualAi(role, settings),
    });

    if (!authz.allowed) {
      throw new HttpsError(
        'permission-denied',
        `Insufficient role for AI rerun in company ${authz.companyId || 'unknown'}`,
      );
    }

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
  console.error('ENRICH_DEBUG', JSON.stringify({
    data: request.data || null,
    uid: request.auth?.uid || null,
    appCheck: request.app ? 'present' : 'missing',
  }));

  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.assetId, 'assetId');

  const authz = await authorizeAssetEnrichment({
    db,
    assetId: request.data.assetId,
    uid: request.auth.uid,
    getUserRole,
  });

  console.error('ENRICH_AUTHZ', JSON.stringify(authz));

  if (!authz.allowed) {
    if (authz.scope === 'asset_not_found') throw new HttpsError('not-found', 'Asset not found');
    throw new HttpsError('permission-denied', 'Insufficient role for asset enrichment');
  }

  const resolvedCompanyId = normalizeCompanyId(authz.companyId || request.data?.companyId);

  const settings = await getAiSettings(resolvedCompanyId);

  console.error('ENRICH_SETTINGS', JSON.stringify({
    companyId: resolvedCompanyId || null,
    aiEnabled: !!settings.aiEnabled,
  }));

  if (!settings.aiEnabled) {
    const status = await finalizeAssetEnrichmentWhenAiDisabled({
      assetId: request.data.assetId,
      userId: request.auth.uid,
    });
    return { ok: false, status, message: 'AI is disabled by admin settings' };
  }

  console.error('ENRICH_CALL_SERVICE', JSON.stringify({
    assetId: request.data?.assetId || null,
    trigger: request.data?.trigger || null,
    followupAnswer: `${request.data?.followupAnswer || ''}`.trim(),
    companyId: resolvedCompanyId || null,
  }));

  return enrichAssetDocumentation({
    db,
    assetId: request.data.assetId,
    userId: request.auth.uid,
    settings,
    triggerSource: normalizeAssetEnrichmentTriggerSource(request.data?.trigger),
    followupAnswer: `${request.data?.followupAnswer || ''}`.trim(),
    traceId: request.rawRequest.headers['x-cloud-trace-context'] || `asset-${Date.now()}`,
  });
});


exports.bootstrapAttachAssetManualFromCsvHint = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.assetId, 'assetId');
  assertString(request.data?.manualHintUrl, 'manualHintUrl');

  const authz = await authorizeAssetEnrichment({
    db,
    assetId: request.data.assetId,
    uid: request.auth.uid,
    getUserRole,
  });

  if (!authz.allowed) {
    if (authz.scope === 'asset_not_found') throw new HttpsError('not-found', 'Asset not found');
    throw new HttpsError('permission-denied', 'Insufficient role for bootstrap manual attach');
  }

  const isGlobalAdmin = isGlobalAdminRole(authz.globalRole);
  const isCompanyAdmin = normalizeRole(authz.companyRole || '') === 'admin';
  if (!isGlobalAdmin && !isCompanyAdmin) {
    throw new HttpsError('permission-denied', 'Bootstrap manual attach is restricted to admins.');
  }

  return bootstrapAttachManualFromCsvHint({
    db,
    storage: admin.storage(),
    assetId: request.data.assetId,
    userId: request.auth.uid,
    manualHintUrl: request.data.manualHintUrl,
    manualSourceHintUrl: request.data.manualSourceHintUrl || '',
    supportHintUrl: request.data.supportHintUrl || '',
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
      companyId: authz.companyId || '',
      name: `${request.data?.assetName || ''}`.trim(),
      manufacturer: `${request.data?.manufacturer || ''}`.trim(),
      serialNumber: `${request.data?.serialNumber || ''}`.trim(),
      assetId: `${request.data?.assetId || ''}`.trim(),
      followupAnswer: `${request.data?.followupAnswer || ''}`.trim(),
    },
  });
});

exports.researchAssetTitles = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.companyId, 'companyId');

  const authz = await authorizeCompanyMember({
    uid: request.auth.uid,
    companyId: request.data.companyId,
    checkAccess: canRunAssetEnrichment,
  });
  if (!authz.allowed) {
    throw new HttpsError('permission-denied', 'Insufficient role for asset enrichment');
  }

  const settings = await getAiSettings(authz.companyId);
  if (!settings.aiEnabled) {
    return { ok: false, results: [], message: 'AI is disabled by admin settings' };
  }

  return researchAssetTitles({
    db,
    settings,
    companyId: authz.companyId,
    locationId: `${request.data?.locationId || ''}`.trim(),
    titles: Array.isArray(request.data?.titles) ? request.data.titles : [],
    includeInternalDocs: request.data?.includeInternalDocs !== false,
    maxWebSources: Number(request.data?.maxWebSources || settings.manualResearchMaxWebSources || 5),
    traceId: request.rawRequest.headers['x-cloud-trace-context'] || `asset-research-${Date.now()}`,
  });
});

exports.repairAssetDocumentationState = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const requestedAssetId = `${request.data?.assetId || ''}`.trim();
  const requestedCompanyId = normalizeCompanyId(request.data?.companyId);
  const dryRun = request.data?.dryRun === true;
  const limit = Math.max(1, Math.min(Number(request.data?.limit || 25) || 25, 100));
  if (!requestedAssetId && !requestedCompanyId) {
    throw new HttpsError('invalid-argument', 'assetId or companyId is required');
  }

  let scopedCompanyId = requestedCompanyId;
  let assetDocs = [];
  if (requestedAssetId) {
    const authz = await authorizeAssetEnrichment({
      db,
      assetId: requestedAssetId,
      uid: request.auth.uid,
      getUserRole,
    });

    if (!authz.allowed) {
      if (authz.scope === 'asset_not_found') throw new HttpsError('not-found', 'Asset not found');
      throw new HttpsError('permission-denied', 'Insufficient role for asset enrichment');
    }

    const assetRef = db.collection('assets').doc(requestedAssetId);
    const assetSnap = await assetRef.get();
    if (!assetSnap.exists) throw new HttpsError('not-found', 'Asset not found');
    let asset = { id: assetSnap.id, ...(assetSnap.data() || {}) };
    if (scopedCompanyId && normalizeCompanyId(asset.companyId) && scopedCompanyId !== normalizeCompanyId(asset.companyId)) {
      throw new HttpsError('invalid-argument', 'assetId/companyId mismatch');
    }
    scopedCompanyId = normalizeCompanyId(asset.companyId) || scopedCompanyId;
    const manualLinkage = await backfillApprovedAssetManualLinkage({
      db,
      storage: admin.storage(),
      asset,
      userId: request.auth.uid,
      dryRun,
    });
    if (!dryRun && manualLinkage.linked && !manualLinkage.skipped) {
      const refreshedSnap = await assetRef.get();
      if (refreshedSnap.exists) {
        asset = { id: refreshedSnap.id, ...(refreshedSnap.data() || {}) };
      }
    }
    assetDocs = [{
      ref: assetRef,
      asset,
      manualLinkage,
    }];
  } else {
    const authz = await authorizeCompanyMember({
      uid: request.auth.uid,
      companyId: requestedCompanyId,
      checkAccess: canRunAssetEnrichment,
    });
    if (!authz.allowed) {
      throw new HttpsError('permission-denied', `Insufficient role for asset enrichment in company ${requestedCompanyId}`);
    }
    const querySnap = await db.collection('assets')
      .where('companyId', '==', requestedCompanyId)
      .limit(limit)
      .get();
    assetDocs = querySnap.docs.map((doc) => ({ ref: doc.ref, asset: { id: doc.id, ...(doc.data() || {}) } }));
  }

  const report = {
    ok: true,
    dryRun,
    scope: requestedAssetId ? 'asset' : 'company',
    assetId: requestedAssetId || null,
    companyId: scopedCompanyId || requestedCompanyId || null,
    limit,
    summary: {
      scanned: 0,
      patched: 0,
      unchanged: 0,
      skipped: 0,
      errors: 0,
    },
    patched: [],
    unchanged: [],
    skipped: [],
    errors: [],
    manualMaterialization: {
      scanned: 0,
      materialized: 0,
      alreadyHadChunks: 0,
      noTextExtracted: 0,
      failed: 0,
      skipped: 0,
      entries: [],
    },
  };

  async function attemptStoredManualMaterialization(asset = {}) {
    const companyId = `${asset.companyId || ''}`.trim();
    const assetId = `${asset.id || ''}`.trim();
    const storageCandidates = [
      `${asset.manualStoragePath || ''}`.trim(),
      `${asset.manualUrl || ''}`.trim(),
      ...((Array.isArray(asset.manualLinks) ? asset.manualLinks : []).map((value) => `${value || ''}`.trim()))
    ].filter(Boolean);
    let resolvedStorage = { storagePath: '', sourceKind: 'missing', errorCode: 'storage_path_missing' };
    for (const candidate of storageCandidates) {
      const candidateResolved = resolveManualStoragePath(candidate);
      if (candidateResolved.storagePath) {
        resolvedStorage = candidateResolved;
        break;
      }
      if (!resolvedStorage.storagePath && candidateResolved.errorCode) resolvedStorage = candidateResolved;
    }
    const manualStoragePath = `${resolvedStorage.storagePath || ''}`.trim();
    report.manualMaterialization.scanned += 1;
    if (!companyId || !assetId) {
      report.manualMaterialization.skipped += 1;
      report.manualMaterialization.entries.push({
        assetId,
        manualId: '',
        priorExtractionStatus: `${asset.manualTextExtractionStatus || ''}`.trim() || 'unknown',
        newExtractionStatus: 'skipped',
        priorChunkCount: Number(asset.manualChunkCount || 0) || 0,
        newChunkCount: 0,
        extractionEngine: 'none',
        extractionStatus: 'skipped',
        extractionReason: 'storage_path_missing',
        extractionError: '',
        storagePath: manualStoragePath,
        reason: 'missing_company_or_asset_id',
      });
      return;
    }
    if (!manualStoragePath) {
      report.manualMaterialization.skipped += 1;
      report.manualMaterialization.entries.push({
        assetId,
        manualId: '',
        priorExtractionStatus: `${asset.manualTextExtractionStatus || ''}`.trim() || 'unknown',
        newExtractionStatus: 'skipped',
        priorChunkCount: Number(asset.manualChunkCount || 0) || 0,
        newChunkCount: 0,
        extractionEngine: 'none',
        extractionStatus: 'skipped',
        extractionReason: resolvedStorage.errorCode || 'storage_path_missing',
        extractionError: '',
        storagePath: '',
        contentType: `${asset.manualContentType || ''}`.trim(),
        extension: '',
        reason: resolvedStorage.errorCode || 'storage_path_missing',
        action: 'no_manual_storage_path',
      });
      return;
    }
    const manualStatus = `${asset.manualStatus || ''}`.trim();
    const statusAllowsRepair = ['manual_attached', 'docs_found', 'manual_attached_bootstrap'].includes(manualStatus);
    if (!statusAllowsRepair) {
      report.manualMaterialization.skipped += 1;
      report.manualMaterialization.entries.push({
        assetId,
        manualId: '',
        priorExtractionStatus: `${asset.manualTextExtractionStatus || ''}`.trim() || 'unknown',
        newExtractionStatus: 'skipped',
        priorChunkCount: Number(asset.manualChunkCount || 0) || 0,
        newChunkCount: 0,
        extractionEngine: 'none',
        extractionStatus: 'skipped',
        extractionReason: 'storage_path_missing',
        extractionError: '',
        storagePath: manualStoragePath,
        reason: 'manual_status_not_repairable',
      });
      return;
    }
    const sourceUrl = `${asset.manualSourceUrl || asset.manualUrl || ''}`.trim();
    const manualId = createAssetManualId({ companyId, assetId, storagePath: manualStoragePath, sourceUrl });
    const manualSnap = await db.collection('manuals').doc(manualId).get().catch(() => null);
    const manualDoc = manualSnap?.exists ? { id: manualSnap.id, ...(manualSnap.data() || {}) } : null;
    const priorExtractionStatus = `${manualDoc?.extractionStatus || asset.manualTextExtractionStatus || 'unknown'}`.trim() || 'unknown';
    const chunkCount = Number(manualDoc?.chunkCount || asset.manualChunkCount || 0);
    const priorChunkCount = chunkCount;
    const hasChunkDocs = manualDoc
      ? (await db.collection('manuals').doc(manualId).collection('chunks').limit(1).get().catch(() => ({ docs: [] }))).docs.length > 0
      : false;
    const needsReextract = ['no_text_extracted', 'failed'].includes(priorExtractionStatus) || !hasChunkDocs || chunkCount <= 0;
    if (manualDoc && hasChunkDocs && chunkCount > 0 && !needsReextract) {
      report.manualMaterialization.alreadyHadChunks += 1;
      report.manualMaterialization.entries.push({
        assetId,
        manualId,
        priorExtractionStatus,
        newExtractionStatus: manualDoc.extractionStatus || 'completed',
        priorChunkCount,
        newChunkCount: chunkCount,
        extractionEngine: `${manualDoc.extractionEngine || ''}`.trim() || 'none',
        extractionStatus: 'already_has_chunks',
        extractionReason: 'already_has_chunks',
        extractionError: '',
        storagePath: manualStoragePath,
        contentType: `${manualDoc.contentType || asset.manualContentType || ''}`.trim(),
        extension: `${manualDoc.fileName || ''}`.trim().split('.').pop() || '',
        reason: 'already_has_chunks',
        action: 'already_has_chunks',
      });
      return;
    }
    if (dryRun) {
      report.manualMaterialization.materialized += 1;
      report.manualMaterialization.entries.push({
        assetId,
        manualId,
        priorExtractionStatus,
        newExtractionStatus: 'planned',
        priorChunkCount,
        newChunkCount: 0,
        extractionEngine: `${manualDoc?.extractionEngine || ''}`.trim() || 'none',
        extractionStatus: manualDoc?.extractionStatus || 'skipped',
        extractionReason: manualDoc?.extractionReason || 'storage_path_missing',
        extractionError: '',
        storagePath: manualStoragePath,
        contentType: `${manualDoc?.contentType || asset.manualContentType || ''}`.trim(),
        extension: `${manualDoc?.fileName || ''}`.trim().split('.').pop() || '',
        reason: 'dry_run_materialization_planned',
        action: manualDoc ? 'would_reextract' : 'would_materialize',
      });
      return;
    }
    try {
      const result = await materializeStoredAssetManual({
        db,
        storage: admin.storage(),
        asset,
        userId: request.auth.uid,
        storagePath: manualStoragePath,
        sourceUrl,
        sourceTitle: `${asset.name || ''}`.trim() || 'Attached manual',
        sourceType: `${asset.sourceType || ''}`.trim() || 'csv_direct_bootstrap_manual',
        manualType: `${asset.manualType || ''}`.trim() || 'asset_attached_manual',
        contentType: `${asset.manualContentType || ''}`.trim(),
        attachmentMode: `${asset.attachmentMode || ''}`.trim(),
        manualProvenance: `${asset.manualProvenance || ''}`.trim(),
      });
      if (result?.ok === false) {
        const failureStatus = `${result.extractionStatus || 'extraction_failed'}`.trim() || 'extraction_failed';
        const failureReason = `${result.extractionReason || result.reason || 'extraction_failed'}`.trim() || 'extraction_failed';
        await db.collection('assets').doc(assetId).set({
          manualTextExtractionStatus: failureStatus,
          manualChunkCount: 0,
          latestManualId: result.manualId || manualId,
          documentationTextAvailable: false,
          updatedAt: serverTimestamp(),
          updatedBy: request.auth.uid,
        }, { merge: true });
        report.manualMaterialization.failed += 1;
        report.manualMaterialization.entries.push({
          assetId,
          manualId: result.manualId || manualId,
          priorExtractionStatus,
          newExtractionStatus: failureStatus,
          priorChunkCount,
          newChunkCount: 0,
          extractionEngine: result.extractionEngine || 'none',
          extractionStatus: failureStatus,
          extractionReason: failureReason,
          extractionError: `${result.extractionError || ''}`.trim(),
          storagePath: result.storagePath || manualStoragePath,
          contentType: `${result.contentType || asset.manualContentType || ''}`.trim(),
          extension: `${result.extension || (manualStoragePath.split('.').pop() || '').toLowerCase()}`.trim(),
          reason: failureReason,
          action: 'extraction_failed',
        });
        return;
      }
      const nextChunkCount = Number(result.chunkCount || 0);
      await db.collection('assets').doc(assetId).set({
        manualTextExtractionStatus: result.extractionStatus || 'extraction_failed',
        manualChunkCount: nextChunkCount,
        latestManualId: result.manualId || manualId,
        documentationTextAvailable: nextChunkCount > 0,
        updatedAt: serverTimestamp(),
        updatedBy: request.auth.uid,
      }, { merge: true });
      report.manualMaterialization.materialized += 1;
      if (result.extractionStatus === 'no_text_extracted') report.manualMaterialization.noTextExtracted += 1;
      const contentType = `${result.contentType || asset.manualContentType || ''}`.trim();
      const extension = `${result.extension || ''}`.trim() || (manualStoragePath.split('.').pop() || '').toLowerCase();
      report.manualMaterialization.entries.push({
        assetId,
        manualId: result.manualId || manualId,
        priorExtractionStatus,
        newExtractionStatus: result.extractionStatus || 'completed',
        priorChunkCount,
        newChunkCount: nextChunkCount,
        extractionEngine: result.extractionEngine || 'none',
        extractionStatus: result.extractionStatus || 'completed',
        extractionReason: result.extractionReason || (nextChunkCount > 0 ? 'text_extracted' : 'no_readable_text_found'),
        extractionError: result.extractionError || '',
        storagePath: result.storagePath || manualStoragePath,
        contentType,
        extension,
        reason: result.extractionReason || (nextChunkCount > 0 ? 'text_extracted' : 'no_readable_text_found'),
        action: nextChunkCount > 0 ? (manualDoc ? 'reextracted' : 'materialized') : 'materialized_without_text',
      });
    } catch (error) {
      report.manualMaterialization.failed += 1;
      const message = `${error?.message || String(error)}`.slice(0, 240);
      report.manualMaterialization.entries.push({
        assetId,
        manualId,
        priorExtractionStatus,
        newExtractionStatus: 'extraction_failed',
        priorChunkCount,
        newChunkCount: 0,
        extractionEngine: `${manualDoc?.extractionEngine || ''}`.trim() || 'none',
        extractionStatus: 'extraction_failed',
        extractionReason: 'pdf_parse_error',
        extractionError: message,
        storagePath: manualStoragePath,
        contentType: `${manualDoc?.contentType || asset.manualContentType || ''}`.trim(),
        extension: (manualStoragePath.split('.').pop() || '').toLowerCase(),
        reason: 'pdf_parse_error',
        action: 'extraction_failed',
      });
    }
  }

  for (const entry of assetDocs) {
    if (requestedAssetId) break;
    report.summary.scanned += 1;
    try {
      await attemptStoredManualMaterialization(entry.asset);
      const plan = await planAssetDocumentationStateRepair({
        asset: entry.asset,
        userId: request.auth.uid,
      });
      const record = {
        assetId: plan.assetId,
        companyId: plan.companyId,
        manualStatus: plan.manualStatus,
        existingEnrichmentStatus: plan.existingEnrichmentStatus,
        repairedEnrichmentStatus: plan.repairedEnrichmentStatus || null,
        reason: plan.reason,
        changedFields: plan.changedFields,
      };
      if (plan.skipped) {
        report.summary.skipped += 1;
        report.skipped.push(record);
        continue;
      }
      if (plan.unchanged) {
        report.summary.unchanged += 1;
        report.unchanged.push(record);
        continue;
      }
      if (!dryRun) {
        await entry.ref.set(plan.updatePayload, { merge: true });
      }
      report.summary.patched += 1;
      report.patched.push(record);
    } catch (error) {
      report.summary.errors += 1;
      report.errors.push({
        assetId: entry.asset.id,
        companyId: `${entry.asset.companyId || ''}`.trim(),
        message: error?.message || String(error),
      });
    }
  }

  if (requestedAssetId && assetDocs.length === 1) {
    const [{ ref, asset, manualLinkage }] = assetDocs;
    report.summary.scanned = 1;
    await attemptStoredManualMaterialization(asset);
    const liveRepair = await planSingleAssetManualLiveRepair({
      asset,
      userId: request.auth.uid,
      exactManualLinked: manualLinkage?.linked === true && manualLinkage?.skipped !== true,
      exactManualEvidence: manualLinkage?.evidence || '',
    });
    if (liveRepair.warnings.includes('active_enrichment_heartbeat')) {
      report.summary.skipped = 1;
      report.summary.patched = 0;
      report.summary.unchanged = 0;
      report.summary.errors = 0;
      report.patched = [];
      report.unchanged = [];
      report.skipped = [{
        assetId: liveRepair.assetId,
        companyId: liveRepair.companyId,
        manualStatus: liveRepair.priorState.manualStatus,
        existingEnrichmentStatus: liveRepair.priorState.enrichmentStatus,
        repairedEnrichmentStatus: null,
        reason: 'active_enrichment_heartbeat',
        changedFields: [],
      }];
    } else {
      if (!dryRun && liveRepair.statusChanged) {
        await ref.set(liveRepair.updatePayload, { merge: true });
      }
      report.summary.patched = liveRepair.statusChanged ? 1 : 0;
      report.summary.unchanged = liveRepair.statusChanged ? 0 : 1;
      report.summary.skipped = 0;
      report.summary.errors = 0;
      report.patched = liveRepair.statusChanged ? [{
        assetId: liveRepair.assetId,
        companyId: liveRepair.companyId,
        manualStatus: liveRepair.finalState?.manualStatus || null,
        existingEnrichmentStatus: liveRepair.priorState.enrichmentStatus,
        repairedEnrichmentStatus: liveRepair.finalState?.enrichmentStatus || null,
        reason: liveRepair.attachedManual ? 'single_asset_live_manual_attached' : 'single_asset_live_manual_finalized',
        changedFields: Object.keys(liveRepair.updatePayload || {}),
      }] : [];
      report.unchanged = liveRepair.statusChanged ? [] : [{
        assetId: liveRepair.assetId,
        companyId: liveRepair.companyId,
        manualStatus: liveRepair.finalState?.manualStatus || null,
        existingEnrichmentStatus: liveRepair.priorState.enrichmentStatus,
        repairedEnrichmentStatus: liveRepair.finalState?.enrichmentStatus || null,
        reason: 'single_asset_live_manual_already_terminal',
        changedFields: [],
      }];
      report.skipped = [];
    }
    report.liveRepair = {
      assetId: liveRepair.assetId,
      companyId: liveRepair.companyId,
      priorState: liveRepair.priorState,
      finalState: liveRepair.finalState,
      attachedManual: liveRepair.attachedManual,
      manualSource: liveRepair.manualSource || '',
      statusChanged: liveRepair.statusChanged,
      notes: liveRepair.notes,
      warnings: [
        ...(manualLinkage?.skipped ? [manualLinkage.reason] : []),
        ...(liveRepair.warnings || []),
      ],
      linkage: manualLinkage ? {
        linked: manualLinkage.linked === true,
        patchedAsset: manualLinkage.patchedAsset === true,
        materializedManual: manualLinkage.materializedManual === true,
        reason: manualLinkage.reason || '',
        evidence: manualLinkage.evidence || '',
        manualId: manualLinkage.manualId || '',
      } : null,
    };
  }

  return report;
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

exports.backfillApprovedAssetManualLinkage = onCall({}, async (request) => {
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
    throw new HttpsError('permission-denied', 'Insufficient role for manual linkage backfill');
  }

  const assetSnap = await db.collection('assets').doc(request.data.assetId).get();
  if (!assetSnap.exists) throw new HttpsError('not-found', 'Asset not found');

  return backfillApprovedAssetManualLinkage({
    db,
    storage: admin.storage(),
    asset: { id: assetSnap.id, ...assetSnap.data() },
    userId: request.auth.uid,
    dryRun: request.data?.dryRun === true,
  });
});

exports.attachAssetManualFromUrl = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const requestedAssetId = resolveManualAttachAssetId(request.data || {});
  assertString(requestedAssetId, 'assetId');
  assertString(request.data?.manualUrl, 'manualUrl');

  const requestedCompanyId = normalizeCompanyId(request.data?.companyId);
  const urlSummary = summarizeManualAttachUrl(request.data?.manualUrl);
  console.log('attachAssetManualFromUrl:start', {
    assetId: requestedAssetId,
    uid: request.auth.uid,
    requestCompanyId: requestedCompanyId,
    manualUrlHost: urlSummary.host,
    manualUrlPathLength: urlSummary.pathLength,
  });

  const authz = await authorizeAssetEnrichment({
    db,
    assetId: requestedAssetId,
    uid: request.auth.uid,
    getUserRole,
  });
  if (!authz.allowed) {
    console.warn('attachAssetManualFromUrl:authz_denied', {
      assetId: requestedAssetId,
      uid: request.auth.uid,
      requestCompanyId: requestedCompanyId,
      scope: authz.scope || 'unknown',
      companyId: authz.companyId || null,
      companyRole: authz.companyRole || null,
      globalRole: authz.globalRole || null,
      assetExists: authz.scope !== 'asset_not_found',
    });
    if (authz.scope === 'asset_not_found') throw new HttpsError('not-found', 'Asset not found for manual attachment. Refresh the asset list and try again.');
    throw new HttpsError('permission-denied', 'Insufficient role for manual attachment');
  }

  const asset = authz.asset ? { id: requestedAssetId, ...authz.asset } : null;
  const assetExists = !!asset?.id;
  console.log('attachAssetManualFromUrl:authorized', {
    assetId: requestedAssetId,
    uid: request.auth.uid,
    requestCompanyId: requestedCompanyId,
    assetCompanyId: asset?.companyId || null,
    assetExists,
  });
  if (!assetExists) throw new HttpsError('not-found', 'Asset not found for manual attachment. Refresh the asset list and try again.');
  if (requestedCompanyId && `${asset.companyId || ''}`.trim() && requestedCompanyId !== `${asset.companyId || ''}`.trim()) {
    throw new HttpsError('permission-denied', 'Asset/company mismatch for manual attachment.');
  }
  return attachAssetManualFromUrl({
    db,
    storage: admin.storage(),
    asset,
    userId: request.auth.uid,
    manualUrl: `${request.data?.manualUrl || ''}`.trim(),
    sourceTitle: `${request.data?.sourceTitle || ''}`.trim(),
    sourcePageUrl: `${request.data?.sourcePageUrl || ''}`.trim(),
  });
});

exports.attachAssetManualFromStoragePath = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const requestedAssetId = resolveManualAttachAssetId(request.data || {});
  assertString(requestedAssetId, 'assetId');
  assertString(request.data?.storagePath, 'storagePath');

  const requestedCompanyId = normalizeCompanyId(request.data?.companyId);
  console.log('attachAssetManualFromStoragePath:start', {
    assetId: requestedAssetId,
    uid: request.auth.uid,
    requestCompanyId: requestedCompanyId,
    storagePathLength: `${request.data?.storagePath || ''}`.trim().length,
  });

  const authz = await authorizeAssetEnrichment({
    db,
    assetId: requestedAssetId,
    uid: request.auth.uid,
    getUserRole,
  });
  if (!authz.allowed) {
    console.warn('attachAssetManualFromStoragePath:authz_denied', {
      assetId: requestedAssetId,
      uid: request.auth.uid,
      requestCompanyId: requestedCompanyId,
      scope: authz.scope || 'unknown',
      companyId: authz.companyId || null,
      companyRole: authz.companyRole || null,
      globalRole: authz.globalRole || null,
      assetExists: authz.scope !== 'asset_not_found',
    });
    if (authz.scope === 'asset_not_found') throw new HttpsError('not-found', 'Asset not found for manual attachment. Refresh the asset list and try again.');
    throw new HttpsError('permission-denied', 'Insufficient role for manual attachment');
  }

  const asset = authz.asset ? { id: requestedAssetId, ...authz.asset } : null;
  const assetExists = !!asset?.id;
  console.log('attachAssetManualFromStoragePath:authorized', {
    assetId: requestedAssetId,
    uid: request.auth.uid,
    requestCompanyId: requestedCompanyId,
    assetCompanyId: asset?.companyId || null,
    assetExists,
  });
  if (!assetExists) throw new HttpsError('not-found', 'Asset not found for manual attachment. Refresh the asset list and try again.');
  if (requestedCompanyId && `${asset.companyId || ''}`.trim() && requestedCompanyId !== `${asset.companyId || ''}`.trim()) {
    throw new HttpsError('permission-denied', 'Asset/company mismatch for manual attachment.');
  }
  return attachAssetManualFromStoragePath({
    db,
    storage: admin.storage(),
    asset,
    userId: request.auth.uid,
    storagePath: `${request.data?.storagePath || ''}`.trim(),
    sourceTitle: `${request.data?.sourceTitle || ''}`.trim(),
    originalFileName: `${request.data?.originalFileName || ''}`.trim(),
    contentType: `${request.data?.contentType || ''}`.trim(),
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
  const assetSnap = task.assetId
    ? await db.collection('assets').doc(task.assetId).get().catch(() => null)
    : null;
  const taskAsset = assetSnap?.exists
    ? { id: assetSnap.id, ...assetSnap.data() }
    : null;
  const requestedCompanyId = normalizeCompanyId(request.data?.companyId);
  const taskContext = await resolveTaskCompanyContext({
    task,
    requestedCompanyId,
    userId: request.auth.uid,
  });

  const settings = await getAiSettings(taskContext.companyId);
  const authz = await authorizeCompanyMember({
    uid: request.auth.uid,
    companyId: taskContext.companyId,
    checkAccess: (role) => canSaveToTroubleshootingLibrary(role, settings),
  });
  if (!authz.allowed) throw new HttpsError('permission-denied', 'Insufficient role');

  const cleanText = (value, max = 600) => `${value || ''}`.trim().slice(0, max);
  const cleanList = (value, maxItems = 12, maxItemLength = 80) => (Array.isArray(value) ? value : [])
    .map((entry) => cleanText(entry, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
  const cleanObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const source = ['manual_save_fix', 'task_closeout'].includes(`${request.data?.source || ''}`.trim())
    ? `${request.data.source}`.trim()
    : 'manual_save_fix';
  const notes = cleanText(request.data?.notes || task.notes || '', 1000);
  const successfulFix = cleanText(
    request.data?.successfulFix
      || request.data?.resolutionSummary
      || task.closeout?.bestFixSummary
      || task.closeout?.fixPerformed
      || task.notes
      || '',
    2000,
  );

  const libRef = db.collection('troubleshootingLibrary').doc();
  await libRef.set({
    id: libRef.id,
    companyId: authz.companyId,
    sourceTaskId: request.data.taskId,
    sourceAiRunId: cleanText(request.data?.sourceAiRunId || task.currentAiRunId || task.aiLastCompletedRunSnapshot?.runId || '', 120),
    source,
    assetId: cleanText(request.data?.assetId || task.assetId || '', 160) || null,
    assetName: cleanText(request.data?.assetName || task.assetName || '', 260) || null,
    manufacturer: cleanText(request.data?.manufacturer || taskAsset?.manufacturer || '', 180) || null,
    gameTitle: cleanText(request.data?.gameTitle || request.data?.assetName || task.assetName || taskAsset?.gameTitle || taskAsset?.name, 260) || null,
    assetType: cleanText(request.data?.assetType || request.data?.type || task.assetType || taskAsset?.assetType || taskAsset?.type || '', 120) || null,
    type: cleanText(request.data?.type || taskAsset?.type || '', 120) || null,
    family: cleanText(request.data?.family || taskAsset?.family || '', 120) || null,
    cabinetVariant: cleanText(request.data?.cabinetVariant || taskAsset?.cabinetVariant || '', 120) || null,
    issueCategory: cleanText(request.data?.issueCategory || task.issueCategory || '', 140) || null,
    symptomTags: cleanList(request.data?.symptomTags?.length ? request.data.symptomTags : task.symptomTags),
    title: cleanText(request.data?.title || task.title || '', 260),
    description: cleanText(request.data?.description || task.description || '', 1200),
    problemSummary: cleanText(request.data?.problemSummary || task.title || task.description || '', 1200),
    successfulFix,
    resolutionSummary: cleanText(request.data?.resolutionSummary || successfulFix, 1200),
    notes,
    manualReferences: cleanList(request.data?.manualReferences, 12, 260),
    metadata: {
      sourcePayload: cleanObject(request.data?.metadata),
    },
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
