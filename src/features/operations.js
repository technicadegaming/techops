import {
  canDelete,
  canCreateTasks,
  canEditTasks,
  canRunAiTroubleshooting,
  canAnswerAiFollowups,
  canSaveFixToLibrary,
  canCloseTasks,
  canChangeAISettings
} from '../roles.js';
import {
  normalizeTaskIntake,
  validateTaskIntake,
  generateTaskId,
  getCurrentOpenedDateTimeValue,
  buildAssetKey
} from './workflow.js';
import {
  buildLocationOptions,
  buildLocationSummary,
  getAssetLocationRecord,
  getLocationScopeLabel,
  getTaskLocationRecord
} from './locationContext.js';

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };
const PRIORITY_LABEL = { critical: 'P1 critical', high: 'P2 high', medium: 'P3 medium', low: 'P4 low' };
const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', completed: 'Completed' };
const AI_STATUS_LABEL = {
  idle: 'AI idle',
  disabled_by_settings: 'AI disabled',
  missing_company_context: 'AI missing context',
  queued: 'AI queued',
  running: 'AI running',
  followup_required: 'AI follow-up needed',
  permission_blocked: 'AI permission blocked',
  failed: 'AI failed',
  completed: 'AI completed',
  waiting_for_refresh: 'AI waiting for refresh'
};

const AI_FIX_STATE_LABEL = {
  pending_review: 'Pending review',
  approved: 'Approved fix',
  rejected: 'Rejected / not useful'
};

const MAX_EVIDENCE_IMAGE_BYTES = 8 * 1024 * 1024;

function getAiStatusLabel(status = 'idle') {
  return AI_STATUS_LABEL[status] || `AI ${`${status || 'idle'}`.replaceAll('_', ' ')}`;
}

