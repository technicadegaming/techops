import {
  canDelete,
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
  getLocationEmptyState,
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

function getAiStatusLabel(status = 'idle') {
  return AI_STATUS_LABEL[status] || `AI ${`${status || 'idle'}`.replaceAll('_', ' ')}`;
}

function parseReferenceList(value = '') {
  return `${value || ''}`
    .split(/\r?\n|,/)
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

function formatTimelineType(type = '') {
  return ({
    intake: 'Intake',
    update: 'Update',
    closeout: 'Closeout',
    task_closeout: 'Closeout'
  })[type] || 'Entry';
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
        <b>${formatTimelineType(entry.type)}</b>
        <span class="tiny">${formatDateTime(entry.at)}</span>
      </div>
      ${entry.note ? `<div class="mt">${entry.note}</div>` : ''}
      ${entry.detail ? `<div class="tiny mt">${entry.detail}</div>` : ''}
      ${entry.by ? `<div class="tiny mt">By ${entry.by}</div>` : ''}
      ${attachmentCount(entry.attachments || {}) ? renderAttachments(entry.attachments || {}, '') : ''}
    </div>`).join('')}</div>`;
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

function getTaskRun(task, state) {
  const taskId = `${task?.id || ''}`.trim();
  const taskCompanyId = `${task?.companyId || ''}`.trim();
  const fromList = (state.taskAiRuns || [])
    .filter((entry) => `${entry.taskId || ''}`.trim() === taskId)
    .filter((entry) => {
      if (!taskCompanyId) return true;
      return `${entry.companyId || ''}`.trim() === taskCompanyId;
    })
    .sort((a, b) => `${b.updatedAt || b.createdAt || ''}`.localeCompare(`${a.updatedAt || a.createdAt || ''}`))[0] || null;
  const displayRun = state.operationsUi?.aiDisplayRunsByTask?.[taskId] || null;
  const displayTaskId = `${displayRun?.taskId || ''}`.trim();
  const displayCompanyId = `${displayRun?.companyId || ''}`.trim();
  const validDisplayRun = displayRun && displayTaskId === taskId && (!taskCompanyId || !displayCompanyId || displayCompanyId === taskCompanyId)
    ? displayRun
    : null;
  if (fromList && validDisplayRun) {
    return `${validDisplayRun.updatedAt || validDisplayRun.createdAt || ''}`.localeCompare(`${fromList.updatedAt || fromList.createdAt || ''}`) > 0
      ? validDisplayRun
      : fromList;
  }
  return fromList || validDisplayRun || null;
}

function getTaskFollowup(runId, state, run = null) {
  if (!runId) return null;
  const followup = (state.taskAiFollowups || []).find((entry) => entry.runId === runId) || null;
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
  const canRun = canRunAiTroubleshooting(state.permissions);
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
    reason = 'Manual AI run requires lead or higher.';
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

function getTaskAiState(task, state, run, followup) {
  const localState = getTaskAiLocalState(task.id, state);
  const eligibility = getTaskAiEligibility(task, state, run);
  if (run?.status === 'followup_required') {
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
  const labels = new Set(sourceList.map((source) => source?.sourceType).filter(Boolean));
  const mode = labels.has('manual')
    ? 'manual-backed'
    : (labels.has('approved_doc') ? 'approved-doc-backed' : 'web/internal only');
  if (!sourceList.length && !run?.citations?.length) return `<div class="tiny">Sources used: ${mode}</div>`;
  const names = sourceList.slice(0, 3).map((source) => source.title || source.url).filter(Boolean);
  return `<div class="tiny">Sources used: ${mode}${names.length ? ` | ${names.join(' | ')}` : ''}</div>`;
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
  const followup = getTaskFollowup(run?.id, state, run);
  const aiState = getTaskAiState(task, state, run, followup);
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
  const followup = meta.followup;
  const aiState = meta.aiState;
  const eligibility = aiState.eligibility;
  const canShowRunNow = eligibility.hasTaskCompanyContext
    && eligibility.aiEnabled
    && eligibility.canRun
    && !run
    && !['queued', 'running'].includes(aiState.status);
  const canShowRerun = eligibility.hasTaskCompanyContext && eligibility.aiEnabled && eligibility.canRun && !!run && eligibility.manualRerunAllowed;
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
      <div class="tiny">Status: ${getAiStatusLabel(aiState.status)}</div>
    </div>
    <div class="inline-state ${statusTone} mt">${aiState.message}</div>
    <div class="tiny mt">${sourceLine}${aiState.source ? ` | source: ${aiState.source}` : ''}${aiState.details ? ` | ${aiState.details}` : ''}</div>
    ${actionHint ? `<div class="tiny mt">${actionHint}</div>` : ''}
    ${guidance ? `<div class="tiny mt">${guidance}</div>` : ''}
    ${task.aiSummary?.summary ? `<div class="tiny mt">${task.aiSummary.summary}</div>` : ''}
    ${run ? renderAiSourceLine(run) : (aiState.status === 'waiting_for_refresh' ? `<div class="tiny mt">${aiState.message}</div>` : '<div class="tiny mt">No AI run yet for this task.</div>')}
    ${run?.shortFrontlineVersion ? `<div class="tiny mt"><b>Frontline:</b> ${run.shortFrontlineVersion}</div>` : ''}
    ${run?.diagnosticSteps?.length ? `<div class="tiny mt"><b>Next steps:</b> ${run.diagnosticSteps.join(' | ')}</div>` : ''}
    ${followup?.questions?.length ? `<div class="inline-state warn mt">AI cannot advance until the follow-up answers below are submitted.</div>
      <form data-followup="${task.id}" data-run="${run.id}" class="grid mt followup-form">${followup.questions.map((question, index) => `<label class="tiny">${question}<input name="a${index}" placeholder="Answer" ${canAnswerAiFollowups(state.permissions) ? '' : 'disabled'} /></label>`).join('')}<button class="primary" ${canAnswerAiFollowups(state.permissions) ? '' : 'disabled'}>Submit follow-up answers</button></form>` : ''}
    ${!canAnswerAiFollowups(state.permissions) && followup?.questions?.length ? `<div class="tiny mt">Follow-up answers require staff or higher.</div>` : ''}
    ${!eligibility.canRun && aiState.status !== 'completed' ? `<div class="tiny mt">${eligibility.reason}</div>` : ''}
    <div class="action-row mt">
      ${canShowRunNow ? `<button data-run-ai="${task.id}">Run AI now</button>` : ''}
      ${canShowRerun ? `<button data-rerun-ai="${task.id}">${rerunLabel}</button>` : ''}
      ${aiState.status === 'disabled_by_settings' && canChangeAISettings(state.permissions) ? '<button type="button" data-open-ai-settings="1">Open AI settings</button>' : ''}
      <button data-save-fix="${task.id}" ${canSaveFixToLibrary(state.permissions) ? '' : 'disabled'}>Save fix to library</button>
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

function renderCloseout(task, state, meta) {
  if (task.status === 'completed' || !canCloseTasks(state.permissions)) return '';
  return `<details class="item mt" data-closeout-panel="${task.id}">
    <summary><b>Resolve and close task</b></summary>
    <div class="tiny mt">Capture the fix, proof, and whether the issue is fully resolved before closing.</div>
    <form data-closeout="${task.id}" class="grid grid-2 mt closeout-form">
      <label>Root cause<input name="rootCause" placeholder="Example: ticket mech jammed by bent guide" required /></label>
      <label>Fix performed<input name="fixPerformed" placeholder="Example: straightened guide and re-tested vend path" required /></label>
      <label>Parts used<input name="partsUsed" placeholder="Comma-separated" /></label>
      <label>Tools used<input name="toolsUsed" placeholder="Comma-separated" /></label>
      <label>Time spent (minutes)<input name="timeSpentMinutes" type="number" min="0" placeholder="0" /></label>
      <label>Verification<input name="verification" placeholder="What did you test before closeout?" /></label>
      <label>Resolution status<select name="fullyResolved"><option value="yes">Fully resolved</option><option value="no">Partially resolved / monitor</option></select></label>
      <label>Save to library<select name="saveToLibrary"><option value="">Use default</option><option value="yes">Save to troubleshooting library</option><option value="no">Do not save</option></select></label>
      <label>AI helpfulness<select name="aiHelpfulness"><option value="">Optional</option><option value="helpful">AI was helpful</option><option value="partial">AI partially helpful</option><option value="not_helpful">AI not helpful</option></select></label>
      <label>Best concise fix summary<input name="bestFixSummary" placeholder="One-line closeout summary for future reuse" /></label>
      <label class="closeout-wide">Image references<textarea name="imageRefs" placeholder="Photo URLs, filenames, or shared-drive refs"></textarea></label>
      <label class="closeout-wide">Video references<textarea name="videoRefs" placeholder="Video URLs or file refs"></textarea></label>
      <label class="closeout-wide">Evidence references<textarea name="evidenceRefs" placeholder="Logs, tickets, measurements, or other evidence"></textarea></label>
      <div class="closeout-actions closeout-wide">
        <button class="primary">Complete task</button>
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
    lastSaveFeedback: '',
    lastSaveTone: 'info',
    reassignSelections: {},
    aiTaskStates: {},
    aiDisplayRunsByTask: {},
    lastSavedTaskId: null
  };
}

function readFormDraft(form) {
  if (!form) return {};
  return Object.fromEntries(new FormData(form).entries());
}

function filterTasks(tasks, state) {
  const statusFilter = state.operationsUi?.statusFilter || 'open';
  const ownershipFilter = state.operationsUi?.ownershipFilter || 'all';
  const exceptionFilter = state.operationsUi?.exceptionFilter || 'all';
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
    return statusMatch && ownershipMatch && exceptionMatch;
  });
}

export function renderOperations(el, state, actions) {
  state.operationsUi = { ...createDefaultOperationsUiState(), ...(state.operationsUi || {}) };
  const editable = canEditTasks(state.permissions);
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
  const visibleTasks = filterTasks(scopedTasks, state);
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
    <div class="row space">
      <div>
        <h2>Operations & Tasks</h2>
        <div class="tiny">${getLocationScopeLabel(scope.selection)} | Structured intake enabled</div>
      </div>
      <div class="kpi-line">
        <span>Visible tasks: ${visibleTasks.length}</span>
        <span>Open work: ${openTasks.length}</span>
        <span>In progress: ${inProgress}</span>
      </div>
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
      <div class="filter-row mt">
        <button class="filter-chip ${state.operationsUi.statusFilter === 'open' ? 'active' : ''}" data-status-filter="open" type="button">Open work</button>
        <button class="filter-chip ${state.operationsUi.statusFilter === 'in_progress' ? 'active' : ''}" data-status-filter="in_progress" type="button">In progress</button>
        <button class="filter-chip ${state.operationsUi.statusFilter === 'completed' ? 'active' : ''}" data-status-filter="completed" type="button">Completed</button>
        <button class="filter-chip ${state.operationsUi.statusFilter === 'all' ? 'active' : ''}" data-status-filter="all" type="button">All statuses</button>
      </div>
      <div class="filter-row mt">
        <button class="filter-chip ${state.operationsUi.ownershipFilter === 'all' ? 'active' : ''}" data-ownership-filter="all" type="button">All ownership</button>
        <button class="filter-chip ${state.operationsUi.ownershipFilter === 'mine' ? 'active' : ''}" data-ownership-filter="mine" type="button">My work</button>
        <button class="filter-chip ${state.operationsUi.ownershipFilter === 'unassigned' ? 'active' : ''}" data-ownership-filter="unassigned" type="button">Unassigned</button>
        <button class="filter-chip ${state.operationsUi.ownershipFilter === 'followup' ? 'active' : ''}" data-ownership-filter="followup" type="button">Needs follow-up</button>
      </div>
      <div class="filter-row mt">
        <button class="filter-chip ${state.operationsUi.exceptionFilter === 'all' ? 'active' : ''}" data-exception-filter="all" type="button">All exceptions</button>
        <button class="filter-chip ${state.operationsUi.exceptionFilter === 'priority' ? 'active' : ''}" data-exception-filter="priority" type="button">High priority</button>
        <button class="filter-chip ${state.operationsUi.exceptionFilter === 'overdue' ? 'active' : ''}" data-exception-filter="overdue" type="button">Overdue</button>
        <button class="filter-chip ${state.operationsUi.exceptionFilter === 'blocked' ? 'active' : ''}" data-exception-filter="blocked" type="button">Blocked</button>
        <button class="filter-chip ${state.operationsUi.exceptionFilter === 'closeout' ? 'active' : ''}" data-exception-filter="closeout" type="button">Ready to close</button>
      </div>
    </div>

    ${state.operationsUi.lastSaveFeedback ? `<div class="inline-state ${state.operationsUi.lastSaveTone || 'info'}">${state.operationsUi.lastSaveFeedback}</div>` : ''}
    ${!scopedAssets.length ? '<div class="inline-state warn">No assets exist in this location scope yet. Create or import an asset in Assets/Admin before opening Operations intake.</div>' : ''}

    <form id="taskForm" class="grid mt">
      <div class="grid grid-2">
        <label>Task ID<input name="id" readonly /></label>
        <label>Opened date/time<input name="openedAt" type="datetime-local" readonly /></label>
      </div>
      <label>Asset / game
        <input name="assetSearch" list="assetOptions" placeholder="${scopedAssets.length ? 'Search by asset name' : 'No assets in the current location yet'}" required ${editable ? '' : 'disabled'} />
      </label>
      <div id="missingAssetPrompt" class="inline-state error ${missingAssetPrompt ? '' : 'hide'}">${missingAssetPrompt ? renderMissingAssetPrompt(typedAssetName) : ''}</div>
      <textarea name="description" placeholder="Describe the issue / concern" required ${editable ? '' : 'disabled'}></textarea>
      <input name="alreadyTried" placeholder="What has been tried so far?" ${editable ? '' : 'disabled'} />
      <input name="reporter" placeholder="Reported by" required ${editable ? '' : 'disabled'} />

      <details data-more-details ${state.operationsUi.moreDetailsOpen ? 'open' : ''}>
        <summary>More details (optional)</summary>
        <div class="grid grid-2 mt">
          <input name="issueCategory" placeholder="Issue category" ${editable ? '' : 'disabled'} />
          <select name="severity" ${editable ? '' : 'disabled'}><option>critical</option><option>high</option><option selected>medium</option><option>low</option></select>
          <input name="symptomTags" placeholder="Symptoms / tags (comma-separated)" ${editable ? '' : 'disabled'} />
          <input name="symptomTagsExtra" placeholder="Additional symptom tags" ${editable ? '' : 'disabled'} />
          <input name="location" list="locationOptions" placeholder="Location / zone / area" ${editable ? '' : 'disabled'} />
          <input name="customerImpact" placeholder="Customer impact" ${editable ? '' : 'disabled'} />
          <input name="errorText" placeholder="Observed error text/code" ${editable ? '' : 'disabled'} />
          <select name="occurrence" ${editable ? '' : 'disabled'}><option value="constant">Constant</option><option value="intermittent">Intermittent</option></select>
          <select name="reproducible" ${editable ? '' : 'disabled'}><option value="yes">Reproducible</option><option value="no">Not reproducible</option><option value="unknown">Unknown</option></select>
          <input name="visibleCondition" placeholder="Visible condition notes" ${editable ? '' : 'disabled'} />
          <label>Assigned worker
            <div class="tiny">Open tasks can be saved unassigned. Assignment is required before moving to in progress.</div>
            <select name="assignedWorker" ${editable ? '' : 'disabled'}>
              <option value="">Assign later</option>
              ${workerOptions.map((worker) => `<option value="${worker.id || worker.email || ''}">${getWorkerOptionLabel(worker)}</option>`).join('')}
            </select>
          </label>
          <label>Status<div class="tiny">Open = intake allowed without assignment. In progress requires an assigned worker.</div><select name="status" ${editable ? '' : 'disabled'}><option>open</option><option>in_progress</option><option>completed</option></select></label>
          <div id="assignmentStatusHint" class="tiny"></div>
          <textarea name="notes" placeholder="Current summary / handoff notes" ${editable ? '' : 'disabled'}></textarea>
          <textarea name="timelineEntry" placeholder="First service timeline entry" ${editable ? '' : 'disabled'}></textarea>
          <textarea name="imageRefs" placeholder="Image references: URLs, filenames, drive refs" ${editable ? '' : 'disabled'}></textarea>
          <textarea name="videoRefs" placeholder="Video references: URLs or filenames" ${editable ? '' : 'disabled'}></textarea>
          <textarea name="evidenceRefs" placeholder="Evidence refs: logs, measurements, ticket links" ${editable ? '' : 'disabled'}></textarea>
        </div>
        <div class="tiny mt">Use timeline updates and reference fields to keep a service-history trail without requiring upload wiring.</div>
      </details>

      <button class="primary" ${editable ? '' : 'disabled'}>Save task</button>
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
              <div class="mt"><b>Service timeline</b>${renderTimeline(task)}</div>
              <div class="mt"><b>Recorded references</b>${renderAttachments(task.attachments || {}, 'No image, video, or evidence references on this task yet.')}</div>
              ${meta.unavailable.length ? `<div class="tiny mt">Unavailable assignees: ${meta.unavailable.join(', ')}</div>` : ''}
              <div class="action-row mt">
                ${editable && task.status === 'open' ? `<button type="button" data-quick-status="${task.id}" data-next-status="in_progress" class="primary" ${meta.assignedWorkers.length ? '' : 'disabled'}>Start now</button>` : ''}
                ${editable && task.status === 'in_progress' ? `<button type="button" data-quick-status="${task.id}" data-next-status="open">Move back to open</button>` : ''}
                ${task.status !== 'completed' && canCloseTasks(state.permissions) ? `<button type="button" data-open-closeout="${task.id}">Resolve / close</button>` : ''}
                ${meta.needsFollowup ? `<button type="button" data-open-followup="${task.id}">Answer follow-up</button>` : ''}
                ${(meta.awaitingAssignment || meta.unavailable.length) ? `<button type="button" data-reassign="${task.id}">Quick reassign</button>` : ''}
                ${canDelete(state.permissions) ? `<button type="button" data-del="${task.id}" class="danger">Delete</button>` : ''}
              </div>
              ${editable ? `<form data-add-timeline="${task.id}" class="grid mt">
                <label>Add timeline update<textarea name="note" placeholder="What happened on this visit, test, or handoff?"></textarea></label>
                <div class="grid grid-2">
                  <label>Image refs<textarea name="imageRefs" placeholder="Photos, filenames, links"></textarea></label>
                  <label>Video refs<textarea name="videoRefs" placeholder="Videos or clips"></textarea></label>
                </div>
                <label>Evidence refs<textarea name="evidenceRefs" placeholder="Meter readings, logs, ticket links"></textarea></label>
                <div class="action-row"><button type="submit">Add timeline update</button></div>
              </form>` : ''}
              ${(meta.awaitingAssignment || meta.unavailable.length) ? `<div class="row mt"><select data-reassign-select="${task.id}"><option value="">Select worker</option>${workerOptions.map((worker) => `<option value="${worker.id || worker.email || ''}">${getWorkerOptionLabel(worker)}</option>`).join('')}</select><div class="tiny">Required before moving this task into progress.</div></div>` : ''}
              ${renderCloseoutSummary(task, meta)}
              ${renderCloseout(task, state, meta)}
              ${renderAiPanel(task, state, meta)}
            </div>
          </details>`;
        }).join('')}
      </div>`
      : `<div class="inline-state ${scopedTasks.length ? 'info' : 'success'} mt">${scopedTasks.length ? 'No tasks match the current quick filters.' : getLocationEmptyState(scope.selection, 'tasks', 'task')}</div>`}
  `;

  const rerender = () => renderOperations(el, state, actions);
  const form = el.querySelector('#taskForm');
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
  el.querySelectorAll('[data-status-filter]').forEach((button) => button.addEventListener('click', () => {
    state.operationsUi.statusFilter = button.dataset.statusFilter || 'open';
    rerender();
  }));
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
    await actions.saveTask(task.id, { ...task, status: nextStatus, updatedAtClient: new Date().toISOString() });
  }));
  el.querySelectorAll('[data-open-closeout]').forEach((button) => button.addEventListener('click', () => {
    const panel = el.querySelector(`[data-closeout-panel="${button.dataset.openCloseout}"]`);
    if (!panel) return;
    panel.open = true;
    panel.scrollIntoView({ block: 'nearest' });
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
