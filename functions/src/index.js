const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

const { DEFAULT_SETTINGS, runPipeline } = require('./services/taskAiOrchestrator');
const { assertString, sanitizeFollowupAnswers } = require('./lib/validators');
const { canAnswerFollowup, canRunManualAi, canSaveToTroubleshootingLibrary } = require('./lib/permissions');

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const OpenAI = require("openai");

admin.initializeApp();
const db = admin.firestore();

async function getUserRole(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? (snap.data().role || 'staff') : 'staff';
}

async function getAiSettings() {
  const snap = await db.collection('appSettings').doc('ai').get();
  return { ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) };
}

async function enforceRateLimit(taskId, userId) {
  const recent = await db.collection('taskAiRuns')
    .where('taskId', '==', taskId)
    .where('createdBy', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  if (recent.empty) return;
  const last = recent.docs[0].data();
  const lastMs = last.createdAt?.toMillis?.() || 0;
  if (Date.now() - lastMs < 15000) throw new HttpsError('resource-exhausted', 'Please wait before running AI troubleshooting again.');
}

exports.analyzeTaskTroubleshooting = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  console.log('analyzeTaskTroubleshooting:start', {
    taskId: request.data?.taskId,
    uid: request.auth?.uid || null,
  });

  try {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');

    assertString(request.data?.taskId, 'taskId');

    const role = await getUserRole(request.auth.uid);

    const canRun = canRunManualAi(role);
    if (!canRun) {
      throw new HttpsError('permission-denied', 'Insufficient role for AI run');
    }

    await enforceRateLimit(request.data.taskId, request.auth.uid);

    const settings = await getAiSettings();

    if (!settings.aiEnabled) {
      throw new HttpsError('failed-precondition', 'AI is disabled by admin settings');
    }

    const result = await runPipeline({
      db,
      taskId: request.data.taskId,
      userId: request.auth.uid,
      triggerSource: 'manual',
      settings,
      traceId: request.rawRequest.headers['x-cloud-trace-context'] || `manual-${Date.now()}`
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
  const role = await getUserRole(request.auth.uid);
  if (!canAnswerFollowup(role)) throw new HttpsError('permission-denied', 'Insufficient role for follow-up answers');

  const answers = sanitizeFollowupAnswers(request.data.answers || []);
  await db.collection('taskAiFollowups').doc(request.data.runId).set({
    answers,
    status: 'answered',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid
  }, { merge: true });

  const settings = await getAiSettings();
  return runPipeline({ db, taskId: request.data.taskId, userId: request.auth.uid, triggerSource: 'followup', settings, traceId: request.rawRequest.headers['x-cloud-trace-context'] || `followup-${Date.now()}`, followupAnswers: answers });
});

exports.regenerateTaskTroubleshooting = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  console.log('regenerateTaskTroubleshooting:start', {
    taskId: request.data?.taskId,
    uid: request.auth?.uid || null,
  });

  try {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
    assertString(request.data?.taskId, 'taskId');

    const role = await getUserRole(request.auth.uid);

    if (!canRunManualAi(role)) {
      throw new HttpsError('permission-denied', 'Insufficient role');
    }

    const settings = await getAiSettings();

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

exports.fetchWebContextForTask = onCall({ secrets: [OPENAI_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.taskId, 'taskId');
  const settings = await getAiSettings();
  return { enabled: settings.aiUseWebSearch, message: 'Web context fetch runs as part of orchestration pipeline.' };
});

exports.saveTaskFixToTroubleshootingLibrary = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  assertString(request.data?.taskId, 'taskId');
  const role = await getUserRole(request.auth.uid);
  if (!canSaveToTroubleshootingLibrary(role)) throw new HttpsError('permission-denied', 'Insufficient role');
  const taskSnap = await db.collection('tasks').doc(request.data.taskId).get();
  if (!taskSnap.exists) throw new HttpsError('not-found', 'Task not found');
  const task = taskSnap.data();
  const libRef = db.collection('troubleshootingLibrary').doc();
  await libRef.set({
    id: libRef.id,
    assetType: request.data.assetType || task.assetType || null,
    manufacturer: request.data.manufacturer || null,
    gameTitle: request.data.gameTitle || null,
    symptomTags: Array.isArray(request.data.symptomTags) ? request.data.symptomTags : [],
    problemSummary: request.data.problemSummary || task.title || '',
    successfulFix: request.data.successfulFix || task.notes || '',
    notes: request.data.notes || '',
    manualReferences: Array.isArray(request.data.manualReferences) ? request.data.manualReferences : [],
    sourceTaskId: request.data.taskId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: request.auth.uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid
  });
  await db.collection('auditLogs').add({ action: 'ai_save_to_library', entityType: 'troubleshootingLibrary', entityId: libRef.id, summary: `Saved fix from task ${request.data.taskId}`, userUid: request.auth.uid, timestamp: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, id: libRef.id };
});

exports.onTaskCreatedQueueAi = onDocumentCreated({
  document: 'tasks/{taskId}',
  secrets: [OPENAI_API_KEY]
}, async (event) => {
  const settings = await getAiSettings();
  if (!settings.aiEnabled) return;
  const createdBy = event.data?.data()?.createdBy || 'system';
  await runPipeline({ db, taskId: event.params.taskId, userId: createdBy, triggerSource: 'auto_create', settings, traceId: event.id || `create-${Date.now()}` });
});


exports.askOpenAI = onRequest(
  { secrets: [OPENAI_API_KEY] },
  async (req, res) => {
    try {
      const client = new OpenAI({
        apiKey: OPENAI_API_KEY.value(),
      });

      const prompt = req.body?.prompt || "Say hello";

      const response = await client.responses.create({
        model: "gpt-4.1-mini",
        input: prompt,
      });

      res.status(200).json(response);
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: error.message || "Server error",
      });
    }
  }
);
