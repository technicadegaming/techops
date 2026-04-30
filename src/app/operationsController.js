import { computeChecklistTiming } from '../features/businessHours.js';
import { createOperationsActions } from '../features/operationsActions.js';
import { buildCloseoutEvent } from '../features/workflow.js';
import { canDelete } from '../roles.js';

function sanitizeStorageSegment(value, fallback = 'item') {
  const normalized = `${value || ''}`.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || fallback;
}

function buildTaskEvidenceStoragePath(companyId, taskId, filename = '') {
  const safeTaskId = sanitizeStorageSegment(taskId, 'task');
  const safeFilename = sanitizeStorageSegment(filename, 'evidence');
  const prefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `companies/${companyId}/evidence/${safeTaskId}/${prefix}-${safeFilename}`;
}

function buildTaskEvidenceMeta({ taskId, file, storagePath, downloadURL, user }) {
  const uploadedBy = user?.email || user?.uid || 'unknown';
  return {
    id: `${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    filename: file.name,
    storagePath,
    contentType: file.type || 'application/octet-stream',
    sizeBytes: Number(file.size || 0),
    uploadedBy,
    uploadedAt: new Date().toISOString(),
    downloadURL: downloadURL || ''
  };
}

function buildAiPendingRecordMessage(runId) {
  const safeRunId = `${runId || ''}`.trim();
  return safeRunId
    ? `AI callable succeeded (run ${safeRunId}), but the run record is still syncing. Waiting for refresh.`
    : 'AI callable succeeded, but the run record is still syncing. Waiting for refresh.';
}

function mapCallableRunStatus(status = '') {
  const normalized = `${status || ''}`.trim().toLowerCase();
  if (['queued', 'running', 'completed', 'failed', 'followup_required'].includes(normalized)) return normalized;
  return 'queued';
}

function normalizeList(value = []) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => `${entry || ''}`.trim()).filter(Boolean);
}

export function createOperationsController({
  state,
  navigationController,
  refreshData,
  render,
  runAction,
  formatActionError,
  withRequiredCompanyId,
  upsertEntity,
  deleteEntity,
  getEntity,
  listEntities,
  storage,
  storageRef,
  uploadBytes,
  getDownloadURL,
  deleteObject,
  analyzeTaskTroubleshooting,
  regenerateTaskTroubleshooting,
  answerTaskFollowup,
  recordMachineStatusEvent,
  saveTaskFixToTroubleshootingLibrary,
  signOffChecklistItemWithPin,
  logAudit,
  reportActionError,
  createEmptyAssetDraft,
  buildCompanyEvidencePath = buildTaskEvidenceStoragePath,
  withGlobalBusy
}) {
  const safeWithGlobalBusy = typeof withGlobalBusy === 'function'
    ? withGlobalBusy
    : async (_title, _detail, fn) => fn();

  function setTaskAiUiState(taskId, nextState = null) {
    if (!taskId) return;
    const currentStates = { ...(state.operationsUi?.aiTaskStates || {}) };
    if (!nextState) {
      delete currentStates[taskId];
    } else {
      currentStates[taskId] = { ...nextState, updatedAt: new Date().toISOString() };
    }
    state.operationsUi = {
      ...(state.operationsUi || {}),
      aiTaskStates: currentStates
    };
  }

  function setTaskAiDisplayRun(taskId, run = null) {
    if (!taskId) return;
    const current = { ...(state.operationsUi?.aiDisplayRunsByTask || {}) };
    if (!run?.id) {
      delete current[taskId];
    } else {
      current[taskId] = run;
    }
    state.operationsUi = {
      ...(state.operationsUi || {}),
      aiDisplayRunsByTask: current
    };
  }

  function setPendingAction(taskId, action = null, label = '') {
    const current = { ...(state.operationsUi?.pendingActionsByTask || {}) };
    if (!taskId || !action) {
      if (taskId) delete current[taskId];
    } else {
      current[taskId] = { action, label, startedAt: new Date().toISOString() };
    }
    state.operationsUi = {
      ...(state.operationsUi || {}),
      pendingActionsByTask: current
    };
  }

  async function withTaskPendingAction(taskId, action, label, fn) {
    setPendingAction(taskId, action, label);
    render();
    try {
      return await fn();
    } finally {
      setPendingAction(taskId, null);
      render();
    }
  }

  function buildTroubleshootingLibraryPayload(task = {}, asset = null, overrides = {}) {
    const snapshotRunId = `${task?.aiLastCompletedRunSnapshot?.runId || task?.currentAiRunId || ''}`.trim();
    const sourceRows = Array.isArray(task?.aiLastCompletedRunSnapshot?.documentationSources) ? task.aiLastCompletedRunSnapshot.documentationSources : [];
    const topCodeSource = sourceRows.find((row) => ['approved_manual_code_definition', 'web_code_definition', 'asset_code_hint'].includes(`${row?.sourceType || ''}`)) || null;
    const sourceEvidenceIds = sourceRows
      .map((row) => `${row?.manualId || row?.url || row?.title || ''}`.trim())
      .filter(Boolean)
      .slice(0, 8);
    const matchedCode = (Array.isArray(topCodeSource?.matchedCodes) ? topCodeSource.matchedCodes[0] : (topCodeSource?.code || topCodeSource?.matchedCode || '')) || '';
    const codeMeaning = Array.isArray(topCodeSource?.excerpts) ? `${topCodeSource.excerpts[0] || ''}`.trim() : '';
    return {
      taskId: task.id,
      assetId: task.assetId || asset?.id || '',
      assetName: task.assetName || asset?.name || '',
      manufacturer: asset?.manufacturer || '',
      gameTitle: asset?.gameTitle || asset?.name || task.assetName || '',
      assetType: asset?.assetType || asset?.type || task?.assetType || '',
      type: asset?.type || '',
      family: asset?.family || '',
      cabinetVariant: asset?.cabinetVariant || '',
      issueCategory: task.issueCategory || '',
      symptomTags: normalizeList(task.symptomTags),
      title: task.title || '',
      description: task.description || '',
      problemSummary: task.title || task.description || '',
      successfulFix: '',
      resolutionSummary: '',
      notes: task.notes || '',
      sourceAiRunId: snapshotRunId,
      codeToken: matchedCode,
      codeMeaning,
      sourceEvidenceIds,
      sourceManualId: topCodeSource?.manualId || '',
      sourceUrl: topCodeSource?.url || '',
      reviewState: task.aiFixState || 'pending_review',
      ...overrides
    };
  }

  function mergeRunIntoState(run) {
    if (!run?.id) return;
    const existing = (state.taskAiRuns || []).filter((entry) => entry.id !== run.id);
    state.taskAiRuns = [run, ...existing]
      .sort((a, b) => `${b.updatedAt || b.createdAt || ''}`.localeCompare(`${a.updatedAt || a.createdAt || ''}`));
    if (run.taskId) setTaskAiDisplayRun(`${run.taskId}`.trim(), run);
  }

  async function pollForTaskAiRunRecord(taskId, runId, options = {}) {
    const timeoutMs = Number(options.timeoutMs || 30000);
    const intervalMs = Number(options.intervalMs || 900);
    const startedAt = Date.now();
    const expectedRunId = `${runId || ''}`.trim();
    const task = (state.tasks || []).find((entry) => entry.id === taskId) || null;
    const taskCompanyId = `${task?.companyId || ''}`.trim();
    let latestRuns = [];

    while (Date.now() - startedAt <= timeoutMs) {
      let directRun = null;
      try {
        directRun = await getEntity('taskAiRuns', expectedRunId, { bypassCompanyFilter: true });
      } catch (error) {
        return { found: false, run: null, timedOut: false, errorType: 'read_failed', error };
      }

      if (directRun) {
        const runTaskId = `${directRun.taskId || ''}`.trim();
        const runCompanyId = `${directRun.companyId || ''}`.trim();
        if (runTaskId && runTaskId !== `${taskId}`) {
          return { found: false, run: directRun, timedOut: false, errorType: 'task_mismatch' };
        }
        if (taskCompanyId && runCompanyId && runCompanyId !== taskCompanyId) {
          return { found: false, run: directRun, timedOut: false, errorType: 'company_mismatch' };
        }
        mergeRunIntoState(directRun);
        setTaskAiDisplayRun(`${taskId}`.trim(), directRun);
        state.taskAiFollowups = await listEntities('taskAiFollowups').catch(() => state.taskAiFollowups || []);
        return { found: true, run: directRun, timedOut: false, source: 'direct' };
      }

      try {
        latestRuns = await listEntities('taskAiRuns');
        state.taskAiRuns = latestRuns;
      } catch (error) {
        return { found: false, run: null, timedOut: false, errorType: 'query_failed', error };
      }

      const match = latestRuns.find((entry) => entry.id === expectedRunId && `${entry.taskId || ''}`.trim() === `${taskId}`);
      if (match) {
        const runCompanyId = `${match.companyId || ''}`.trim();
        if (taskCompanyId && runCompanyId && runCompanyId !== taskCompanyId) {
          return { found: false, run: match, timedOut: false, errorType: 'company_mismatch' };
        }
        setTaskAiDisplayRun(`${taskId}`.trim(), match);
        state.taskAiFollowups = await listEntities('taskAiFollowups').catch(() => state.taskAiFollowups || []);
        return { found: true, run: match, timedOut: false, source: 'query' };
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    state.taskAiRuns = latestRuns;
    return { found: false, run: null, timedOut: true, errorType: 'not_found_yet' };
  }

  async function pollForLatestTaskAiRun(taskId, options = {}) {
    const timeoutMs = Number(options.timeoutMs || 30000);
    const intervalMs = Number(options.intervalMs || 1000);
    const startedAt = Date.now();
    const cleanTaskId = `${taskId || ''}`.trim();
    while (Date.now() - startedAt <= timeoutMs) {
      await refreshData();
      const latest = (state.taskAiRuns || [])
        .filter((entry) => `${entry.taskId || ''}`.trim() === cleanTaskId)
        .sort((a, b) => `${b.updatedAt || b.createdAt || ''}`.localeCompare(`${a.updatedAt || a.createdAt || ''}`))[0] || null;
      if (latest?.id) {
        setTaskAiDisplayRun(cleanTaskId, latest);
        return { found: true, run: latest };
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { found: false, run: null };
  }

  function getTaskAiFailureState(error, fallbackAction = 'run AI') {
    const code = `${error?.code || ''}`.toLowerCase();
    const message = `${error?.message || error || ''}`.trim();
    const normalizedMessage = message.toLowerCase();

    if (normalizedMessage.includes('missing company context')) {
      return {
        status: 'missing_company_context',
        message: 'Task is missing company context required for AI.'
      };
    }
    if (normalizedMessage.includes('disabled')) {
      return {
        status: 'disabled_by_settings',
        message: message || 'Company AI is disabled in settings.'
      };
    }
    if (code.includes('permission-denied') || normalizedMessage.includes('insufficient role')) {
      return {
        status: 'permission_blocked',
        message: message || 'Your company role does not allow this AI action.'
      };
    }
    return {
      status: 'failed',
      message: message || `Unable to ${fallbackAction}.`
    };
  }

  function buildPostSaveAiState({ isNewTask }) {
    const companyId = `${state.company?.id || state.activeMembership?.companyId || ''}`.trim();
    if (!companyId) {
      return {
        status: 'missing_company_context',
        message: 'Task saved, but company context is missing so AI cannot run yet.'
      };
    }
    if (!state.settings.aiEnabled) {
      return {
        status: 'disabled_by_settings',
        message: 'Task saved. AI is disabled for this company. Ask an admin/manager to enable it in Admin > AI settings.'
      };
    }
    if (isNewTask) {
      return {
        status: 'queued',
        message: state.settings.aiAllowManualRerun
          ? 'Task is open and saved; AI will run automatically if enabled. Use Rerun AI later if needed.'
          : 'Task is open and saved; AI will run automatically if enabled. Manual rerun is disabled by settings.'
      };
    }
    if (state.settings.aiAllowManualRerun) {
      return {
        status: 'idle',
        message: 'Task updated. Use Rerun AI to generate a fresh troubleshooting pass if needed.'
      };
    }
    return {
      status: 'idle',
      message: 'Task updated. AI does not rerun manually for this company.'
    };
  }

  async function handleAiRunLifecycle({ taskId, result, statusPrefix }) {
    const runId = `${result?.runId || ''}`.trim() || null;
    const callableStatus = mapCallableRunStatus(result?.status);
    setTaskAiUiState(taskId, {
      status: callableStatus,
      runId,
      message: runId ? `${statusPrefix} ${runId} ${callableStatus.replaceAll('_', ' ')}.` : `${statusPrefix} ${callableStatus.replaceAll('_', ' ')}.`
    });
    render();

    if (runId) {
      setTaskAiUiState(taskId, {
        status: 'waiting_for_refresh',
        runId,
        message: buildAiPendingRecordMessage(runId)
      });
      render();
      const pollResult = await pollForTaskAiRunRecord(taskId, runId);
      if (pollResult.found && pollResult.run) {
        setTaskAiUiState(taskId, {
          status: `${pollResult.run.status || 'completed'}`,
          runId,
          message: `${statusPrefix} ${runId} is now visible with status ${pollResult.run.status || 'completed'} (${pollResult.source || 'sync'} read).`
        });
      } else if (pollResult.errorType === 'company_mismatch') {
        const runCompanyId = `${pollResult.run?.companyId || 'none'}`.trim();
        const taskCompanyId = `${state.tasks.find((entry) => entry.id === taskId)?.companyId || 'none'}`.trim();
        setTaskAiUiState(taskId, {
          status: 'failed',
          runId,
          message: `${statusPrefix} ${runId} exists but company mismatch was detected (run company: ${runCompanyId}, task company: ${taskCompanyId}).`
        });
      } else if (pollResult.errorType === 'task_mismatch') {
        setTaskAiUiState(taskId, {
          status: 'failed',
          runId,
          message: `${statusPrefix} ${runId} exists but is linked to task ${pollResult.run?.taskId || 'unknown'} instead of ${taskId}.`
        });
      } else if (pollResult.errorType === 'read_failed' || pollResult.errorType === 'query_failed') {
        const reason = `${pollResult.error?.message || 'Unable to read AI run records.'}`.trim();
        setTaskAiUiState(taskId, {
          status: 'failed',
          runId,
          message: `${statusPrefix} ${runId} started, but readback failed: ${reason}`
        });
      } else {
        setTaskAiUiState(taskId, {
          status: 'waiting_for_refresh',
          runId,
          message: `${buildAiPendingRecordMessage(runId)} This can happen briefly under normal load.`
        });
      }
    }

    render();
    await refreshData();
    render();
  }

  async function uploadTaskEvidence(taskId, file) {
    const task = state.tasks.find((entry) => entry.id === taskId);
    if (!task || !file) return;
    const companyId = `${task.companyId || state.company?.id || state.activeMembership?.companyId || ''}`.trim();
    if (!companyId) throw new Error('Missing company context for evidence upload.');
    if (!task.id) throw new Error('Missing task ID for evidence upload.');
    const storagePath = typeof buildCompanyEvidencePath === 'function'
      ? buildCompanyEvidencePath(companyId, sanitizeStorageSegment(task.id, 'task'), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeStorageSegment(file.name, 'evidence')}`)
      : buildTaskEvidenceStoragePath(companyId, task.id, file.name);
    const evidenceRef = storageRef(storage, storagePath);
    await uploadBytes(evidenceRef, file, { contentType: file.type || 'application/octet-stream' });
    const downloadURL = await getDownloadURL(evidenceRef).catch(() => '');
    const entry = buildTaskEvidenceMeta({ taskId: task.id, file, storagePath, downloadURL, user: state.user });
    await upsertEntity('tasks', task.id, {
      ...task,
      uploadedEvidence: [...(Array.isArray(task.uploadedEvidence) ? task.uploadedEvidence : []), entry],
      updatedAtClient: new Date().toISOString()
    }, state.user);
    await refreshData();
    render();
  }

  return {
    createActions() {
      return createOperationsActions({
        state,
        onLocationFilter: (locationKey) => {
          navigationController.showOperationsForLocation(locationKey);
          render();
        },
        saveTask: async (_id, payload, options = {}) => {
          const busyTitle = `${options?.busyTitle || 'Creating operation task…'}`.trim() || 'Creating operation task…';
          const busyDetail = `${options?.busyDetail || 'This can take a few seconds. Please do not refresh.'}`.trim() || 'This can take a few seconds. Please do not refresh.';
          return safeWithGlobalBusy(busyTitle, busyDetail, async () => {
          const taskId = `${payload?.id || ''}`.trim() || `${_id || ''}`.trim();
          if (!taskId) return alert('Unable to save task: missing generated task ID.');
          const existing = state.tasks.find((entry) => entry.id === taskId);
          if (existing && existing.id === taskId && existing.updatedAtClient !== payload.updatedAtClient && existing.createdAtClient !== payload.createdAtClient) {
            alert(`Task ID ${taskId} is already in use. Refresh the form to generate a new task ID.`);
            return false;
          }
          if (payload.status === 'in_progress' && !(payload.assignedWorkers || []).length) {
            alert('Assign a worker before moving a task into progress.');
            return false;
          }
          const isNewTask = !existing;
          const saved = await withTaskPendingAction(taskId, 'save_task', 'Saving…', async () => runAction('save_task', async () => {
            state.operationsUi = {
              ...(state.operationsUi || {}),
              isSavingTask: true,
              creatingTask: isNewTask,
              createTaskError: '',
              createTaskMessage: isNewTask ? 'Creating task…' : '',
            };
            render();
            const location = (state.companyLocations || []).find((entry) => entry.id === payload.locationId) || {};
            const timing = ['opening_checklist','closing_checklist','upkeep_checklist'].includes(`${payload.taskType || ''}`) ? computeChecklistTiming({ taskType: payload.taskType, scheduledForDate: payload.scheduledForDate, location }) : null;
            if (timing?.overdueStatus === 'closed_day') alert('This location is marked closed on this date.');
            await upsertEntity('tasks', taskId, withRequiredCompanyId(state, { ...payload, id: taskId, ...(timing ? { businessDate: timing.businessDate, dueAt: timing.dueAt, overdueAfter: timing.overdueAfter, checklistTimingStatus: timing.overdueStatus, businessHoursSnapshot: timing.businessHoursSnapshot } : {}) }, 'save a task'), state.user);
            const startsAi = isNewTask && state.settings?.aiEnabled;
            setTaskAiUiState(taskId, buildPostSaveAiState({ isNewTask: !existing }));
            state.operationsUi = {
              ...(state.operationsUi || {}),
              expandedTaskIds: [...new Set([...(state.operationsUi?.expandedTaskIds || []), taskId])],
              lastSavedTaskId: taskId,
              lastSaveFeedback: `Task ${taskId} saved for ${payload.assetName || payload.assetId || 'the selected asset'}.`,
              lastSaveTone: 'success',
              createTaskMessage: startsAi ? 'Task created. Starting AI troubleshooting…' : (isNewTask ? 'Task created.' : ''),
              createTaskError: ''
            };
            const createdDailyChecklist = isNewTask && ['opening_checklist', 'closing_checklist', 'upkeep_checklist'].includes(`${payload.taskType || ''}`.trim());
            state.route = createdDailyChecklist
              ? { ...state.route, tab: 'dashboard', taskId: null }
              : { ...state.route, tab: 'operations', taskId };
            await refreshData();
            render();
            if (createdDailyChecklist) {
              state.operationsUi = {
                ...(state.operationsUi || {}),
                createTaskMessage: 'Checklist created. Continue sign-off from the Dashboard.',
                createTaskError: ''
              };
              navigationController.openTab('dashboard', null, null);
            }
            if (!existing && state.settings?.aiEnabled) {
              setTaskAiUiState(taskId, { status: 'queued', message: 'AI is thinking…' });
              render();
              const autoRun = await pollForLatestTaskAiRun(taskId, { timeoutMs: 30000 });
              if (!autoRun.found) {
                setTaskAiUiState(taskId, { status: 'waiting_for_refresh', message: 'AI accepted / still syncing; refresh shortly.' });
              }
            }
            state.operationsUi = {
              ...(state.operationsUi || {}),
              creatingTask: false,
              createTaskMessage: isNewTask ? 'Task created.' : '',
            };
            return true;
          }, {
            fallbackMessage: 'Unable to save task.',
            onError: (error) => {
              state.operationsUi = {
                ...(state.operationsUi || {}),
                lastSaveFeedback: formatActionError(error, 'Unable to save task.'),
                lastSaveTone: 'error',
                creatingTask: false,
                createTaskError: formatActionError(error, 'Unable to save task.'),
                createTaskMessage: ''
              };
              render();
            }
          }).finally(() => {
            state.operationsUi = { ...(state.operationsUi || {}), isSavingTask: false, creatingTask: false };
          }));
          return !!saved;
        });
        },
        appendTaskTimeline: async (taskId, entry = {}) => {
          const task = state.tasks.find((row) => row.id === taskId);
          if (!task) return;
          if (!`${entry.note || ''}`.trim() && !Object.values(entry.attachments || {}).some((items) => (items || []).length)) return;
          await withTaskPendingAction(taskId, 'append_timeline', 'Saving…', async () => upsertEntity('tasks', taskId, {
            ...task,
            timeline: [...(task.timeline || []), {
              at: new Date().toISOString(),
              type: 'update',
              note: `${entry.note || ''}`.trim(),
              by: state.user?.email || state.user?.uid || 'unknown',
              attachments: entry.attachments || {}
            }],
            updatedAtClient: new Date().toISOString()
          }, state.user));
          state.operationsUi = {
            ...(state.operationsUi || {}),
            lastSaveFeedback: `Timeline updated for task ${taskId}.`,
            lastSaveTone: 'success'
          };
          await refreshData();
          render();
        },
        reassignTask: async (taskId) => {
          const task = state.tasks.find((entry) => entry.id === taskId);
          if (!task) return;
          const nextWorker = `${state.operationsUi?.reassignSelections?.[taskId] || ''}`.trim();
          if (!nextWorker) {
            alert('Select a worker before reassigning.');
            return;
          }
          await withTaskPendingAction(taskId, 'reassign_task', 'Saving…', async () => upsertEntity('tasks', taskId, {
            ...task,
            assignedWorkers: [nextWorker],
            timeline: [...(task.timeline || []), {
              at: new Date().toISOString(),
              type: 'assignment',
              note: `Assigned to ${nextWorker}.`,
              by: state.user?.email || state.user?.uid || 'unknown'
            }],
            updatedAtClient: new Date().toISOString()
          }, state.user));
          await refreshData();
          render();
        },
        prepareAssetCreation: ({ assetName = '', locationName = '' } = {}) => {
          state.assetDraft = {
            ...createEmptyAssetDraft(),
            name: `${assetName || ''}`.trim(),
            locationName: `${locationName || ''}`.trim()
          };
          navigationController.prepareAssetTab();
          render();
        },
        uploadTaskEvidence,
        removeTaskEvidence: async (taskId, evidenceId) => {
          const task = state.tasks.find((entry) => entry.id === taskId);
          if (!task) return;
          const existing = (Array.isArray(task.uploadedEvidence) ? task.uploadedEvidence : []).find((entry) => entry.id === evidenceId);
          if (!existing) return;
          if (existing.storagePath) {
            await deleteObject(storageRef(storage, existing.storagePath)).catch(() => {});
          }
          await upsertEntity('tasks', task.id, {
            ...task,
            uploadedEvidence: (task.uploadedEvidence || []).filter((entry) => entry.id !== evidenceId),
            updatedAtClient: new Date().toISOString()
          }, state.user);
          await refreshData();
          render();
        },
        completeTask: async (taskId, closeout) => safeWithGlobalBusy('Closing task…', 'This can take a few seconds. Please do not refresh.', async () => {
          const task = state.tasks.find((entry) => entry.id === taskId);
          if (!task) return;
          await withTaskPendingAction(taskId, 'complete_task', 'Saving…', async () => {
            const saveToLibrary = closeout.saveToLibrary === 'yes' || (closeout.saveToLibrary !== 'no' && state.settings.aiSaveSuccessfulFixesToLibraryDefault);
            const completedAt = new Date().toISOString();
            const closeoutTimeline = {
              at: completedAt,
              type: 'closeout',
              note: closeout.bestFixSummary || closeout.fixPerformed || 'Task closed',
              detail: closeout.verification || closeout.rootCause || '',
              by: state.user?.email || state.user?.uid || 'unknown',
              attachments: closeout.attachments || {}
            };
            await upsertEntity('tasks', taskId, {
              ...task,
              status: 'completed',
              closeout: { ...closeout, completedAt },
              timeline: [...(task.timeline || []), closeoutTimeline]
            }, state.user);
            if (task.assetId) {
              const asset = state.assets.find((entry) => entry.id === task.assetId) || { id: task.assetId };
              const event = buildCloseoutEvent(taskId, closeout, state.user);
              await upsertEntity('assets', task.assetId, { ...asset, history: [...(asset.history || []), event] }, state.user);
              if (closeout.markReturnedToService === 'yes' && typeof recordMachineStatusEvent === 'function') {
                await recordMachineStatusEvent({
                  companyId: state.company?.id,
                  locationId: task.locationId || asset.locationId || '',
                  assetId: task.assetId,
                  assetName: asset.name || task.assetName || '',
                  previousStatus: asset.status || '',
                  nextStatus: 'returned_to_service',
                  reason: closeout.verification || closeout.bestFixSummary || closeout.fixPerformed || 'Task closeout returned to service',
                  sourceTaskId: taskId,
                });
              }
            }
            if (saveToLibrary && closeout.fixPerformed) {
              const asset = state.assets.find((entry) => entry.id === task.assetId) || null;
              const payload = buildTroubleshootingLibraryPayload(task, asset, {
                successfulFix: closeout.bestFixSummary || closeout.fixPerformed,
                resolutionSummary: closeout.bestFixSummary || closeout.fixPerformed,
                notes: closeout.verification || closeout.rootCause || task.notes || '',
                source: 'task_closeout'
              });
              await saveTaskFixToTroubleshootingLibrary(payload);
              await logAudit({
                action: 'create',
                actionType: 'ai_fix_saved_to_library',
                category: 'operations_tasks',
                entityType: 'tasks',
                entityId: taskId,
                targetType: 'task',
                targetId: taskId,
                targetLabel: task.title || taskId,
                summary: `AI fix saved to library from task ${task.title || taskId}`,
                user: state.user,
                metadata: { source: 'task_closeout', taskId }
              });
            }
            state.operationsUi = {
              ...(state.operationsUi || {}),
              lastSaveFeedback: `Task ${taskId} closed successfully. ${saveToLibrary ? 'Fix saved to library settings path.' : 'Closeout recorded.'}`,
              lastSaveTone: 'success',
              expandedTaskIds: [...new Set([...(state.operationsUi?.expandedTaskIds || []), taskId])]
            };
            await refreshData();
            render();
          });
        }),
        deleteTask: async (id) => {
          if (!canDelete(state.permissions)) return;
          await deleteEntity('tasks', id, state.user);
          await refreshData();
          render();
        },
        runAi: async (taskId) => safeWithGlobalBusy('Running AI troubleshooting…', 'This can take a few seconds. Please do not refresh.', async () => {
          await withTaskPendingAction(taskId, 'run_ai', 'AI running…', async () => {
            setTaskAiUiState(taskId, { status: 'running', message: 'AI run started for this task.' });
          const task = state.tasks.find((entry) => entry.id === taskId);
          if (task) {
            await upsertEntity('tasks', taskId, {
              ...task,
              timeline: [...(task.timeline || []), {
                at: new Date().toISOString(),
                type: 'ai_run',
                note: 'AI troubleshooting run started.',
                by: state.user?.email || state.user?.uid || 'unknown'
              }],
              updatedAtClient: new Date().toISOString()
            }, state.user);
          }
          render();
          let result = null;
          try {
            result = await analyzeTaskTroubleshooting(taskId);
          } catch (error) {
            setTaskAiUiState(taskId, getTaskAiFailureState(error, 'run AI'));
            render();
            reportActionError('run_ai', error, 'Unable to run task AI.');
            return;
          }
          await handleAiRunLifecycle({ taskId, result, statusPrefix: 'AI run' });
          });
        }),
        rerunAi: async (taskId) => safeWithGlobalBusy('Rerunning AI troubleshooting…', 'This can take a few seconds. Please do not refresh.', async () => {
          await withTaskPendingAction(taskId, 'rerun_ai', 'Rerunning…', async () => {
          setTaskAiUiState(taskId, { status: 'running', message: 'AI rerun started for this task.' });
          render();
          let result = null;
          try {
            result = await regenerateTaskTroubleshooting(taskId);
          } catch (error) {
            setTaskAiUiState(taskId, getTaskAiFailureState(error, 'rerun AI'));
            render();
            reportActionError('rerun_ai', error, 'Unable to rerun task AI.');
            return;
          }
          await handleAiRunLifecycle({ taskId, result, statusPrefix: 'AI rerun' });
          });
        }),
        submitFollowup: async (taskId, runId, answers) => safeWithGlobalBusy('Submitting follow-up answers…', 'This can take a few seconds. Please do not refresh.', async () => {
          await withTaskPendingAction(taskId, 'submit_followup', 'Saving…', async () => {
          setTaskAiUiState(taskId, { status: 'running', message: 'Submitting follow-up answers…' });
          let result = null;
          try {
            result = await answerTaskFollowup(taskId, runId, answers);
            const task = state.tasks.find((entry) => entry.id === taskId);
            if (task) {
              await upsertEntity('tasks', taskId, {
                ...task,
                timeline: [...(task.timeline || []), {
                  at: new Date().toISOString(),
                  type: 'followup',
                  note: 'AI follow-up answers submitted.',
                  by: state.user?.email || state.user?.uid || 'unknown'
                }],
                updatedAtClient: new Date().toISOString()
              }, state.user);
            }
            setTaskAiUiState(taskId, { status: 'queued', message: 'Follow-up submitted. AI is continuing…' });
          } catch (error) {
            setTaskAiUiState(taskId, getTaskAiFailureState(error, 'submit AI follow-up answers'));
            render();
            reportActionError('submit_followup', error, 'Unable to submit AI follow-up answers.');
            return;
          }
          await handleAiRunLifecycle({ taskId, result, statusPrefix: 'AI follow-up run' });
          });
        }),
        saveFix: async (taskId) => {
          const successfulFix = prompt('Summarize the successful fix for the troubleshooting library:');
          if (!successfulFix) return;
          const task = state.tasks.find((entry) => entry.id === taskId);
          const asset = state.assets.find((entry) => entry.id === task?.assetId) || null;
          await withTaskPendingAction(taskId, 'save_fix', 'Saving fix…', async () => saveTaskFixToTroubleshootingLibrary(buildTroubleshootingLibraryPayload(task || { id: taskId }, asset, {
            successfulFix,
            resolutionSummary: successfulFix,
            source: 'manual_save_fix'
          })));
          await logAudit({
            action: 'create',
            actionType: 'ai_fix_saved_to_library',
            category: 'operations_tasks',
            entityType: 'tasks',
            entityId: taskId,
            targetType: 'task',
            targetId: taskId,
            targetLabel: task?.title || taskId,
            summary: `AI fix saved to library from task ${task?.title || taskId}`,
            user: state.user,
            metadata: { source: 'manual_save_fix', fixLength: `${successfulFix}`.length }
          });
          if (task) {
            await upsertEntity('tasks', taskId, {
              ...task,
              timeline: [...(task.timeline || []), {
                at: new Date().toISOString(),
                type: 'library',
                note: 'Fix saved to troubleshooting library.',
                detail: successfulFix,
                by: state.user?.email || state.user?.uid || 'unknown'
              }],
              updatedAtClient: new Date().toISOString()
            }, state.user);
          }
          state.operationsUi = {
            ...(state.operationsUi || {}),
            lastSaveFeedback: `Saved task ${taskId} fix to troubleshooting library.`,
            lastSaveTone: 'success'
          };
          await refreshData();
          render();
        },
        setAiFixState: async (taskId, aiFixState) => {
          const task = state.tasks.find((entry) => entry.id === taskId);
          if (!task) return;
          const nextFixState = ['pending_review', 'approved', 'rejected'].includes(`${aiFixState || ''}`.trim()) ? aiFixState : 'pending_review';
          await withTaskPendingAction(taskId, 'set_fix_state', 'Updating review…', async () => upsertEntity('tasks', taskId, {
            ...task,
            aiFixState: nextFixState,
            aiUpdatedAt: new Date().toISOString()
          }, state.user));
          await refreshData();
          render();
        },
        openAiSettings: () => {
          navigationController.openAdminTools();
          render();
        },
        signOffChecklistItemWithPin: async (payload = {}) => runAction('signoff_checklist_pin', async () => {
          await signOffChecklistItemWithPin(payload);
          await refreshData();
          render();
          return true;
        }, {
          fallbackMessage: 'Unable to sign off. Check the worker, PIN, and location.'
        }),
        createTaskFromTemplate: async ({ templateId, scheduledForDate } = {}) => {
          const template = (state.checklistTemplates || []).find((entry) => entry.id === templateId && entry.active !== false);
          if (!template) return false;
          if (!template.locationId || !template.locationName) {
            state.operationsUi = { ...(state.operationsUi || {}), createTaskError: 'Template must have a location before creating daily checklist tasks.', createTaskMessage: '' };
            render();
            return false;
          }
          const dateKey = `${scheduledForDate || new Date().toISOString().slice(0, 10)}`.trim();
          const duplicate = (state.tasks || []).find((task) => task.companyId === template.companyId
            && task.locationId === template.locationId
            && task.taskType === template.templateType
            && `${task.scheduledForDate || ''}` === dateKey
            && `${task.sourceTemplateId || ''}` === template.id);
          if (duplicate) {
            state.operationsUi = { ...(state.operationsUi || {}), createTaskError: 'A checklist from this template already exists for that date.', createTaskMessage: '' };
            render();
            return false;
          }
          const payload = {
            id: `daily-${template.templateType}-${template.locationId}-${dateKey}`.replace(/[^a-z0-9_-]/gi, '-'),
            companyId: template.companyId,
            locationId: template.locationId,
            locationName: template.locationName,
            location: template.locationName,
            taskType: template.templateType,
            title: `${template.name || 'Checklist'} (${dateKey})`,
            description: `Generated from template: ${template.name || template.templateType}`,
            status: 'open',
            severity: state.settings?.defaultTaskSeverity || 'medium',
            scheduledForDate: dateKey,
            sourceTemplateId: template.id,
            sourceTemplateName: template.name || '',
            checklistItems: (Array.isArray(template.checklistItems) ? template.checklistItems : []).map((item, index) => ({ id: item.id || `item-${index + 1}`, label: item.label || `Item ${index + 1}`, completed: false, completedAt: null, completedBy: null, workerId: null }))
          };
          await upsertEntity('tasks', payload.id, withRequiredCompanyId(state, payload, 'create a checklist from template'), state.user);
          state.operationsUi = { ...(state.operationsUi || {}), createTaskError: '', createTaskMessage: 'Checklist created. Continue sign-off from the Dashboard.', lastSavedTaskId: payload.id };
          await refreshData();
          render();
          navigationController.openTab('dashboard', null, null);
          return true;
        },
        saveChecklistAsTemplate: async ({ taskId } = {}) => {
          const task = (state.tasks || []).find((entry) => entry.id === taskId);
          if (!task) return false;
          if (!task.locationId) {
            state.operationsUi = { ...(state.operationsUi || {}), createTaskError: 'Set a location before saving this checklist as a template.', createTaskMessage: '' };
            render();
            return false;
          }
          const templateType = ['opening_checklist', 'closing_checklist', 'upkeep_checklist'].includes(task.taskType) ? task.taskType : '';
          if (!templateType) {
            state.operationsUi = { ...(state.operationsUi || {}), createTaskError: 'Only opening, closing, or upkeep checklists can be saved as templates right now.', createTaskMessage: '' };
            render();
            return false;
          }
          const location = (state.companyLocations || []).find((entry) => entry.id === task.locationId);
          const locationName = location?.name || task.locationName || task.locationId;
          const label = templateType === 'opening_checklist' ? 'Opening Checklist' : (templateType === 'closing_checklist' ? 'Closing Checklist' : 'Upkeep Checklist');
          const name = `${task.title || `${label} - ${locationName}`}`.trim();
          const checklistItems = (Array.isArray(task.checklistItems) ? task.checklistItems : [])
            .map((item, index) => ({ id: item?.id || `item-${index + 1}`, label: `${item?.label || item?.title || ''}`.trim(), sortOrder: index + 1 }))
            .filter((item) => item.label);
          if (!checklistItems.length) return false;
          const existing = (state.checklistTemplates || []).find((entry) => entry.companyId === state.company.id && entry.locationId === task.locationId && entry.templateType === templateType && `${entry.name || ''}`.trim().toLowerCase() === name.toLowerCase());
          const templateId = existing?.id || `template-${templateType}-${task.locationId}-${name.toLowerCase()}`.replace(/[^a-z0-9_-]/gi, '-');
          await upsertEntity('checklistTemplates', templateId, withRequiredCompanyId(state, {
            ...(existing || {}),
            id: templateId,
            companyId: state.company.id,
            locationId: task.locationId,
            locationName,
            templateType,
            name,
            active: true,
            checklistItems
          }, 'save checklist template'), state.user);
          state.operationsUi = { ...(state.operationsUi || {}), createTaskError: '', createTaskMessage: 'Checklist template saved.' };
          await refreshData();
          render();
          return true;
        }
      });
    }
  };
}
