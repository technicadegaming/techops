import {
  canDelete,
  canEditTasks,
  canRunAiTroubleshooting,
  canAnswerAiFollowups,
  canSaveFixToLibrary,
  canCloseTasks
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

function getTaskRun(taskId, state) {
  return (state.taskAiRuns || []).find((entry) => entry.taskId === taskId) || null;
}

function getTaskFollowup(runId, state) {
  if (!runId) return null;
  return (state.taskAiFollowups || []).find((entry) => entry.runId === runId) || null;
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
  const run = getTaskRun(task.id, state);
  const followup = getTaskFollowup(run?.id, state);
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
  if (status === 'in_progress' && awaitingAssignment) blockedReasons.push('in progress without an assigned owner');
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

function renderAiPanel(task, state, meta) {
  const run = meta.run;
  const followup = meta.followup;
  return `<div class="item mt">
    <div class="row space">
      <b>AI Troubleshooting</b>
      <div class="tiny">Status: ${run?.status || 'not_started'}</div>
    </div>
    ${task.aiSummary?.summary ? `<div class="tiny mt">${task.aiSummary.summary}</div>` : ''}
    ${run ? renderAiSourceLine(run) : '<div class="tiny mt">No AI run yet for this task.</div>'}
    ${run?.shortFrontlineVersion ? `<div class="tiny mt"><b>Frontline:</b> ${run.shortFrontlineVersion}</div>` : ''}
    ${run?.diagnosticSteps?.length ? `<div class="tiny mt"><b>Next steps:</b> ${run.diagnosticSteps.join(' | ')}</div>` : ''}
    ${followup?.questions?.length ? `<div class="inline-state warn mt">AI cannot advance until the follow-up answers below are submitted.</div>
      <form data-followup="${task.id}" data-run="${run.id}" class="grid mt followup-form">${followup.questions.map((question, index) => `<label class="tiny">${question}<input name="a${index}" placeholder="Answer" ${canAnswerAiFollowups(state.permissions) ? '' : 'disabled'} /></label>`).join('')}<button class="primary" ${canAnswerAiFollowups(state.permissions) ? '' : 'disabled'}>Submit follow-up answers</button></form>` : ''}
    <div class="action-row mt">
      <button data-run-ai="${task.id}" ${canRunAiTroubleshooting(state.permissions) ? '' : 'disabled'}>${run ? 'Run AI again' : 'Run AI'}</button>
      <button data-rerun-ai="${task.id}" ${canRunAiTroubleshooting(state.permissions) ? '' : 'disabled'}>Regenerate</button>
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
      <label class="closeout-wide">Evidence link<input name="evidenceLink" placeholder="Photo / video / log URL (optional)" /></label>
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
    lastSaveTone: 'info'
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

    <form id="taskForm" class="grid mt">
      <div class="grid grid-2">
        <label>Task ID<input name="id" readonly /></label>
        <label>Opened date/time<input name="openedAt" type="datetime-local" readonly /></label>
      </div>
      <label>Asset / game
        <input name="assetSearch" list="assetOptions" placeholder="${scopedAssets.length ? 'Search by asset name' : 'No assets in the current location yet'}" required ${editable ? '' : 'disabled'} />
      </label>
      <textarea name="description" placeholder="Describe the issue / concern" required ${editable ? '' : 'disabled'}></textarea>
      <input name="alreadyTried" placeholder="What has been tried so far?" ${editable ? '' : 'disabled'} />
      <input name="reporter" placeholder="Who are you" required ${editable ? '' : 'disabled'} />

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
          <input name="assignedWorkers" placeholder="Assigned worker IDs/emails (comma-separated)" ${editable ? '' : 'disabled'} />
          <select name="status" ${editable ? '' : 'disabled'}><option>open</option><option>in_progress</option><option>completed</option></select>
          <textarea name="notes" placeholder="Optional notes" ${editable ? '' : 'disabled'}></textarea>
        </div>
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
                <span>${friendlyAsset}</span>
                <span>${taskLocation.label}</span>
                <span>${meta.ageLabel}</span>
              </div>
            </summary>
            <div class="task-body">
              ${renderExceptionBanner(meta)}
              <div class="task-meta-grid mt">
                <div><b>Owner</b><div class="tiny">${meta.assignedWorkers.join(', ') || 'unassigned'}</div></div>
                <div><b>Reported</b><div class="tiny">${formatDateTime(task.openedAt || task.createdAtClient)}</div></div>
                <div><b>Asset location</b><div class="tiny">${assetLocation?.label || taskLocation.label}${assetLocation && assetLocation.label !== taskLocation.label ? ` | task reported at ${taskLocation.label}` : ''}</div></div>
                <div><b>Category</b><div class="tiny">${task.issueCategory || 'uncategorized'} | tags: ${(task.symptomTags || []).join(', ') || 'none'}</div></div>
              </div>
              <div class="mt"><b>Issue:</b> ${task.description || ''}</div>
              ${meta.unavailable.length ? `<div class="tiny mt">Unavailable assignees: ${meta.unavailable.join(', ')}</div>` : ''}
              <div class="action-row mt">
                ${editable && task.status === 'open' ? `<button type="button" data-quick-status="${task.id}" data-next-status="in_progress" class="primary">Start now</button>` : ''}
                ${editable && task.status === 'in_progress' ? `<button type="button" data-quick-status="${task.id}" data-next-status="open">Move back to open</button>` : ''}
                ${task.status !== 'completed' && canCloseTasks(state.permissions) ? `<button type="button" data-open-closeout="${task.id}">Resolve / close</button>` : ''}
                ${meta.needsFollowup ? `<button type="button" data-open-followup="${task.id}">Answer follow-up</button>` : ''}
                ${(meta.awaitingAssignment || meta.unavailable.length) ? `<button type="button" data-reassign="${task.id}">Quick reassign</button>` : ''}
                ${canDelete(state.permissions) ? `<button type="button" data-del="${task.id}" class="danger">Delete</button>` : ''}
              </div>
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
  const moreDetails = form?.querySelector('[data-more-details]');

  const getSelectedAsset = () => {
    const raw = `${assetInput?.value || ''}`.trim();
    if (!raw) return null;
    return assetByName.get(raw.toLowerCase()) || assetById.get(raw) || null;
  };

  const syncFormMeta = () => {
    const selectedAsset = getSelectedAsset();
    const nextId = generateTaskId({
      assetId: selectedAsset?.id,
      assetName: selectedAsset?.name,
      existingIds: state.tasks.map((task) => task.id)
    });
    if (idInput && !idInput.value) idInput.value = nextId;
    if (openedAtInput && !openedAtInput.value) openedAtInput.value = getCurrentOpenedDateTimeValue(new Date());
    if (reporterInput && !reporterInput.value) reporterInput.value = state.user?.email || '';
    const scopedLocationName = scope.selection?.id ? scope.selection.name : '';
    if (locationInput && !locationInput.value) locationInput.value = selectedAsset?.locationName || selectedAsset?.location || scopedLocationName;
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

  form?.addEventListener('input', persistDraft);
  form?.addEventListener('change', () => {
    syncFormMeta();
    persistDraft();
  });
  moreDetails?.addEventListener('toggle', () => {
    state.operationsUi.moreDetailsOpen = !!moreDetails.open;
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    persistDraft();
    const fd = new FormData(form);
    const selectedAsset = getSelectedAsset();
    const openedAtRaw = `${fd.get('openedAt') || ''}`.trim();
    const assetLocation = selectedAsset ? getAssetLocationRecord(state, selectedAsset) : null;
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
      reportedByUserId: state.user?.uid || '',
      reportedByEmail: state.user?.email || ''
    }, state.settings || {});
    const validation = validateTaskIntake(payload, ['assetId', 'description', 'reporter']);
    if (!validation.ok) {
      state.operationsUi.lastSaveFeedback = `Missing required fields: ${validation.missing.join(', ')}`;
      state.operationsUi.lastSaveTone = 'error';
      rerender();
      return;
    }

    const saved = await actions.saveTask(payload.id || `${fd.get('id') || ''}`.trim(), payload);
    if (!saved) return;
    state.operationsUi.draft = {};
    state.operationsUi.moreDetailsOpen = false;
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
    actions.completeTask(taskId, closeout);
  }));

  el.querySelectorAll('[data-quick-status]').forEach((button) => button.addEventListener('click', async () => {
    state.operationsUi.scrollY = window.scrollY;
    const task = state.tasks.find((entry) => entry.id === button.dataset.quickStatus);
    const nextStatus = button.dataset.nextStatus;
    if (!task || !nextStatus) return;
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