function parseReferenceList(value = '') {
  return `${value || ''}`
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitChecklist(value = '') {
  return `${value || ''}`
    .split(/\r?\n|[;|]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildAttachments(input = {}) {
  return {
    images: parseReferenceList(input.imageRefs || input.images || ''),
    videos: parseReferenceList(input.videoRefs || input.videos || ''),
    evidence: parseReferenceList(input.evidenceRefs || input.evidence || '')
  };
}

function attachmentCount(attachments = {}) {
  return ['images', 'videos', 'evidence'].reduce((sum, key) => sum + ((attachments[key] || []).length), 0);
}

function renderReferenceGroup(label, values = []) {
  if (!values.length) return '';
  return `<div class="attachment-group"><b>${label}</b><div class="attachment-list">${values.map((value) => `<span class="state-chip muted">${value}</span>`).join('')}</div></div>`;
}

function renderAttachments(attachments = {}, emptyLabel = 'No references recorded yet.') {
  const total = attachmentCount(attachments);
  if (!total) return emptyLabel ? `<div class="inline-state info mt">${emptyLabel}</div>` : '';
  return `<div class="attachment-block mt">
    ${renderReferenceGroup('Images', attachments.images || [])}
    ${renderReferenceGroup('Videos', attachments.videos || [])}
    ${renderReferenceGroup('Evidence', attachments.evidence || [])}
  </div>`;
}


function formatFileSize(sizeBytes = 0) {
  const size = Number(sizeBytes || 0);
  if (!size) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function renderUploadedEvidence(task = {}, state = {}, editable = false) {
  const files = Array.isArray(task.uploadedEvidence) ? task.uploadedEvidence : [];
  const uiState = state.operationsUi?.evidenceUploadsByTask?.[task.id] || {};
  return `<div class="mt evidence-upload-panel">
    <b>Uploaded evidence files</b>
    <div class="tiny">Image uploads only for now. Other file types can be added later.</div>
    ${editable ? `<div class="row mt"><input type="file" accept="image/*" data-task-evidence-file="${task.id}" /><button type="button" data-upload-task-evidence="${task.id}" ${uiState.uploading ? 'disabled' : ''}>${uiState.uploading ? 'Uploading…' : 'Upload image'}</button></div>` : ''}
    ${uiState.message ? `<div class="inline-state ${uiState.tone || 'info'} mt">${uiState.message}</div>` : ''}
    ${files.length ? `<div class="attachment-block mt">${files.map((entry) => `<div class="attachment-group"><div class="row space"><span class="state-chip muted">${entry.filename || entry.storagePath || 'file'}</span>${editable ? `<button type="button" class="danger" data-remove-task-evidence="${task.id}" data-evidence-id="${entry.id}">Remove</button>` : ''}</div><div class="tiny mt">${entry.contentType || 'unknown type'} • ${formatFileSize(entry.sizeBytes)} • uploaded ${formatDateTime(entry.uploadedAt)} by ${entry.uploadedBy || 'unknown'}</div>${entry.downloadURL ? `<div class="tiny mt"><a href="${entry.downloadURL}" target="_blank" rel="noopener">Open file</a></div>` : ''}</div>`).join('')}</div>` : '<div class="inline-state info mt">No uploaded evidence files yet.</div>'}
  </div>`;
}

function formatTimelineType(type = '') {
  return ({
    intake: 'Intake',
    assignment: 'Assignment',
    start_work: 'Work started',
    ai_run: 'AI run',
    ai_result: 'AI result',
    followup: 'Follow-up',
    library: 'Saved fix',
    update: 'Update',
    closeout: 'Closeout',
    task_closeout: 'Closeout'
  })[type] || 'Entry';
}

function getTimelineTone(type = '') {
  if (['closeout', 'task_closeout'].includes(type)) return 'good';
  if (['ai_run', 'ai_result', 'followup'].includes(type)) return 'info';
  if (['assignment', 'start_work', 'library'].includes(type)) return 'warn';
  return 'muted';
}

function normalizeTimeline(task = {}) {
  const recorded = Array.isArray(task.timeline) ? task.timeline : [];
  const seed = recorded.length ? [] : [{
    at: task.openedAt || task.createdAtClient || task.updatedAt || task.updatedAtClient || '',
    type: 'intake',
    note: task.notes || 'Task created',
    detail: task.description || '',
    by: task.reportedByEmail || task.reporter || ''
  }];
  const merged = [...seed, ...recorded]
    .filter((entry) => entry && (entry.note || entry.detail || entry.at))
    .sort((a, b) => `${b.at || ''}`.localeCompare(`${a.at || ''}`));
  const seen = new Set();
  return merged.filter((entry) => {
    const key = `${entry.at || ''}|${entry.type || ''}|${entry.note || ''}|${entry.detail || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderTimeline(task) {
  const entries = normalizeTimeline(task);
  if (!entries.length) return `<div class="inline-state info mt">No service history yet.</div>`;
  return `<div class="timeline-list mt">${entries.map((entry) => `<div class="timeline-entry">
      <div class="row space">
        <span class="state-chip ${getTimelineTone(entry.type)}">${formatTimelineType(entry.type)}</span>
        <span class="tiny">${formatDateTime(entry.at)}</span>
      </div>
      ${entry.note ? `<div class="timeline-note mt">${entry.note}</div>` : ''}
      ${entry.detail ? `<div class="tiny mt">${entry.detail}</div>` : ''}
      ${entry.by ? `<div class="tiny mt">Technician: ${entry.by}</div>` : ''}
      ${attachmentCount(entry.attachments || {}) ? renderAttachments(entry.attachments || {}, '') : ''}
    </div>`).join('')}</div>`;
}

function renderPostSaveActions(state) {
  const taskId = `${state.operationsUi?.lastSavedTaskId || ''}`.trim();
  if (!taskId) return '';
  return `<div class="item mt post-save-guide">
    <div class="row space">
      <b>Next steps for ${taskId}</b>
      <button type="button" data-jump-task="${taskId}">Open task card</button>
    </div>
    <div class="tiny mt">Suggested order: save task → run AI guidance (assignment optional while open) → assign/start work → update timeline → resolve/close → save fix to library.</div>
  </div>`;
}

function getWorkerOptionLabel(worker = {}) {
  const name = `${worker.displayName || worker.fullName || worker.email || worker.id || ''}`.trim();
  const email = `${worker.email || ''}`.trim();
  return email && email !== name ? `${name} (${email})` : (name || worker.id || 'Unknown worker');
}

function resolveAssignmentLabel(identifier, state) {
  const clean = `${identifier || ''}`.trim();
  if (!clean) return '';
  const worker = (state.workers || []).find((entry) => entry.id === clean || `${entry.email || ''}`.trim().toLowerCase() === clean.toLowerCase());
  if (worker) return getWorkerOptionLabel(worker);
  const user = (state.users || []).find((entry) => entry.id === clean || `${entry.email || ''}`.trim().toLowerCase() === clean.toLowerCase());
  if (user) return user.memberLabel || user.displayName || user.fullName || user.email || clean;
  return clean;
}

function resolveReporterLabel(task, state) {
  const byUserId = `${task.reportedByUserId || ''}`.trim();
  const byEmail = `${task.reportedByEmail || ''}`.trim().toLowerCase();
  const user = (state.users || []).find((entry) => entry.id === byUserId || (`${entry.email || ''}`.trim().toLowerCase() && `${entry.email || ''}`.trim().toLowerCase() === byEmail));
  if (user) return user.memberLabel || user.displayName || user.fullName || user.email;
  return task.reporter || task.reportedByEmail || 'Unknown reporter';
}

function renderMissingAssetPrompt(assetName = '') {
  const clean = `${assetName || ''}`.trim();
  if (!clean) return '';
  return `No existing asset matches "${clean}". Create the asset first, then save the task. <button type="button" data-create-missing-asset="${clean}">Create asset</button>`;
}


function getRunSortKey(run = {}) {
  return `${run.updatedAt || run.createdAt || run.startedAt || ''}`;
}

function isRunSuperseded(run = {}) {
  const status = `${run.status || ''}`.trim();
  const followupStatus = `${run.followupStatus || ''}`.trim();
  return status === 'superseded' || followupStatus === 'superseded' || !!`${run.continuedByRunId || ''}`.trim();
}

function hasRunBeenAnswered(run = {}) {
  const followupStatus = `${run.followupStatus || ''}`.trim();
  return followupStatus === 'answered' || !!run.followupAnsweredAt;
}

function isActiveFollowupRun(run = {}) {
  return `${run.status || ''}`.trim() === 'followup_required' && !hasRunBeenAnswered(run) && !isRunSuperseded(run);
}

function hasAnsweredFollowup(followup = {}) {
  if (!followup) return false;
  const status = `${followup.status || ''}`.trim();
  const answers = Array.isArray(followup.answers) ? followup.answers : [];
  return status === 'answered' || answers.some((entry) => `${entry?.answer || ''}`.trim());
}

function getTaskRun(task, state) {
  const taskId = `${task?.id || ''}`.trim();
  const taskCompanyId = `${task?.companyId || ''}`.trim();
  const currentAiRunId = `${task?.currentAiRunId || ''}`.trim();
  const matchingRuns = (state.taskAiRuns || [])
    .filter((entry) => `${entry.taskId || ''}`.trim() === taskId)
    .filter((entry) => {
      if (!taskCompanyId) return true;
      return `${entry.companyId || ''}`.trim() === taskCompanyId;
    })
    .sort((a, b) => getRunSortKey(b).localeCompare(getRunSortKey(a)));

  const displayRun = state.operationsUi?.aiDisplayRunsByTask?.[taskId] || null;
  const displayTaskId = `${displayRun?.taskId || ''}`.trim();
  const displayCompanyId = `${displayRun?.companyId || ''}`.trim();
  const validDisplayRun = displayRun && displayTaskId === taskId && (!taskCompanyId || !displayCompanyId || displayCompanyId === taskCompanyId)
    ? displayRun
    : null;

  if (currentAiRunId) {
    const currentRun = matchingRuns.find((entry) => `${entry.id || ''}`.trim() === currentAiRunId);
    if (currentRun) return currentRun;
    if (validDisplayRun && `${validDisplayRun.id || ''}`.trim() === currentAiRunId) return validDisplayRun;
  }

  const newestNonSuperseded = matchingRuns.find((entry) => !isRunSuperseded(entry));
  if (newestNonSuperseded) return newestNonSuperseded;

  if (validDisplayRun && !isRunSuperseded(validDisplayRun)) return validDisplayRun;

  const fallbackRun = matchingRuns[0] || null;
  if (fallbackRun && isActiveFollowupRun(fallbackRun)) return fallbackRun;
  return fallbackRun || validDisplayRun || null;
}

function getTaskAiSnapshot(task, run = null) {
  const taskId = `${task?.id || ''}`.trim();
  const taskCompanyId = `${task?.companyId || ''}`.trim();
  const snapshot = task?.aiLastCompletedRunSnapshot || null;
  const snapshotRunId = `${snapshot?.runId || task?.currentAiRunId || ''}`.trim();
  const snapshotTaskId = `${snapshot?.taskId || taskId}`.trim();
  const snapshotCompanyId = `${snapshot?.companyId || taskCompanyId || ''}`.trim();
  const runCompanyId = `${run?.companyId || ''}`.trim();
  if (!snapshotRunId || !snapshot) return null;
  if (snapshotTaskId && snapshotTaskId !== taskId) return null;
  if (taskCompanyId && snapshotCompanyId && snapshotCompanyId !== taskCompanyId) return null;
  if (run?.id && run.id !== snapshotRunId) return null;
  if (taskCompanyId && runCompanyId && runCompanyId !== taskCompanyId) return null;
  return {
    runId: snapshotRunId,
    taskId,
    companyId: taskCompanyId || snapshotCompanyId || null,
    summary: `${snapshot.summary || ''}`.trim(),
    frontline: `${task.aiFrontlineSummary || snapshot.frontline || ''}`.trim(),
    nextSteps: Array.isArray(task.aiNextSteps) ? task.aiNextSteps : (Array.isArray(snapshot.nextSteps) ? snapshot.nextSteps : []),
    followupQuestions: Array.isArray(task.aiFollowupQuestions) ? task.aiFollowupQuestions : (Array.isArray(snapshot.followupQuestions) ? snapshot.followupQuestions : []),
    probableCauses: Array.isArray(snapshot.probableCauses) ? snapshot.probableCauses : [],
    documentationMode: `${snapshot.documentationMode || ''}`.trim() || '',
    documentationSources: Array.isArray(snapshot.documentationSources) ? snapshot.documentationSources : [],
    manualChunkCount: Number(snapshot.manualChunkCount || 0) || 0,
    documentationTextAvailable: snapshot.documentationTextAvailable === true,
    confidence: Number(snapshot.confidence),
    updatedAt: task.aiUpdatedAt || snapshot.completedAt || '',
    status: `${task.aiStatus || 'completed'}`.trim() || 'completed',
    fixState: `${task.aiFixState || 'pending_review'}`.trim() || 'pending_review'
  };
}

function getTaskFollowup(runId, state, run = null, task = null) {
  if (!runId) return null;
  const followup = (state.taskAiFollowups || []).find((entry) => entry.runId === runId) || null;
  const answered = hasAnsweredFollowup(followup) || hasRunBeenAnswered(run || {});
  const taskCurrentRunId = `${task?.currentAiRunId || ''}`.trim();
  const taskStatus = `${task?.aiStatus || ''}`.trim();
  if (answered || isRunSuperseded(run || {})) return null;
  if (taskCurrentRunId && taskCurrentRunId !== `${runId}`.trim() && taskStatus === 'completed') return null;
  if (followup) return followup;
  const runQuestions = Array.isArray(run?.followupQuestions)
    ? run.followupQuestions
    : Array.isArray(run?.followup?.questions)
      ? run.followup.questions
      : [];
  if (!runQuestions.length) return null;
  return { runId, questions: runQuestions };
}

function getTaskAiLocalState(taskId, state) {
  return state.operationsUi?.aiTaskStates?.[taskId] || null;
}

function getTaskAiEligibility(task, state, run = null) {
  const taskCompanyId = `${task.companyId || ''}`.trim();
  const activeCompanyId = `${state.company?.id || state.activeMembership?.companyId || ''}`.trim();
  const hasTaskCompanyContext = !!taskCompanyId;
  const canRun = canRunAiTroubleshooting(state.permissions, state.settings || {});
  const canAnswer = canAnswerAiFollowups(state.permissions);
  const aiEnabled = !!state.settings?.aiEnabled;
  const manualRerunAllowed = !!state.settings?.aiAllowManualRerun;
  const autoRunExpected = aiEnabled && !run;

  let reason = '';
  if (!hasTaskCompanyContext) {
    reason = activeCompanyId
      ? `Task is missing company context. Active company is ${activeCompanyId}.`
      : 'Task is missing company context.';
  } else if (!aiEnabled) {
    reason = 'Company AI is disabled in settings.';
  } else if (!canRun) {
    reason = 'Manual AI run is restricted by role/settings for this company.';
  } else if (run && !manualRerunAllowed) {
    reason = 'Manual rerun is disabled in company AI settings.';
  }

  return {
    taskCompanyId,
    hasTaskCompanyContext,
    canRun,
    canAnswer,
    aiEnabled,
    manualRerunAllowed,
    autoRunExpected,
    reason
  };
}

function getTaskAiState(task, state, run, followup, snapshot = null) {
  const localState = getTaskAiLocalState(task.id, state);
  const eligibility = getTaskAiEligibility(task, state, run);
  if (run?.status === 'followup_required') {
    if (hasRunBeenAnswered(run) || hasAnsweredFollowup(followup)) {
      return {
        status: 'waiting_for_refresh',
        message: 'Follow-up submitted. AI is continuing…',
        source: 'run',
        details: run.error || '',
        eligibility
      };
    }
    return {
      status: 'followup_required',
      message: 'AI is waiting on follow-up answers before it can continue.',
      source: 'run',
      details: run.error || '',
      eligibility
    };
  }
  if (run?.status) {
    return {
      status: run.status,
      message: run.status === 'failed'
        ? (run.error || 'AI run failed.')
        : run.status === 'completed'
          ? 'AI troubleshooting completed.'
          : run.status === 'running'
            ? 'AI troubleshooting is currently running.'
            : 'AI troubleshooting is queued.',
      source: 'run',
      details: run.failureCode ? `failure code: ${run.failureCode}` : '',
      eligibility
    };
  }
  if (snapshot?.runId) {
    return {
      status: snapshot.status || 'completed',
      message: 'Using saved AI guidance on this task.',
      source: 'task_snapshot',
      details: snapshot.fixState ? `review: ${AI_FIX_STATE_LABEL[snapshot.fixState] || snapshot.fixState}` : '',
      eligibility
    };
  }
  if (localState?.status) {
    return {
      status: localState.status,
      message: localState.message || getAiStatusLabel(localState.status),
      source: 'ui',
      details: '',
      eligibility
    };
  }
  if (!eligibility.hasTaskCompanyContext) {
    return {
      status: 'missing_company_context',
      message: eligibility.reason,
      source: 'derived',
      details: '',
      eligibility
    };
  }
  if (!eligibility.aiEnabled) {
    return {
      status: 'disabled_by_settings',
      message: eligibility.reason,
      source: 'derived',
      details: '',
      eligibility
    };
  }
  if (!eligibility.canRun && !followup?.questions?.length) {
    return {
      status: 'permission_blocked',
      message: eligibility.reason,
      source: 'derived',
      details: '',
      eligibility
    };
  }
  return {
    status: 'idle',
    message: eligibility.autoRunExpected ? 'Task is open and saved; AI will run automatically if enabled.' : 'No AI run has been recorded yet.',
    source: 'derived',
    details: '',
    eligibility
  };
}

function renderAiSourceLine(run) {
  const sourceList = Array.isArray(run?.documentationSources) ? run.documentationSources : [];
  const mode = `${run?.documentationMode || ''}`.trim() || 'web_internal_only';
  const modeCopy = {
    approved_manual_internal: { label: 'Trusted manual-backed', tone: 'good', note: 'Trusted source: approved manual text' },
    manual_library_backed: { label: 'Shared manual-backed', tone: 'warn', note: 'Uses shared manual-library context. Verify asset/manual match before relying on it.' },
    troubleshooting_backed: { label: 'Saved-fix-backed', tone: 'info', note: 'Context includes prior troubleshooting-library fixes.' },
    code_hint_backed: { label: 'Saved code hint-backed', tone: 'good', note: 'Context includes saved internal error-code hints.' },
    manual_backed: { label: 'Manual/link-backed', tone: 'info', note: '' },
    approved_doc_backed: { label: 'Manual/link-backed', tone: 'info', note: '' },
    support_backed: { label: 'Support/web/internal only', tone: 'warn', note: '' },
    web_internal_only: { label: 'Support/web/internal only', tone: 'warn', note: '' }
  }[mode] || { label: mode.replaceAll('_', ' '), tone: 'muted', note: '' };
  const chunkCount = Number(run?.manualChunkCount || 0) || 0;
  const missingManualText = ['manual_backed', 'approved_doc_backed'].includes(mode)
    && !run?.documentationTextAvailable
    && chunkCount <= 0;
  const manualTextHint = missingManualText
    ? '<div class="inline-state warn mt">Manual is attached, but extracted manual text is not available yet. Re-extract manual text from the asset record.</div>'
    : '';
  if (!sourceList.length && !run?.citations?.length) return `<div class="tiny">Sources used: ${modeCopy.label}</div>${modeCopy.note ? `<div class="inline-state ${modeCopy.tone} mt">${modeCopy.note}</div>` : ''}${manualTextHint}`;
  const names = sourceList.slice(0, 3).map((source) => source.title || source.url).filter(Boolean);
  return `<div class="tiny">Sources used: ${modeCopy.label}${names.length ? ` | ${names.join(' | ')}` : ''}</div>${modeCopy.note ? `<div class="inline-state ${modeCopy.tone} mt">${modeCopy.note}</div>` : ''}${manualTextHint}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'not set';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatAgeLabel(hours) {
  if (!Number.isFinite(hours) || hours < 1) return 'opened <1h ago';
  if (hours < 24) return `opened ${Math.round(hours)}h ago`;
  const days = Math.floor(hours / 24);
  const remainder = Math.round(hours % 24);
  if (!remainder) return `opened ${days}d ago`;
  return `opened ${days}d ${remainder}h ago`;
}

function getOverdueThresholdHours(severity = 'medium') {
  if (severity === 'critical') return 4;
  if (severity === 'high') return 24;
  if (severity === 'low') return 168;
  return 72;
}

function getTaskStateMeta(task, state) {
  const status = task.status || 'open';
  const severity = task.severity || 'medium';
  const assignedWorkers = task.assignedWorkers || [];
  const run = getTaskRun(task, state);
  const followup = getTaskFollowup(run?.id, state, run, task);
  const snapshot = getTaskAiSnapshot(task, run);
  const aiState = getTaskAiState(task, state, run, followup, snapshot);
  const unavailable = assignedWorkers.filter((worker) => state.users.some((user) => (
    (user.id === worker || user.email === worker) && (user.enabled === false || user.available === false)
  )));
  const openedAt = new Date(task.openedAt || task.createdAtClient || task.updatedAt || task.updatedAtClient || 0);
  const ageHours = Number.isNaN(openedAt.getTime()) ? 0 : (Date.now() - openedAt.getTime()) / (1000 * 60 * 60);
  const overdueThresholdHours = getOverdueThresholdHours(severity);
  const needsFollowup = run?.status === 'followup_required';
  const awaitingAssignment = status !== 'completed' && assignedWorkers.length === 0;
  const overdue = status !== 'completed' && ageHours >= overdueThresholdHours;
  const blockedReasons = [];
  if (needsFollowup) blockedReasons.push('waiting on follow-up answers');
  if (unavailable.length) blockedReasons.push(`assigned unavailable: ${unavailable.join(', ')}`);
  if (status === 'in_progress' && awaitingAssignment) blockedReasons.push('in progress without an assigned worker');
  const blocked = blockedReasons.length > 0;
  const readyForCloseout = status === 'in_progress' && !needsFollowup && assignedWorkers.length > 0 && unavailable.length === 0;
  const closeout = task.closeout || {};
  const resolutionSummary = closeout.bestFixSummary || closeout.fixPerformed || '';
  return {
    status,
    severity,
    statusLabel: STATUS_LABEL[status] || status,
    priorityLabel: PRIORITY_LABEL[severity] || PRIORITY_LABEL.medium,
    assignedWorkers,
    run,
    followup,
    snapshot,
    aiState,
    needsFollowup,
    awaitingAssignment,
    unavailable,
    overdue,
    overdueThresholdHours,
    ageHours,
    ageLabel: formatAgeLabel(ageHours),
    blocked,
    blockedReasons,
    readyForCloseout,
    resolutionSummary,
    fullyResolved: closeout.fullyResolved === 'yes',
    closeout
  };
}

function getChipTone(kind, value) {
  if (kind === 'severity') {
    if (value === 'critical') return 'bad';
    if (value === 'high') return 'warn';
    return 'info';
  }
  if (kind === 'status') {
    if (value === 'completed') return 'good';
    if (value === 'in_progress') return 'info';
    return 'muted';
  }
  if (kind === 'flag') {
    if (value === 'blocked') return 'bad';
    if (value === 'overdue') return 'warn';
    if (value === 'followup') return 'warn';
    if (value === 'ready') return 'good';
  }
  if (kind === 'ai') {
    if (['failed', 'permission_blocked', 'missing_company_context'].includes(value)) return 'bad';
    if (['disabled_by_settings', 'followup_required', 'waiting_for_refresh'].includes(value)) return 'warn';
    if (value === 'completed') return 'good';
    if (['queued', 'running'].includes(value)) return 'info';
  }
  return 'muted';
}

function renderChip(label, tone = 'muted') {
  return `<span class="state-chip ${tone}">${label}</span>`;
}

function renderTaskStateChips(meta) {
  const chips = [
    renderChip(meta.statusLabel, getChipTone('status', meta.status)),
    renderChip(meta.priorityLabel, getChipTone('severity', meta.severity))
  ];
  if (meta.overdue) chips.push(renderChip('Overdue', getChipTone('flag', 'overdue')));
  if (meta.blocked) chips.push(renderChip('Blocked', getChipTone('flag', 'blocked')));
  if (meta.needsFollowup) chips.push(renderChip('Follow-up needed', getChipTone('flag', 'followup')));
  if (meta.readyForCloseout) chips.push(renderChip('Ready to close', getChipTone('flag', 'ready')));
  if (meta.awaitingAssignment) chips.push(renderChip('Unassigned', 'warn'));
  if (meta.aiState?.status && meta.aiState.status !== 'idle') {
    chips.push(renderChip(getAiStatusLabel(meta.aiState.status), getChipTone('ai', meta.aiState.status)));
  }
  return chips.join('');
}

function renderExceptionBanner(meta) {
  const notes = [];
  if (meta.overdue) notes.push(`Past ${meta.overdueThresholdHours}h target for ${meta.severity} priority.`);
  if (meta.blockedReasons.length) notes.push(meta.blockedReasons.join(' | '));
  if (meta.readyForCloseout) notes.push('Work is in progress with an active owner and no follow-up blocker.');
  if (!notes.length) return '';
  const tone = meta.blocked ? 'error' : (meta.overdue ? 'warn' : 'success');
  return `<div class="inline-state ${tone} mt">${notes.join(' ')}</div>`;
}

function renderAssetOpsContext(taskAsset, state, scope) {
  if (!taskAsset?.id) return '';
  const assetId = taskAsset.id;
  const manualCount = (state.manuals || []).filter((manual) => manual.assetId === assetId).length;
  const troubleshootingRows = (state.troubleshootingLibrary || []).filter((entry) => entry.assetId === assetId);
  const relatedTasks = (state.tasks || []).filter((entry) => entry.assetId === assetId);
  const completedTasks = relatedTasks.filter((entry) => entry.status === 'completed');
  const openPm = (state.pmSchedules || []).filter((entry) => entry.assetId === assetId && entry.status !== 'completed');
  const manualState = `${taskAsset.manualStatus || ''}`.trim() || (manualCount ? 'manual_attached' : 'no_public_manual');
  const latestFix = troubleshootingRows[0];
  const latestCompletedTask = completedTasks[0];
  return `<div class="item mt">
    <div class="row space">
      <b>Asset operations context</b>
      <a href="?tab=assets&assetId=${encodeURIComponent(assetId)}&location=${encodeURIComponent(scope.selection?.key || '')}">Open full asset record</a>
    </div>
    <div class="kpi-line mt">
      <span>manual status: ${manualState.replaceAll('_', ' ')}</span>
      <span>manual docs: ${manualCount}</span>
      <span>troubleshooting entries: ${troubleshootingRows.length}</span>
      <span>related tasks: ${relatedTasks.length}</span>
      <span>open PM: ${openPm.length}</span>
    </div>
    ${latestFix ? `<div class="tiny mt"><b>Latest saved fix:</b> ${latestFix.resolutionSummary || latestFix.successfulFix || latestFix.issueSummary || 'saved troubleshooting entry'}.</div>` : '<div class="tiny mt">No saved troubleshooting-library fix yet for this asset.</div>'}
    ${latestCompletedTask ? `<div class="tiny mt"><b>Latest completed task:</b> <a href="?tab=operations&taskId=${encodeURIComponent(latestCompletedTask.id)}&location=${encodeURIComponent(scope.selection?.key || '')}">${latestCompletedTask.title || latestCompletedTask.id}</a></div>` : '<div class="tiny mt">No completed task history yet for this asset.</div>'}
  </div>`;
}


function renderAiGuidance(aiState, eligibility, state) {
  if (aiState.status === 'missing_company_context') return 'Task is missing company context. Save again from this workspace to attach company scope.';
  if (aiState.status === 'disabled_by_settings') return canEditTasks(state.permissions) ? 'AI is disabled for this company. Go to Admin > AI settings to enable it.' : 'AI is disabled for this company.';
  if (aiState.status === 'permission_blocked') return 'Manual AI runs require Lead or higher.';
  if (aiState.status === 'followup_required') return 'Follow-up answers are required before AI can continue.';
  if (aiState.status === 'waiting_for_refresh') return 'AI run was accepted and is syncing into the task run list. Results should appear shortly.';
  if (aiState.status === 'idle') return 'Save the task first to trigger AI.';
  return '';
}

function renderAiPanel(task, state, meta) {
  const run = meta.run;
  const snapshot = meta.snapshot;
  const followup = meta.followup;
  const aiState = meta.aiState;
  const eligibility = aiState.eligibility;
  const hasSavedGuidance = !!snapshot?.runId;
  const aiReviewState = AI_FIX_STATE_LABEL[snapshot?.fixState] || AI_FIX_STATE_LABEL.pending_review;
  const summary = run?.shortFrontlineVersion || snapshot?.frontline || '';
  const nextSteps = run?.diagnosticSteps?.length ? run.diagnosticSteps : (snapshot?.nextSteps || []);
  const immediateChecks = splitChecklist(run?.immediateChecks || run?.frontlineChecklist || '');
  const fixes = Array.isArray(run?.possibleFixes) ? run.possibleFixes : splitChecklist(run?.possibleFixes || '');
  const tools = Array.isArray(run?.toolsAndParts) ? run.toolsAndParts : splitChecklist(run?.toolsAndParts || '');
  const safety = Array.isArray(run?.safetyNotes) ? run.safetyNotes : splitChecklist(run?.safetyNotes || '');
  const sources = Array.isArray(run?.sourcesUsed) ? run.sourcesUsed : (run?.sources?.length ? run.sources : []);
  const canShowRunNow = eligibility.hasTaskCompanyContext
    && eligibility.aiEnabled
    && eligibility.canRun
    && !run
    && !hasSavedGuidance
    && !['queued', 'running', 'waiting_for_refresh'].includes(aiState.status);
  const canShowRerun = eligibility.hasTaskCompanyContext && eligibility.aiEnabled && eligibility.canRun && (hasSavedGuidance || !!run) && eligibility.manualRerunAllowed;
  const pending = state.operationsUi?.pendingActionsByTask?.[task.id] || null;
  const isBusy = !!pending;
  const busyKey = `${pending?.action || ''}`;
  const busyLabel = `${pending?.label || ''}`;
  const rerunLabel = run?.status === 'failed' ? 'Retry AI' : 'Rerun AI';
  const statusTone = ({
    bad: 'error',
    warn: 'warn',
    good: 'success',
    info: 'info',
    muted: 'info'
  })[getChipTone('ai', aiState.status)] || 'info';
  const sourceLine = eligibility.taskCompanyId
    ? `Company scope: ${eligibility.taskCompanyId}`
    : 'Company scope missing on this task';
  const actionHint = eligibility.aiEnabled && !run
    ? 'New tasks auto-run AI after save when company AI is enabled.'
    : (run && !eligibility.manualRerunAllowed ? 'Manual rerun is disabled for this company.' : '');
  const guidance = renderAiGuidance(aiState, eligibility, state);
  return `<div class="item mt">
    <div class="row space">
      <b>AI Troubleshooting</b>
      <div class="state-chip-row">
        <span class="state-chip ${getChipTone('ai', aiState.status)}">${getAiStatusLabel(aiState.status)}</span>
        ${run?.confidence ? `<span class="state-chip ${Number(run.confidence) >= 0.8 ? 'good' : 'warn'}">Confidence ${Math.round(Number(run.confidence) * 100)}%</span>` : ''}
        ${hasSavedGuidance ? `<span class="state-chip ${snapshot?.fixState === 'approved' ? 'good' : (snapshot?.fixState === 'rejected' ? 'bad' : 'warn')}">${aiReviewState}</span>` : ''}
      </div>
    </div>
    <div class="inline-state ${statusTone} mt">${aiState.message}</div>
    <div class="tiny mt">${sourceLine}${aiState.source ? ` | source: ${aiState.source}` : ''}${aiState.details ? ` | ${aiState.details}` : ''}</div>
    ${actionHint ? `<div class="tiny mt">${actionHint}</div>` : ''}
    ${guidance ? `<div class="tiny mt">${guidance}</div>` : ''}
    ${task.aiSummary?.summary ? `<div class="tiny mt">${task.aiSummary.summary}</div>` : ''}
    ${run ? renderAiSourceLine(run) : (hasSavedGuidance ? `${renderAiSourceLine(snapshot)}<div class="tiny mt">Latest saved AI guidance (run ${snapshot.runId}) • ${formatDateTime(snapshot.updatedAt)}</div>` : (aiState.status === 'waiting_for_refresh' ? `<div class="tiny mt thinking">Waiting for AI run record… Refreshing results…</div>` : '<div class="tiny mt">No AI run yet for this task.</div>'))}
    ${(aiState.status === 'queued' || aiState.status === 'running') ? '<div class="tiny mt thinking">AI is thinking…</div>' : ''}
    ${isBusy ? `<div class="tiny mt">${busyLabel || 'Working…'}</div>` : ''}
    ${hasSavedGuidance ? `<div class="inline-state info mt">Saved guidance review state: <b>${aiReviewState}</b></div>` : ''}
    ${summary ? `<div class="mt"><b>Frontline summary</b><div class="tiny">${summary}</div></div>` : ''}
    ${immediateChecks.length ? `<div class="mt"><b>Immediate checks</b><ul class="tiny">${immediateChecks.map((entry) => `<li>${entry}</li>`).join('')}</ul></div>` : ''}
    ${nextSteps?.length ? `<div class="mt"><b>Diagnostic steps</b><ul class="tiny">${nextSteps.map((entry) => `<li>${entry}</li>`).join('')}</ul></div>` : ''}
    ${fixes.length ? `<div class="mt"><b>Possible fixes</b><ul class="tiny">${fixes.map((entry) => `<li>${entry}</li>`).join('')}</ul></div>` : ''}
    ${tools.length ? `<div class="mt"><b>Tools / parts</b><ul class="tiny">${tools.map((entry) => `<li>${entry}</li>`).join('')}</ul></div>` : ''}
    ${safety.length ? `<div class="mt"><b>Safety notes</b><ul class="tiny">${safety.map((entry) => `<li>${entry}</li>`).join('')}</ul></div>` : ''}
    ${sources.length ? `<div class="mt"><b>Sources used</b><ul class="tiny">${sources.map((entry) => `<li>${entry.title || entry.url || entry}</li>`).join('')}</ul></div>` : ''}
    ${followup?.questions?.length ? `<div class="inline-state warn mt">AI cannot advance until the follow-up answers below are submitted.</div>
      <form data-followup="${task.id}" data-run="${run.id}" class="grid mt followup-form">${followup.questions.map((question, index) => `<label class="tiny">${question}<input name="a${index}" placeholder="Answer" ${canAnswerAiFollowups(state.permissions) ? '' : 'disabled'} /></label>`).join('')}<button class="primary" ${canAnswerAiFollowups(state.permissions) ? '' : 'disabled'}>Submit follow-up answers</button></form>` : ''}
    ${!canAnswerAiFollowups(state.permissions) && followup?.questions?.length ? `<div class="tiny mt">Follow-up answers require staff or higher.</div>` : ''}
    ${!eligibility.canRun && aiState.status !== 'completed' ? `<div class="tiny mt">${eligibility.reason}</div>` : ''}
    <div class="action-row mt">
      ${canShowRunNow ? `<button data-run-ai="${task.id}" ${isBusy ? 'disabled' : ''}>${busyKey === 'run_ai' ? 'AI running…' : 'Run AI now'}</button>` : ''}
      ${canShowRerun ? `<button data-rerun-ai="${task.id}" ${isBusy || ['queued', 'running', 'waiting_for_refresh'].includes(aiState.status) ? 'disabled' : ''}>${busyKey === 'rerun_ai' ? 'Rerunning…' : rerunLabel}</button>` : ''}
      ${hasSavedGuidance ? `<button type="button" data-ai-fix-state="approved" data-task-ai-fix-state="${task.id}" ${isBusy ? 'disabled' : ''}>${busyKey === 'set_fix_state' ? 'Updating review…' : 'Mark approved'}</button>
      <button type="button" data-ai-fix-state="rejected" data-task-ai-fix-state="${task.id}" ${isBusy ? 'disabled' : ''}>${busyKey === 'set_fix_state' ? 'Updating review…' : 'Mark rejected'}</button>
      <button type="button" data-ai-fix-state="pending_review" data-task-ai-fix-state="${task.id}" ${isBusy ? 'disabled' : ''}>${busyKey === 'set_fix_state' ? 'Updating review…' : 'Set pending review'}</button>` : ''}
      ${aiState.status === 'disabled_by_settings' && canChangeAISettings(state.permissions) ? '<button type="button" data-open-ai-settings="1">Open AI settings</button>' : ''}
      <button data-save-fix="${task.id}" ${canSaveFixToLibrary(state.permissions, state.settings || {}) && !isBusy ? '' : 'disabled'}>${busyKey === 'save_fix' ? 'Saving fix…' : 'Save fix to library'}</button>
    </div>
  </div>`;
}

function renderCloseoutSummary(task, meta) {
  if (task.status !== 'completed') return '';
  const closeout = meta.closeout || {};
  return `<div class="item mt closeout-summary">
    <div class="row space">
      <b>Resolution summary</b>
      <div class="tiny">${meta.fullyResolved ? 'Fully resolved' : 'Partially resolved'}</div>
    </div>
    <div class="kpi-line mt">
      <span>Closed ${formatDateTime(closeout.completedAt)}</span>
      <span>${Number(closeout.timeSpentMinutes || 0) || 0} min spent</span>
      ${closeout.aiHelpfulness ? `<span>AI: ${closeout.aiHelpfulness.replaceAll('_', ' ')}</span>` : ''}
    </div>
    <div class="mt"><b>Fix:</b> ${meta.resolutionSummary || 'No concise closeout summary recorded.'}</div>
    <div class="tiny mt">Root cause: ${closeout.rootCause || 'not captured'} | Verification: ${closeout.verification || 'not captured'}</div>
  </div>`;
}

function renderCloseout(task, state) {
  if (task.status === 'completed' || !canCloseTasks(state.permissions)) return '';
  return `<details class="item mt" data-closeout-panel="${task.id}">
    <summary><b>Resolve and close task</b></summary>
    <div class="tiny mt">Capture what fixed it, what was used, and how it was verified before closeout.</div>
    <form data-closeout="${task.id}" class="grid grid-2 mt closeout-form">
      <label>What fixed it? <span class="tiny">Required</span><input name="fixPerformed" placeholder="Example: straightened guide and re-tested vend path" required /></label>
      <label>Root cause <span class="tiny">Required</span><input name="rootCause" placeholder="Example: ticket mech jammed by bent guide" required /></label>
      <label>Parts used <span class="tiny">Optional</span><input name="partsUsed" placeholder="Comma-separated" /></label>
      <label>Tools used <span class="tiny">Optional</span><input name="toolsUsed" placeholder="Comma-separated" /></label>
      <label>Time spent (minutes)<input name="timeSpentMinutes" type="number" min="0" placeholder="0" /></label>
      <label>Verification / tested outcome<input name="verification" placeholder="What did you test before closeout?" /></label>
      <label>Resolution status<select name="fullyResolved"><option value="yes">Fully resolved</option><option value="no">Partially resolved / monitor</option></select></label>
      <label>Save to library<select name="saveToLibrary"><option value="">Use default</option><option value="yes">Save to troubleshooting library</option><option value="no">Do not save</option></select></label>
      <label>AI helpfulness<select name="aiHelpfulness"><option value="">Optional</option><option value="helpful">AI was helpful</option><option value="partial">AI partially helpful</option><option value="not_helpful">AI not helpful</option></select></label>
      <label class="closeout-wide">Notes for future reference<input name="bestFixSummary" placeholder="One-line closeout summary for future reuse" /></label>
      <div class="closeout-wide evidence-group">
        <b>Evidence references (optional)</b>
        <div class="tiny">Reference photos, videos, and logs using URLs, filenames, or ticket IDs.</div>
        <label>Image references<textarea name="imageRefs" placeholder="Photo URLs, filenames, or shared-drive refs"></textarea></label>
        <label>Video references<textarea name="videoRefs" placeholder="Video URLs or file refs"></textarea></label>
        <label>Evidence references<textarea name="evidenceRefs" placeholder="Logs, tickets, measurements, or other evidence"></textarea></label>
      </div>
      <div class="closeout-actions closeout-wide">
        <button class="primary">Resolve and close task</button>
      </div>
    </form>
  </details>`;
}

function createDefaultOperationsUiState() {
  return {
    draft: {},
    moreDetailsOpen: false,
    expandedTaskIds: [],
    scrollY: 0,
    statusFilter: 'open',
    ownershipFilter: 'all',
    exceptionFilter: 'all',
    taskSearch: '',
    assigneeFilter: 'all',
    lastSaveFeedback: '',
    lastSaveTone: 'info',
    reassignSelections: {},
    aiTaskStates: {},
    aiDisplayRunsByTask: {},
    pendingActionsByTask: {},
    isSavingTask: false,
    lastSavedTaskId: null
  };
}

function normalizeQueryValue(value = '') {
  return `${value || ''}`.trim().toLowerCase();
}

function readFormDraft(form) {
  if (!form) return {};
  return Object.fromEntries(new FormData(form).entries());
}

function filterTasks(tasks, state, assetById = new Map()) {
  const statusFilter = state.operationsUi?.statusFilter || 'open';
  const ownershipFilter = state.operationsUi?.ownershipFilter || 'all';
  const exceptionFilter = state.operationsUi?.exceptionFilter || 'all';
  const taskSearch = normalizeQueryValue(state.operationsUi?.taskSearch || '');
  const assigneeFilter = normalizeQueryValue(state.operationsUi?.assigneeFilter || 'all');
  const myIdentifiers = new Set([state.user?.uid, state.user?.email].filter(Boolean));
  return (tasks || []).filter((task) => {
    const meta = getTaskStateMeta(task, state);
    const assigned = meta.assignedWorkers;
    const statusMatch = statusFilter === 'all'
      ? true
      : statusFilter === 'open'
        ? task.status !== 'completed'
        : task.status === statusFilter;
    const ownershipMatch = ownershipFilter === 'all'
      ? true
      : ownershipFilter === 'mine'
        ? assigned.some((worker) => myIdentifiers.has(worker))
        : ownershipFilter === 'unassigned'
          ? assigned.length === 0
          : ownershipFilter === 'followup'
            ? meta.needsFollowup
            : true;
    const exceptionMatch = exceptionFilter === 'all'
      ? true
      : exceptionFilter === 'priority'
        ? SEVERITY_ORDER[meta.severity] >= SEVERITY_ORDER.high
        : exceptionFilter === 'overdue'
          ? meta.overdue
          : exceptionFilter === 'blocked'
            ? meta.blocked
            : exceptionFilter === 'closeout'
              ? meta.readyForCloseout
              : true;
    const assigneeMatch = assigneeFilter === 'all'
      ? true
      : assigned.some((worker) => normalizeQueryValue(worker) === assigneeFilter);
    const linkedAsset = assetById.get(task.assetId) || null;
    const assignedLabels = assigned.map((worker) => resolveAssignmentLabel(worker, state));
    const searchBlob = [
      task.id,
      linkedAsset?.name,
      task.assetName,
      task.title,
      task.description,
      task.notes,
      task.reporter,
      task.reportedByEmail,
      ...assigned,
      ...assignedLabels
    ].map((entry) => normalizeQueryValue(entry)).join(' ');
    const searchMatch = !taskSearch || searchBlob.includes(taskSearch);
    return statusMatch && ownershipMatch && exceptionMatch && assigneeMatch && searchMatch;
  });
}

export const __testOperationsAi = {
  getTaskRun,
  getTaskFollowup,
  getTaskAiState,
  getTaskAiSnapshot,
  renderAiPanel
};

export function renderOperations(el, state, actions) {
  state.operationsUi = { ...createDefaultOperationsUiState(), ...(state.operationsUi || {}) };
  const editable = canEditTasks(state.permissions);
  const canCreate = canCreateTasks(state.permissions);
  const expanded = new Set(state.operationsUi.expandedTaskIds || []);
  const assetById = new Map((state.assets || []).map((asset) => [asset.id, asset]));
  const assetByName = new Map((state.assets || []).map((asset) => [`${asset.name || asset.id}`.toLowerCase(), asset]));
  const workerOptions = (state.workers || [])
    .filter((worker) => worker.enabled !== false)
    .sort((a, b) => getWorkerOptionLabel(a).localeCompare(getWorkerOptionLabel(b)));
  const locationOptions = buildLocationOptions(state);
  const scope = buildLocationSummary(state);
  const scopedTasks = [...scope.scopedTasks].sort((a, b) => {
    const metaDiff = SEVERITY_ORDER[(b.severity || 'medium')] - SEVERITY_ORDER[(a.severity || 'medium')];
    if (metaDiff) return metaDiff;
    return `${b.openedAt || b.updatedAt || ''}`.localeCompare(`${a.openedAt || a.updatedAt || ''}`);
  });
  const scopedAssets = scope.scopedAssets;
  const openTasks = scope.openTasks;
  const openMeta = openTasks.map((task) => ({ task, meta: getTaskStateMeta(task, state) }));
  const visibleTasks = filterTasks(scopedTasks, state, assetById);
  const taskWorkerOptions = workerOptions.filter((worker) => scopedTasks.some((task) => {
    const assigned = Array.isArray(task.assignedWorkers) ? task.assignedWorkers : [];
    return assigned.some((entry) => `${entry}`.trim() === `${worker.id || worker.email || ''}`.trim());
  }));
  const activeTaskFilterParts = [
    state.operationsUi.taskSearch ? `search: "${state.operationsUi.taskSearch}"` : '',
    state.operationsUi.assigneeFilter && state.operationsUi.assigneeFilter !== 'all' ? `assignee: ${resolveAssignmentLabel(state.operationsUi.assigneeFilter, state)}` : '',
    state.operationsUi.statusFilter !== 'open' ? `status: ${STATUS_LABEL[state.operationsUi.statusFilter] || state.operationsUi.statusFilter}` : '',
    state.operationsUi.ownershipFilter !== 'all' ? `ownership: ${state.operationsUi.ownershipFilter.replace('_', ' ')}` : '',
    state.operationsUi.exceptionFilter !== 'all' ? `exception: ${state.operationsUi.exceptionFilter.replace('_', ' ')}` : ''
  ].filter(Boolean);
  const unassignedOpen = openMeta.filter(({ meta }) => meta.awaitingAssignment).length;
  const followupOpen = openMeta.filter(({ meta }) => meta.needsFollowup).length;
  const inProgress = scopedTasks.filter((task) => task.status === 'in_progress').length;
  const highPriorityOpen = openMeta.filter(({ meta }) => SEVERITY_ORDER[meta.severity] >= SEVERITY_ORDER.high).length;
  const overdueOpen = openMeta.filter(({ meta }) => meta.overdue).length;
  const blockedOpen = openMeta.filter(({ meta }) => meta.blocked).length;
  const readyForCloseout = openMeta.filter(({ meta }) => meta.readyForCloseout).length;
  const operationsDraft = state.operationsUi?.draft || {};
  const typedAssetName = `${operationsDraft.assetSearch || ''}`.trim();
  const typedAssetMatch = typedAssetName ? (assetByName.get(typedAssetName.toLowerCase()) || assetById.get(typedAssetName) || null) : null;
  const missingAssetPrompt = typedAssetName && !typedAssetMatch;

  el.innerHTML = `
    <div class="page-shell">
    <header class="page-header">
      <div>
        <h2 class="page-title">Operations</h2>
        <p class="page-subtitle">Create tasks, troubleshoot issues, assign work, and keep service history organized. ${getLocationScopeLabel(scope.selection)}</p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn-primary" data-jump-intake>Create task</button>
        <button type="button" class="btn-secondary" data-status-filter="open">View open tasks</button>
        <button type="button" class="btn-secondary" data-ownership-filter="followup">View follow-ups</button>
      </div>
    </header>
    <div class="kpi-line">
      <span>Visible tasks: ${visibleTasks.length}</span>
      <span>Open work: ${openTasks.length}</span>
      <span>In progress: ${inProgress}</span>
    </div>

    <div class="stats-grid">
      <div class="stat-card ${openTasks.length ? 'warn' : 'good'}">
        <div class="tiny">Open work orders</div>
        <strong>${openTasks.length}</strong>
        <div class="tiny">${scope.brokenAssets.length} broken assets tied to open work.</div>
      </div>
      <div class="stat-card ${highPriorityOpen ? 'bad' : 'good'}">
        <div class="tiny">High-priority work</div>
        <strong>${highPriorityOpen}</strong>
        <div class="tiny">${highPriorityOpen ? 'Critical and high-severity tasks need a first touch fast.' : 'No high-priority backlog.'}</div>
      </div>
      <div class="stat-card ${overdueOpen ? 'warn' : 'good'}">
        <div class="tiny">Overdue tasks</div>
        <strong>${overdueOpen}</strong>
        <div class="tiny">${overdueOpen ? 'Past age targets for their current priority.' : 'No overdue tasks in scope.'}</div>
      </div>
      <div class="stat-card ${blockedOpen ? 'bad' : 'good'}">
        <div class="tiny">Blocked tasks</div>
        <strong>${blockedOpen}</strong>
        <div class="tiny">${blockedOpen ? 'Unavailable owners or pending follow-up are slowing execution.' : 'No blocked task states detected.'}</div>
      </div>
      <div class="stat-card ${unassignedOpen ? 'bad' : 'good'}">
        <div class="tiny">Unassigned open work</div>
        <strong>${unassignedOpen}</strong>
        <div class="tiny">${unassignedOpen ? 'Assign owners before this grows.' : 'Every open task has an owner.'}</div>
      </div>
      <div class="stat-card ${readyForCloseout ? 'warn' : 'good'}">
        <div class="tiny">Ready for closeout</div>
        <strong>${readyForCloseout}</strong>
        <div class="tiny">${readyForCloseout ? 'Active work appears ready for resolution capture.' : 'No active tasks are ready to close yet.'}</div>
      </div>
      <div class="stat-card ${followupOpen ? 'warn' : 'good'}">
        <div class="tiny">AI follow-up queue</div>
        <strong>${followupOpen}</strong>
        <div class="tiny">${followupOpen ? 'Frontline answers are blocking next-step guidance.' : 'No follow-up backlog.'}</div>
      </div>
    </div>

    <div class="item ops-toolbar">
      <div class="row space">
        <div>
          <b>Location and quick filters</b>
          <div class="tiny">Use this view to isolate open-work exceptions, owner gaps, and closeout-ready tasks.</div>
        </div>
        <label class="tiny ops-location-field">Location
          <select data-location-filter>
            ${locationOptions.map((option) => `<option value="${option.key}" ${option.key === scope.selection?.key ? 'selected' : ''}>${option.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="grid grid-2 mt">
        <label class="tiny">Task search
          <input type="search" data-task-search placeholder="Task ID, asset, issue description, assignee" value="${state.operationsUi.taskSearch || ''}" />
        </label>
        <label class="tiny">Assignee
          <select data-assignee-filter>
            <option value="all">All assignees</option>
            ${taskWorkerOptions.map((worker) => `<option value="${worker.id || worker.email || ''}" ${`${worker.id || worker.email || ''}` === `${state.operationsUi.assigneeFilter || 'all'}` ? 'selected' : ''}>${getWorkerOptionLabel(worker)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="tiny mt"><b>Status</b></div>
      <div class="filter-row">
        <button class="filter-chip ${state.operationsUi.statusFilter === 'open' ? 'active' : ''}" data-status-filter="open" type="button">Open work</button>
        <button class="filter-chip ${state.operationsUi.statusFilter === 'in_progress' ? 'active' : ''}" data-status-filter="in_progress" type="button">In progress</button>
        <button class="filter-chip ${state.operationsUi.statusFilter === 'completed' ? 'active' : ''}" data-status-filter="completed" type="button">Completed</button>
        <button class="filter-chip ${state.operationsUi.statusFilter === 'all' ? 'active' : ''}" data-status-filter="all" type="button">All statuses</button>
      </div>
      <div class="tiny mt"><b>Priority and ownership</b></div>
      <div class="filter-row">
        <button class="filter-chip ${state.operationsUi.ownershipFilter === 'all' ? 'active' : ''}" data-ownership-filter="all" type="button">All ownership</button>
        <button class="filter-chip ${state.operationsUi.ownershipFilter === 'mine' ? 'active' : ''}" data-ownership-filter="mine" type="button">My work</button>
        <button class="filter-chip ${state.operationsUi.ownershipFilter === 'unassigned' ? 'active' : ''}" data-ownership-filter="unassigned" type="button">Unassigned</button>
        <button class="filter-chip ${state.operationsUi.ownershipFilter === 'followup' ? 'active' : ''}" data-ownership-filter="followup" type="button">Needs follow-up</button>
      </div>
      <div class="tiny mt"><b>Exceptions</b></div>
      <div class="filter-row">
        <button class="filter-chip ${state.operationsUi.exceptionFilter === 'all' ? 'active' : ''}" data-exception-filter="all" type="button">All exceptions</button>
        <button class="filter-chip ${state.operationsUi.exceptionFilter === 'priority' ? 'active' : ''}" data-exception-filter="priority" type="button">High priority</button>
        <button class="filter-chip ${state.operationsUi.exceptionFilter === 'overdue' ? 'active' : ''}" data-exception-filter="overdue" type="button">Overdue</button>
        <button class="filter-chip ${state.operationsUi.exceptionFilter === 'blocked' ? 'active' : ''}" data-exception-filter="blocked" type="button">Blocked</button>
        <button class="filter-chip ${state.operationsUi.exceptionFilter === 'closeout' ? 'active' : ''}" data-exception-filter="closeout" type="button">Ready to close</button>
      </div>
      <div class="row space mt">
        <div class="tiny">Showing ${visibleTasks.length} of ${scopedTasks.length} tasks in this location scope.</div>
        <button type="button" class="btn-tertiary" data-clear-task-filters ${activeTaskFilterParts.length ? '' : 'disabled'}>Clear filters</button>
      </div>
      ${activeTaskFilterParts.length ? `<div class="tiny mt">Active filters: ${activeTaskFilterParts.join(' · ')}</div>` : '<div class="tiny mt">Active filters: default view (open work, all owners, all exceptions).</div>'}
    </div>

    ${state.operationsUi.lastSaveFeedback ? `<div class="inline-state ${state.operationsUi.lastSaveTone || 'info'}">${state.operationsUi.lastSaveFeedback}</div>` : ''}
    ${renderPostSaveActions(state)}
    ${!scopedAssets.length ? '<div class="inline-state warn">No assets exist in this location scope yet. Create or import an asset in Assets/Admin before opening Operations intake.</div>' : ''}

    <form id="taskForm" class="grid mt ops-intake-form">
      <div class="grid grid-2">
        <label>Task ID<input name="id" readonly /></label>
        <label>Opened date/time<input name="openedAt" type="datetime-local" readonly /></label>
      </div>
      <section class="item ops-intake-step">
        <h3>Step 1 · Asset / game <span class="tiny">Required</span></h3>
        <div class="tiny">Choose the affected asset in this location scope.</div>
        <label class="mt">Asset / game
        <input name="assetSearch" list="assetOptions" placeholder="${scopedAssets.length ? 'Search by asset name' : 'No assets in the current location yet'}" required ${canCreate ? '' : 'disabled'} />
        </label>
        <div id="missingAssetPrompt" class="inline-state error mt ${missingAssetPrompt ? '' : 'hide'}">${missingAssetPrompt ? renderMissingAssetPrompt(typedAssetName) : ''}</div>
      </section>

      <section class="item ops-intake-step">
        <h3>Step 2 · Problem description <span class="tiny">Required</span></h3>
        <div class="tiny">Describe what is wrong so the next technician can reproduce quickly.</div>
        <label class="mt">Issue details
          <textarea name="description" placeholder="Describe the issue / concern" required ${canCreate ? '' : 'disabled'}></textarea>
        </label>
        <label>Reported by <span class="tiny">Required</span><input name="reporter" placeholder="Reported by" required ${canCreate ? '' : 'disabled'} /></label>
      </section>

      <section class="item ops-intake-step">
        <h3>Step 3 · What has been tried</h3>
        <div class="tiny">Capture prior troubleshooting so work is not repeated. This is included directly in AI troubleshooting context.</div>
        <label class="mt">What did you already try / perform?
          <input name="alreadyTried" placeholder="What did you already try / perform?" ${canCreate ? '' : 'disabled'} />
        </label>
      </section>

      <details data-more-details ${state.operationsUi.moreDetailsOpen ? 'open' : ''} class="item ops-intake-step">
        <summary><b>Step 4 · Optional details</b> <span class="tiny">Expand for severity, assignment, timeline seed, and evidence refs.</span></summary>
        <div class="grid grid-2 mt">
          <input name="issueCategory" placeholder="Issue category" ${canCreate ? '' : 'disabled'} />
          <select name="severity" ${canCreate ? '' : 'disabled'}><option>critical</option><option>high</option><option selected>medium</option><option>low</option></select>
          <input name="symptomTags" placeholder="Symptoms / tags (comma-separated)" ${canCreate ? '' : 'disabled'} />
          <input name="symptomTagsExtra" placeholder="Additional symptom tags" ${canCreate ? '' : 'disabled'} />
          <input name="location" list="locationOptions" placeholder="Location / zone / area" ${canCreate ? '' : 'disabled'} />
          <input name="customerImpact" placeholder="Customer impact" ${canCreate ? '' : 'disabled'} />
          <input name="errorText" placeholder="Observed error text/code" ${canCreate ? '' : 'disabled'} />
          <select name="occurrence" ${canCreate ? '' : 'disabled'}><option value="constant">Constant</option><option value="intermittent">Intermittent</option></select>
          <select name="reproducible" ${canCreate ? '' : 'disabled'}><option value="yes">Reproducible</option><option value="no">Not reproducible</option><option value="unknown">Unknown</option></select>
          <input name="visibleCondition" placeholder="Visible condition notes" ${canCreate ? '' : 'disabled'} />
          <label>Assigned worker
            <div class="tiny">Open tasks can be saved unassigned. Assignment is required before moving to in progress.</div>
            <select name="assignedWorker" ${canCreate ? '' : 'disabled'}>
              <option value="">Assign later</option>
              ${workerOptions.map((worker) => `<option value="${worker.id || worker.email || ''}">${getWorkerOptionLabel(worker)}</option>`).join('')}
            </select>
          </label>
          <label>Status<div class="tiny">Open = intake allowed without assignment. In progress requires an assigned worker.</div><select name="status" ${canCreate ? '' : 'disabled'}><option>open</option><option>in_progress</option><option>completed</option></select></label>
          <div id="assignmentStatusHint" class="tiny"></div>
          <textarea name="notes" placeholder="Current summary / handoff notes" ${canCreate ? '' : 'disabled'}></textarea>
          <textarea name="timelineEntry" placeholder="First service timeline entry" ${canCreate ? '' : 'disabled'}></textarea>
          <div class="closeout-wide evidence-group">
            <b>Evidence references</b>
            <div class="tiny">Optional. Keep references concise: URL, filename, or ticket number per line.</div>
            <textarea name="imageRefs" placeholder="Image references: URLs, filenames, drive refs" ${canCreate ? '' : 'disabled'}></textarea>
            <textarea name="videoRefs" placeholder="Video references: URLs or filenames" ${canCreate ? '' : 'disabled'}></textarea>
            <textarea name="evidenceRefs" placeholder="Evidence refs: logs, measurements, ticket links" ${canCreate ? '' : 'disabled'}></textarea>
          </div>
        </div>
        <div class="tiny mt">Use timeline updates and reference fields to keep a service-history trail without requiring upload wiring.</div>
      </details>

      <section class="item ops-intake-step">
        <h3>Step 5 · Create task</h3>
        <div class="tiny">Save now, then use the task card actions to assign/start work, run AI, update timeline, and close out.</div>
        <button class="primary mt" ${canCreate && !state.operationsUi?.isSavingTask ? '' : 'disabled'}>${state.operationsUi?.isSavingTask ? 'Creating task…' : (state.settings?.aiEnabled ? 'Create task & run AI' : 'Create task')}</button>
        ${state.settings?.aiEnabled ? '' : '<div class="inline-state info mt">Operations AI is disabled in Admin settings. You can still create and manage tasks.</div>'}
      </section>
      <datalist id="assetOptions">${scopedAssets.map((asset) => `<option value="${asset.name || asset.id}"></option>`).join('')}</datalist>
      <datalist id="locationOptions">${locationOptions.filter((option) => option.name && !option.name.includes('Company-wide')).map((option) => `<option value="${option.name}"></option>`).join('')}</datalist>
    </form>

    <div class="row space mt">
      <h3>Workflow board</h3>
      <div class="tiny">Cards are sorted with higher-priority work first.</div>
    </div>
    ${visibleTasks.length
      ? `<div class="list mt task-board">
        ${visibleTasks.map((task) => {
          const taskAsset = assetById.get(task.assetId);
          const friendlyAsset = taskAsset?.name || task.assetName || task.assetId || '-';
          const taskLocation = getTaskLocationRecord(state, task, assetById);
          const assetLocation = taskAsset ? getAssetLocationRecord(state, taskAsset) : null;
          const showTaskDetails = expanded.has(task.id);
          const meta = getTaskStateMeta(task, state);
          return `<details class="item task-card ${state.route?.taskId === task.id ? 'selected' : ''}" id="task-${task.id}" data-task-details="${task.id}" ${showTaskDetails ? 'open' : ''}>
            <summary class="task-summary">
              <div class="task-summary-main">
                <div class="task-title-row">
                  <b>${task.title || task.id}</b>
                  <span class="tiny">${task.id}</span>
                </div>
                <div class="state-chip-row">${renderTaskStateChips(meta)}</div>
              </div>
              <div class="task-summary-meta">
                <span>${task.assetId ? `<a href="?tab=assets&assetId=${encodeURIComponent(task.assetId)}&location=${encodeURIComponent(scope.selection?.key || '')}">${friendlyAsset}</a>` : friendlyAsset}</span>
                <span>${taskLocation.label}</span>
                <span>Owner: ${meta.assignedWorkers.map((worker) => resolveAssignmentLabel(worker, state)).join(', ') || 'unassigned'}</span>
                <span>Reporter: ${resolveReporterLabel(task, state)}</span>
                <span>${meta.ageLabel}</span>
              </div>
            </summary>
            <div class="task-body">
              ${renderExceptionBanner(meta)}
              <div class="task-meta-grid mt">
                <div><b>Assigned worker</b><div class="tiny">${meta.assignedWorkers.map((worker) => resolveAssignmentLabel(worker, state)).join(', ') || 'unassigned'}</div></div>
                <div><b>Reported by</b><div class="tiny">${resolveReporterLabel(task, state)} | ${formatDateTime(task.openedAt || task.createdAtClient)}</div></div>
                <div><b>Asset location</b><div class="tiny">${assetLocation?.label || taskLocation.label}${assetLocation && assetLocation.label !== taskLocation.label ? ` | task reported at ${taskLocation.label}` : ''}</div></div>
                <div><b>Category</b><div class="tiny">${task.issueCategory || 'uncategorized'} | tags: ${(task.symptomTags || []).join(', ') || 'none'}</div></div>
              </div>
              <div class="mt"><b>Issue:</b> ${task.description || ''}</div>
              ${task.notes ? `<div class="mt"><b>Current summary:</b> ${task.notes}</div>` : ''}
              <div class="mt"><b>Asset link:</b> ${task.assetId ? `<a href="?tab=assets&assetId=${encodeURIComponent(task.assetId)}&location=${encodeURIComponent(scope.selection?.key || '')}">Open asset record</a>` : 'No linked asset'}</div>
              ${renderAssetOpsContext(taskAsset, state, scope)}
              <div class="mt"><b>Service timeline</b>${renderTimeline(task)}</div>
              <div class="mt"><b>Recorded references</b>${renderAttachments(task.attachments || {}, 'No image, video, or evidence references on this task yet.')}</div>
              ${renderUploadedEvidence(task, state, editable)}
              ${meta.unavailable.length ? `<div class="tiny mt">Unavailable assignees: ${meta.unavailable.join(', ')}</div>` : ''}
              <div class="task-actions mt">
                <div class="tiny"><b>Next actions</b></div>
                <div class="action-row task-primary-actions mt">
                ${editable && task.status === 'open' ? `<button type="button" data-quick-status="${task.id}" data-next-status="in_progress" class="primary" ${meta.assignedWorkers.length ? '' : 'disabled'}>Start now</button>` : ''}
                ${editable && task.status === 'in_progress' ? `<button type="button" data-quick-status="${task.id}" data-next-status="open">Move back to open</button>` : ''}
                ${task.status !== 'completed' && canCloseTasks(state.permissions) ? `<button type="button" data-open-closeout="${task.id}">Resolve / close</button>` : ''}
                ${meta.needsFollowup ? `<button type="button" data-open-followup="${task.id}">Answer follow-up</button>` : ''}
                </div>
                <div class="action-row mt">
                ${(meta.awaitingAssignment || meta.unavailable.length) ? `<button type="button" data-reassign="${task.id}">Quick reassign</button>` : ''}
                ${canDelete(state.permissions) ? `<button type="button" data-del="${task.id}" class="danger">Delete</button>` : ''}
                </div>
              </div>
              ${editable ? `<form data-add-timeline="${task.id}" class="grid mt">
                <label>Add timeline update<div class="tiny">Keep this focused on what changed since the last service step.</div><textarea name="note" placeholder="What happened on this visit, test, or handoff?"></textarea></label>
                <div class="grid grid-2">
                  <label>Image refs<textarea name="imageRefs" placeholder="Photos, filenames, links"></textarea></label>
                  <label>Video refs<textarea name="videoRefs" placeholder="Videos or clips"></textarea></label>
                </div>
                <label>Evidence refs<textarea name="evidenceRefs" placeholder="Meter readings, logs, ticket links"></textarea></label>
                <div class="action-row"><button type="submit">Add timeline update</button></div>
              </form>` : ''}
              ${(meta.awaitingAssignment || meta.unavailable.length) ? `<div class="row mt"><select data-reassign-select="${task.id}"><option value="">Select worker</option>${workerOptions.map((worker) => `<option value="${worker.id || worker.email || ''}">${getWorkerOptionLabel(worker)}</option>`).join('')}</select><div class="tiny">Required before moving this task into progress.</div></div>` : ''}
              ${renderCloseoutSummary(task, meta)}
              ${renderCloseout(task, state)}
              ${renderAiPanel(task, state, meta)}
            </div>
          </details>`;
        }).join('')}
      </div>`
      : `<div class="inline-state ${scopedTasks.length ? 'info' : 'success'} mt">${scopedTasks.length ? 'No tasks match the current quick filters.' : 'No open operations tasks yet. Create a task to start troubleshooting an asset issue.'}</div>`}
    </div>
  `;

  const rerender = () => renderOperations(el, state, actions);
  const form = el.querySelector('#taskForm');
  el.querySelector('[data-jump-intake]')?.addEventListener('click', () => {
    form?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form?.querySelector('[name="assetSearch"]')?.focus();
  });
  const idInput = form?.querySelector('[name="id"]');
  const openedAtInput = form?.querySelector('[name="openedAt"]');
  const assetInput = form?.querySelector('[name="assetSearch"]');
  const reporterInput = form?.querySelector('[name="reporter"]');
  const locationInput = form?.querySelector('[name="location"]');
  const missingAssetPromptEl = form?.querySelector('#missingAssetPrompt');
  const moreDetails = form?.querySelector('[data-more-details]');

  const getSelectedAsset = () => {
    const raw = `${assetInput?.value || ''}`.trim();
    if (!raw) return null;
    return assetByName.get(raw.toLowerCase()) || assetById.get(raw) || null;
  };

  const syncFormMeta = () => {
    const selectedAsset = getSelectedAsset();
    const existingIds = state.tasks.map((task) => task.id);
    const currentAssetKey = buildAssetKey(selectedAsset?.id, selectedAsset?.name || `${assetInput?.value || ''}`);
    const nextId = generateTaskId({
      assetId: selectedAsset?.id,
      assetName: selectedAsset?.name,
      existingIds
    });
    const shouldRefreshId = !idInput?.value || existingIds.includes(idInput.value) || form?.dataset.assetKeyForId !== currentAssetKey;
    if (idInput && shouldRefreshId) idInput.value = nextId;
    if (openedAtInput && (!openedAtInput.value || shouldRefreshId)) openedAtInput.value = getCurrentOpenedDateTimeValue(new Date());
    if (form) form.dataset.assetKeyForId = currentAssetKey;
    if (reporterInput && !reporterInput.value) reporterInput.value = state.user?.email || '';
    const scopedLocationName = scope.selection?.id ? scope.selection.name : '';
    if (locationInput && !locationInput.value) locationInput.value = selectedAsset?.locationName || selectedAsset?.location || scopedLocationName;
  };

  const assignmentHintEl = form?.querySelector('#assignmentStatusHint');
  const syncAssignmentHint = () => {
    const status = `${form?.querySelector('[name="status"]')?.value || 'open'}`.trim();
    const assigned = `${form?.querySelector('[name="assignedWorker"]')?.value || ''}`.trim();
    if (assignmentHintEl) {
      assignmentHintEl.textContent = status === 'in_progress' && !assigned
        ? 'Cannot save as in progress without an assigned worker.'
        : 'Open tasks can be saved without an assignee.';
      assignmentHintEl.className = `tiny ${status === 'in_progress' && !assigned ? 'inline-state error' : 'inline-state info'}`;
    }
  };

  const syncMissingAssetPrompt = () => {
    if (!missingAssetPromptEl) return;
    const raw = `${assetInput?.value || ''}`.trim();
    const exists = !raw || !!(assetByName.get(raw.toLowerCase()) || assetById.get(raw));
    missingAssetPromptEl.classList.toggle('hide', exists);
    missingAssetPromptEl.innerHTML = exists ? '' : renderMissingAssetPrompt(raw);
    missingAssetPromptEl.querySelector('[data-create-missing-asset]')?.addEventListener('click', () => actions.prepareAssetCreation({
      assetName: raw,
      locationName: `${locationInput?.value || scope.selection?.name || ''}`.trim()
    }));
  };

  const resetTaskForm = () => {
    state.operationsUi.draft = {};
    state.operationsUi.moreDetailsOpen = false;
    if (!form) return;
    form.reset();
    if (moreDetails) moreDetails.open = false;
    if (form.dataset.assetKeyForId) delete form.dataset.assetKeyForId;
    if (idInput) idInput.value = '';
    if (openedAtInput) openedAtInput.value = '';
    syncFormMeta();
    persistDraft();
  };

  const restoreDraft = () => {
    const draft = state.operationsUi?.draft || {};
    if (!form) return;
    [...form.elements].forEach((input) => {
      if (!input?.name || input.name === 'id' || input.name === 'openedAt') return;
      if (typeof draft[input.name] === 'undefined') return;
      input.value = draft[input.name];
    });
    if (idInput) idInput.value = `${draft.id || ''}`.trim() || idInput.value;
    if (openedAtInput) openedAtInput.value = `${draft.openedAt || ''}`.trim() || openedAtInput.value;
    syncFormMeta();
  };

  const persistDraft = () => {
    if (!form) return;
    state.operationsUi.draft = readFormDraft(form);
    state.operationsUi.moreDetailsOpen = !!moreDetails?.open;
    state.operationsUi.scrollY = window.scrollY;
  };

  syncFormMeta();
  restoreDraft();
  syncAssignmentHint();
  syncMissingAssetPrompt();

  form?.addEventListener('input', persistDraft);
  assetInput?.addEventListener('input', () => {
    persistDraft();
    syncMissingAssetPrompt();
  });
  form?.addEventListener('change', () => {
    syncFormMeta();
    syncAssignmentHint();
    persistDraft();
    syncMissingAssetPrompt();
  });
  moreDetails?.addEventListener('toggle', () => {
    state.operationsUi.moreDetailsOpen = !!moreDetails.open;
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    persistDraft();
    const fd = new FormData(form);
    const selectedAsset = getSelectedAsset();
    const assignedWorker = `${fd.get('assignedWorker') || ''}`.trim();
    const requestedStatus = `${fd.get('status') || 'open'}`.trim();
    const openedAtRaw = `${fd.get('openedAt') || ''}`.trim();
    const assetLocation = selectedAsset ? getAssetLocationRecord(state, selectedAsset) : null;
    if (!selectedAsset) {
      state.operationsUi.lastSaveFeedback = `Asset "${`${fd.get('assetSearch') || ''}`.trim()}" does not exist yet. Create the asset first, then save the task.`;
      state.operationsUi.lastSaveTone = 'error';
      rerender();
      return;
    }
    if (requestedStatus === 'in_progress' && !assignedWorker) {
      state.operationsUi.lastSaveFeedback = 'Cannot save: status is in progress but no worker is assigned.';
      state.operationsUi.lastSaveTone = 'error';
      rerender();
      return;
    }
    const payload = normalizeTaskIntake({
      ...Object.fromEntries(fd.entries()),
      id: `${fd.get('id') || ''}`.trim(),
      assetId: selectedAsset?.id || '',
      openedAt: openedAtRaw ? new Date(openedAtRaw).toISOString() : new Date().toISOString(),
      createdAtClient: new Date().toISOString(),
      assetName: selectedAsset?.name || `${fd.get('assetSearch') || ''}`,
      locationId: assetLocation?.id || '',
      location: `${fd.get('location') || ''}`.trim() || assetLocation?.name || '',
      assetKeySnapshot: buildAssetKey(selectedAsset?.id, selectedAsset?.name),
      assignedWorker,
      reportedByUserId: state.user?.uid || '',
      reportedByEmail: state.user?.email || ''
    }, state.settings || {});
    const attachments = buildAttachments(Object.fromEntries(fd.entries()));
    const initialTimelineNote = `${fd.get('timelineEntry') || ''}`.trim();
    payload.attachments = attachments;
    if (initialTimelineNote || payload.notes || attachmentCount(attachments)) {
      payload.timeline = [{
        at: payload.openedAt,
        type: 'intake',
        note: initialTimelineNote || payload.notes || 'Task created',
        detail: payload.notes && initialTimelineNote && payload.notes !== initialTimelineNote ? payload.notes : '',
        by: state.user?.email || state.user?.uid || payload.reporter || 'unknown',
        attachments
      }];
    }
    if (state.tasks.some((task) => task.id === payload.id)) payload.id = generateTaskId({
      assetId: payload.assetId,
      assetName: payload.assetName,
      existingIds: state.tasks.map((task) => task.id)
    });
    const validation = validateTaskIntake(payload, ['assetId', 'description', 'reporter']);
    if (!validation.ok) {
      state.operationsUi.lastSaveFeedback = `Missing required fields: ${validation.missing.join(', ')}`;
      state.operationsUi.lastSaveTone = 'error';
      rerender();
      return;
    }

    const saved = await actions.saveTask(payload.id || `${fd.get('id') || ''}`.trim(), payload);
    if (!saved) return;
    resetTaskForm();
  });

  el.querySelector('[data-location-filter]')?.addEventListener('change', (event) => actions.setLocationFilter(event.target.value));
  el.querySelector('[data-task-search]')?.addEventListener('input', (event) => {
    state.operationsUi.taskSearch = event.target.value;
    rerender();
  });
  el.querySelector('[data-assignee-filter]')?.addEventListener('change', (event) => {
    state.operationsUi.assigneeFilter = event.target.value || 'all';
    rerender();
  });
  el.querySelectorAll('[data-status-filter]').forEach((button) => button.addEventListener('click', () => {
    state.operationsUi.statusFilter = button.dataset.statusFilter || 'open';
    rerender();
  }));
  el.querySelector('[data-clear-task-filters]')?.addEventListener('click', () => {
    state.operationsUi.statusFilter = 'open';
    state.operationsUi.ownershipFilter = 'all';
    state.operationsUi.exceptionFilter = 'all';
    state.operationsUi.taskSearch = '';
    state.operationsUi.assigneeFilter = 'all';
    rerender();
  });
  el.querySelectorAll('[data-ownership-filter]').forEach((button) => button.addEventListener('click', () => {
    state.operationsUi.ownershipFilter = button.dataset.ownershipFilter || 'all';
    rerender();
  }));
  el.querySelectorAll('[data-exception-filter]').forEach((button) => button.addEventListener('click', () => {
    state.operationsUi.exceptionFilter = button.dataset.exceptionFilter || 'all';
    rerender();
  }));

  el.querySelectorAll('[data-task-details]').forEach((taskDetails) => taskDetails.addEventListener('toggle', () => {
    const taskId = taskDetails.dataset.taskDetails;
    const current = new Set(state.operationsUi.expandedTaskIds || []);
    if (taskDetails.open) current.add(taskId);
    else current.delete(taskId);
    state.operationsUi.expandedTaskIds = [...current];
  }));

  el.querySelectorAll('[data-closeout]').forEach((taskForm) => taskForm.addEventListener('submit', (event) => {
    event.preventDefault();
    state.operationsUi.scrollY = window.scrollY;
    const taskId = taskForm.dataset.closeout;
    const closeout = Object.fromEntries(new FormData(taskForm).entries());
    closeout.attachments = buildAttachments(closeout);
    actions.completeTask(taskId, closeout);
  }));
  el.querySelectorAll('[data-add-timeline]').forEach((timelineForm) => timelineForm.addEventListener('submit', (event) => {
    event.preventDefault();
    state.operationsUi.scrollY = window.scrollY;
    const fd = new FormData(timelineForm);
    actions.appendTaskTimeline(timelineForm.dataset.addTimeline, {
      note: `${fd.get('note') || ''}`.trim(),
      attachments: buildAttachments(Object.fromEntries(fd.entries()))
    });
  }));

  el.querySelectorAll('[data-quick-status]').forEach((button) => button.addEventListener('click', async () => {
    state.operationsUi.scrollY = window.scrollY;
    const task = state.tasks.find((entry) => entry.id === button.dataset.quickStatus);
    const nextStatus = button.dataset.nextStatus;
    if (!task || !nextStatus) return;
    if (nextStatus === 'in_progress' && !(task.assignedWorkers || []).length) {
      state.operationsUi.lastSaveFeedback = 'Assign a worker before starting a task.';
      state.operationsUi.lastSaveTone = 'error';
      rerender();
      return;
    }
    const timelineEntry = nextStatus === 'in_progress'
      ? { at: new Date().toISOString(), type: 'start_work', note: 'Work started from Operations board.', by: state.user?.email || state.user?.uid || 'unknown' }
      : { at: new Date().toISOString(), type: 'update', note: 'Moved back to open status.', by: state.user?.email || state.user?.uid || 'unknown' };
    await actions.saveTask(task.id, {
      ...task,
      status: nextStatus,
      timeline: [...(task.timeline || []), timelineEntry],
      updatedAtClient: new Date().toISOString()
    });
  }));
  el.querySelectorAll('[data-open-closeout]').forEach((button) => button.addEventListener('click', () => {
    const panel = el.querySelector(`[data-closeout-panel="${button.dataset.openCloseout}"]`);
    if (!panel) return;
    panel.open = true;
    panel.scrollIntoView({ block: 'nearest' });
  }));
  el.querySelectorAll('[data-jump-task]').forEach((button) => button.addEventListener('click', () => {
    const card = el.querySelector(`#task-${button.dataset.jumpTask}`);
    if (!card) return;
    card.open = true;
    card.scrollIntoView({ block: 'center' });
  }));
  el.querySelectorAll('[data-open-followup]').forEach((button) => button.addEventListener('click', () => {
    const card = button.closest('[data-task-details]');
    const followupInput = card?.querySelector('[data-followup] input');
    followupInput?.focus();
    followupInput?.scrollIntoView({ block: 'nearest' });
  }));
  el.querySelectorAll('[data-reassign-select]').forEach((input) => input.addEventListener('change', () => {
    state.operationsUi.reassignSelections = {
      ...(state.operationsUi.reassignSelections || {}),
      [input.dataset.reassignSelect]: input.value || ''
    };
  }));
  el.querySelectorAll('[data-reassign]').forEach((button) => button.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.reassignTask(button.dataset.reassign);
  }));
  el.querySelectorAll('[data-del]').forEach((button) => button.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.deleteTask(button.dataset.del);
  }));
  el.querySelectorAll('[data-upload-task-evidence]').forEach((button) => button.addEventListener('click', async () => {
    const taskId = button.dataset.uploadTaskEvidence;
    const input = el.querySelector(`[data-task-evidence-file="${taskId}"]`);
    const file = input?.files?.[0] || null;
    if (!file) {
      state.operationsUi.evidenceUploadsByTask = {
        ...(state.operationsUi.evidenceUploadsByTask || {}),
        [taskId]: { uploading: false, tone: 'error', message: 'Select an image to upload.' }
      };
      rerender();
      return;
    }
    if (!file.type?.startsWith('image/')) {
      state.operationsUi.evidenceUploadsByTask = {
        ...(state.operationsUi.evidenceUploadsByTask || {}),
        [taskId]: { uploading: false, tone: 'error', message: 'Only image uploads are enabled right now.' }
      };
      rerender();
      return;
    }
    if (Number(file.size || 0) > MAX_EVIDENCE_IMAGE_BYTES) {
      state.operationsUi.evidenceUploadsByTask = {
        ...(state.operationsUi.evidenceUploadsByTask || {}),
        [taskId]: { uploading: false, tone: 'error', message: 'Image is too large. Keep uploads under 8 MB.' }
      };
      rerender();
      return;
    }
    state.operationsUi.evidenceUploadsByTask = {
      ...(state.operationsUi.evidenceUploadsByTask || {}),
      [taskId]: { uploading: true, tone: 'info', message: 'Uploading image evidence…' }
    };
    rerender();
    try {
      await actions.uploadTaskEvidence(taskId, file);
      state.operationsUi.evidenceUploadsByTask = {
        ...(state.operationsUi.evidenceUploadsByTask || {}),
        [taskId]: { uploading: false, tone: 'success', message: `Uploaded ${file.name}.` }
      };
      rerender();
    } catch (error) {
      state.operationsUi.evidenceUploadsByTask = {
        ...(state.operationsUi.evidenceUploadsByTask || {}),
        [taskId]: { uploading: false, tone: 'error', message: `${error?.message || 'Unable to upload evidence file.'}` }
      };
      rerender();
    }
  }));
  el.querySelectorAll('[data-remove-task-evidence]').forEach((button) => button.addEventListener('click', async () => {
    const taskId = button.dataset.removeTaskEvidence;
    const evidenceId = button.dataset.evidenceId;
    if (!taskId || !evidenceId) return;
    state.operationsUi.evidenceUploadsByTask = {
      ...(state.operationsUi.evidenceUploadsByTask || {}),
      [taskId]: { uploading: true, tone: 'info', message: 'Removing uploaded evidence…' }
    };
    rerender();
    try {
      await actions.removeTaskEvidence(taskId, evidenceId);
      state.operationsUi.evidenceUploadsByTask = {
        ...(state.operationsUi.evidenceUploadsByTask || {}),
        [taskId]: { uploading: false, tone: 'success', message: 'Evidence removed.' }
      };
      rerender();
    } catch (error) {
      state.operationsUi.evidenceUploadsByTask = {
        ...(state.operationsUi.evidenceUploadsByTask || {}),
        [taskId]: { uploading: false, tone: 'error', message: `${error?.message || 'Unable to remove evidence.'}` }
      };
      rerender();
    }
  }));
  el.querySelectorAll('[data-run-ai]').forEach((button) => button.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.runAi(button.dataset.runAi);
  }));
  el.querySelectorAll('[data-rerun-ai]').forEach((button) => button.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.rerunAi(button.dataset.rerunAi);
  }));
  el.querySelectorAll('[data-save-fix]').forEach((button) => button.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.saveFix(button.dataset.saveFix);
  }));
  el.querySelectorAll('[data-task-ai-fix-state]').forEach((button) => button.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.setAiFixState(button.dataset.taskAiFixState, button.dataset.aiFixState);
  }));
  el.querySelectorAll('[data-followup]').forEach((followupForm) => followupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    state.operationsUi.scrollY = window.scrollY;
    const taskId = followupForm.dataset.followup;
    const runId = followupForm.dataset.run;
    const answers = [...new FormData(followupForm).entries()].map(([, answer], index) => ({
      question: (state.taskAiFollowups.find((entry) => entry.runId === runId)?.questions || [])[index] || `Question ${index + 1}`,
      answer
    }));
    actions.submitFollowup(taskId, runId, answers);
  }));
}
