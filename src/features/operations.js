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

function renderAiPanel(task, state) {
  const run = (state.taskAiRuns || []).find((entry) => entry.taskId === task.id);
  const followup = run ? (state.taskAiFollowups || []).find((entry) => entry.runId === run.id) : null;
  return `<div class="item mt"><b>AI Troubleshooting</b>
    <div class="tiny">Status: ${run?.status || 'not_started'} ${task.aiSummary?.summary ? `| ${task.aiSummary.summary}` : ''}</div>
    ${run ? renderAiSourceLine(run) : ''}
    ${run?.shortFrontlineVersion ? `<div class="tiny"><b>Frontline:</b> ${run.shortFrontlineVersion}</div>` : ''}
    ${run?.diagnosticSteps?.length ? `<div class="tiny"><b>Steps:</b> ${run.diagnosticSteps.join(' | ')}</div>` : ''}
    ${followup?.questions?.length ? `<form data-followup="${task.id}" data-run="${run.id}" class="grid">${followup.questions.map((question, index) => `<label class="tiny">${question}<input name="a${index}" placeholder="Answer" ${canAnswerAiFollowups(state.permissions) ? '' : 'disabled'} /></label>`).join('')}<button ${canAnswerAiFollowups(state.permissions) ? '' : 'disabled'}>Submit follow-up answers</button></form>` : ''}
    <div class="row mt">
      <button data-run-ai="${task.id}" ${canRunAiTroubleshooting(state.permissions) ? '' : 'disabled'}>Run AI</button>
      <button data-rerun-ai="${task.id}" ${canRunAiTroubleshooting(state.permissions) ? '' : 'disabled'}>Regenerate</button>
      <button data-save-fix="${task.id}" ${canSaveFixToLibrary(state.permissions) ? '' : 'disabled'}>Save fix to library</button>
    </div>
  </div>`;
}

function renderCloseout(task, state) {
  if (task.status === 'completed' || !canCloseTasks(state.permissions)) return '';
  return `<details class="item mt"><summary><b>Close task workflow</b></summary>
    <form data-closeout="${task.id}" class="grid grid-2 mt">
      <input name="rootCause" placeholder="Root cause" required />
      <input name="fixPerformed" placeholder="Fix performed" required />
      <input name="partsUsed" placeholder="Parts used (comma-separated)" />
      <input name="toolsUsed" placeholder="Tools used (comma-separated)" />
      <input name="timeSpentMinutes" type="number" min="0" placeholder="Time spent (minutes)" />
      <input name="verification" placeholder="Testing / verification" />
      <select name="fullyResolved"><option value="yes">Fully resolved</option><option value="no">Partially resolved</option></select>
      <select name="saveToLibrary"><option value="">Use default</option><option value="yes">Save to troubleshooting library</option><option value="no">Do not save</option></select>
      <select name="aiHelpfulness"><option value="">AI helpfulness (optional)</option><option value="helpful">AI was helpful</option><option value="partial">AI partially helpful</option><option value="not_helpful">AI not helpful</option></select>
      <input name="bestFixSummary" placeholder="Best concise fix summary (optional)" />
      <input name="evidenceLink" placeholder="Photo/evidence URL (optional)" />
      <button class="primary">Complete task</button>
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
  const myIdentifiers = new Set([state.user?.uid, state.user?.email].filter(Boolean));
  return (tasks || []).filter((task) => {
    const assigned = task.assignedWorkers || [];
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
            ? (state.taskAiRuns || []).some((run) => run.taskId === task.id && run.status === 'followup_required')
            : true;
    return statusMatch && ownershipMatch;
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
  const scopedTasks = scope.scopedTasks;
  const scopedAssets = scope.scopedAssets;
  const openTasks = scope.openTasks;
  const visibleTasks = filterTasks(scopedTasks, state);
  const unassignedOpen = openTasks.filter((task) => !(task.assignedWorkers || []).length).length;
  const followupOpen = openTasks.filter((task) => (state.taskAiRuns || []).some((run) => run.taskId === task.id && run.status === 'followup_required')).length;
  const inProgress = scopedTasks.filter((task) => task.status === 'in_progress').length;

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
      <div class="stat-card ${unassignedOpen ? 'bad' : 'good'}">
        <div class="tiny">Unassigned open work</div>
        <strong>${unassignedOpen}</strong>
        <div class="tiny">${unassignedOpen ? 'Assign owners before this grows.' : 'Every open task has an owner.'}</div>
      </div>
      <div class="stat-card ${followupOpen ? 'warn' : 'good'}">
        <div class="tiny">AI follow-up queue</div>
        <strong>${followupOpen}</strong>
        <div class="tiny">${followupOpen ? 'Frontline answers are blocking next-step guidance.' : 'No follow-up backlog.'}</div>
      </div>
    </div>

    <div class="item" style="margin:12px 0;">
      <div class="row space">
        <div>
          <b>Location and quick filters</b>
          <div class="tiny">Use this view to isolate status, ownership, and open-work exceptions.</div>
        </div>
        <label class="tiny" style="min-width:220px;">Location
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

    <h3>Workflow board</h3>
    ${visibleTasks.length
      ? `<div class="list mt">
        ${visibleTasks.map((task) => {
          const unavailable = (task.assignedWorkers || []).filter((worker) => state.users.some((user) => (user.id === worker || user.email === worker) && (user.enabled === false || user.available === false)));
          const taskAsset = assetById.get(task.assetId);
          const friendlyAsset = taskAsset?.name || task.assetName || task.assetId || '-';
          const taskLocation = getTaskLocationRecord(state, task, assetById);
          const assetLocation = taskAsset ? getAssetLocationRecord(state, taskAsset) : null;
          const showTaskDetails = expanded.has(task.id);
          const needsFollowup = (state.taskAiRuns || []).some((run) => run.taskId === task.id && run.status === 'followup_required');
          return `<details class="item ${state.route?.taskId === task.id ? 'selected' : ''}" id="task-${task.id}" data-task-details="${task.id}" ${showTaskDetails ? 'open' : ''}>
            <summary><b>${task.title || task.id}</b> | ${task.status || 'open'} | ${friendlyAsset}</summary>
            <div class="kpi-line mt">
              <span>${taskLocation.label}</span>
              <span>${task.severity || 'medium'}</span>
              <span>${(task.assignedWorkers || []).join(', ') || 'unassigned'}</span>
              ${needsFollowup ? '<span>AI follow-up waiting</span>' : ''}
            </div>
            <div class="tiny mt">Asset location: ${assetLocation?.label || taskLocation.label}${assetLocation && assetLocation.label !== taskLocation.label ? ` | task reported at ${taskLocation.label}` : ''}</div>
            <div class="tiny">Assigned: ${(task.assignedWorkers || []).join(', ') || 'unassigned'} ${unavailable.length ? `| unavailable: ${unavailable.join(', ')}` : ''}</div>
            <div><b>Issue:</b> ${task.description || ''}</div>
            <div class="tiny">${task.issueCategory || 'uncategorized'} | tags: ${(task.symptomTags || []).join(', ') || 'none'}</div>
            ${renderCloseout(task, state)}
            ${renderAiPanel(task, state)}
            ${unavailable.length ? `<button data-reassign="${task.id}">Quick reassign</button>` : ''}
            ${canDelete(state.permissions) ? `<button data-del="${task.id}" class="danger">Delete</button>` : ''}
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
