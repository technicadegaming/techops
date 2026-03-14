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

function renderAiSourceLine(run) {
  const sourceList = Array.isArray(run?.documentationSources) ? run.documentationSources : [];
  const labels = new Set(sourceList.map((s) => s?.sourceType).filter(Boolean));
  const mode = labels.has('manual')
    ? 'manual-backed'
    : (labels.has('approved_doc') ? 'approved-doc-backed' : 'web/internal only');
  if (!sourceList.length && !run?.citations?.length) return `<div class="tiny">Sources used: ${mode}</div>`;
  const names = sourceList.slice(0, 3).map((s) => s.title || s.url).filter(Boolean);
  return `<div class="tiny">Sources used: ${mode}${names.length ? ` · ${names.join(' | ')}` : ''}</div>`;
}

function renderAiPanel(task, state) {
  const run = (state.taskAiRuns || []).find((r) => r.taskId === task.id);
  const followup = run ? (state.taskAiFollowups || []).find((f) => f.runId === run.id) : null;
  return `<div class="item mt"><b>AI Troubleshooting</b>
    <div class="tiny">Status: ${run?.status || 'not_started'} ${task.aiSummary?.summary ? `· ${task.aiSummary.summary}` : ''}</div>
    ${run ? renderAiSourceLine(run) : ''}
    ${run?.shortFrontlineVersion ? `<div class="tiny"><b>Frontline:</b> ${run.shortFrontlineVersion}</div>` : ''}
    ${run?.diagnosticSteps?.length ? `<div class="tiny"><b>Steps:</b> ${run.diagnosticSteps.join(' | ')}</div>` : ''}
    ${followup?.questions?.length ? `<form data-followup="${task.id}" data-run="${run.id}" class="grid">${followup.questions.map((q, i) => `<label class="tiny">${q}<input name="a${i}" placeholder="Answer" ${canAnswerAiFollowups(state.profile) ? '' : 'disabled'} /></label>`).join('')}<button ${canAnswerAiFollowups(state.profile) ? '' : 'disabled'}>Submit follow-up answers</button></form>` : ''}
    <div class="row mt">
      <button data-run-ai="${task.id}" ${canRunAiTroubleshooting(state.profile) ? '' : 'disabled'}>Run AI</button>
      <button data-rerun-ai="${task.id}" ${canRunAiTroubleshooting(state.profile) ? '' : 'disabled'}>Regenerate</button>
      <button data-save-fix="${task.id}" ${canSaveFixToLibrary(state.profile) ? '' : 'disabled'}>Save fix to library</button>
    </div>
  </div>`;
}

function renderCloseout(task, state) {
  if (task.status === 'completed' || !canCloseTasks(state.profile)) return '';
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
    scrollY: 0
  };
}

function readFormDraft(form) {
  if (!form) return {};
  return Object.fromEntries(new FormData(form).entries());
}

export function renderOperations(el, state, actions) {
  state.operationsUi = { ...createDefaultOperationsUiState(), ...(state.operationsUi || {}) };
  const editable = canEditTasks(state.profile);
  const expanded = new Set(state.operationsUi.expandedTaskIds || []);
  const assetById = new Map((state.assets || []).map((a) => [a.id, a]));
  const assetByName = new Map((state.assets || []).map((a) => [`${a.name || a.id}`.toLowerCase(), a]));

  el.innerHTML = `
    <div class="row space"><h2>Operations & Tasks</h2><div class="tiny">Structured intake enabled</div></div>
    <form id="taskForm" class="grid">
      <div class="grid grid-2">
        <label>Task ID<input name="id" readonly /></label>
        <label>Opened date/time<input name="openedAt" type="datetime-local" readonly /></label>
      </div>
      <label>Asset / game
        <input name="assetSearch" list="assetOptions" placeholder="Search by asset name" required ${editable ? '' : 'disabled'} />
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
          <input name="location" placeholder="Location / zone / area" ${editable ? '' : 'disabled'} />
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
      <datalist id="assetOptions">${state.assets.map((a) => `<option value="${a.name || a.id}"></option>`).join('')}</datalist>
    </form>
    <div class="list mt">
      ${state.tasks.map((t) => {
      const unavailable = (t.assignedWorkers || []).filter((w) => state.users.some((u) => (u.id === w || u.email === w) && (u.enabled === false || u.available === false)));
      const taskAsset = assetById.get(t.assetId);
      const friendlyAsset = taskAsset?.name || t.assetName || t.assetId || '-';
      const showTaskDetails = expanded.has(t.id);
      return `<details class="item ${state.route?.taskId === t.id ? 'selected' : ''}" id="task-${t.id}" data-task-details="${t.id}" ${showTaskDetails ? 'open' : ''}>
        <summary><b>${t.title || t.id}</b> · ${t.status || 'open'} · ${friendlyAsset}</summary>
        <div class="tiny">Assigned: ${(t.assignedWorkers || []).join(', ') || 'unassigned'} ${unavailable.length ? `· ⚠️ unavailable: ${unavailable.join(', ')}` : ''}</div>
        <div><b>Issue:</b> ${t.description || ''}</div>
        <div class="tiny">${t.issueCategory || 'uncategorized'} · ${t.severity || 'medium'} · tags: ${(t.symptomTags || []).join(', ') || 'none'}</div>
        ${renderCloseout(t, state)}
        ${renderAiPanel(t, state)}
        ${unavailable.length ? `<button data-reassign="${t.id}">Quick reassign</button>` : ''}
        ${canDelete(state.profile) ? `<button data-del="${t.id}" class="danger">Delete</button>` : ''}
      </details>`;
    }).join('')}
    </div>`;

  const form = el.querySelector('#taskForm');
  const idInput = form?.querySelector('[name="id"]');
  const openedAtInput = form?.querySelector('[name="openedAt"]');
  const assetInput = form?.querySelector('[name="assetSearch"]');
  const reporterInput = form?.querySelector('[name="reporter"]');
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
      existingIds: state.tasks.map((t) => t.id)
    });
    if (idInput && !idInput.value) idInput.value = nextId;
    if (openedAtInput && !openedAtInput.value) openedAtInput.value = getCurrentOpenedDateTimeValue(new Date());
    if (reporterInput && !reporterInput.value) reporterInput.value = state.user?.email || '';
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

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    persistDraft();
    const fd = new FormData(form);
    const selectedAsset = getSelectedAsset();
    const openedAtRaw = `${fd.get('openedAt') || ''}`.trim();
    const payload = normalizeTaskIntake({
      ...Object.fromEntries(fd.entries()),
      id: `${fd.get('id') || ''}`.trim(),
      assetId: selectedAsset?.id || '',
      openedAt: openedAtRaw ? new Date(openedAtRaw).toISOString() : new Date().toISOString(),
      createdAtClient: new Date().toISOString(),
      assetName: selectedAsset?.name || `${fd.get('assetSearch') || ''}`,
      assetKeySnapshot: buildAssetKey(selectedAsset?.id, selectedAsset?.name),
      reportedByUserId: state.user?.uid || '',
      reportedByEmail: state.user?.email || ''
    }, state.settings || {});
    const validation = validateTaskIntake(payload, ['assetId', 'description', 'reporter']);
    if (!validation.ok) return alert(`Missing required fields: ${validation.missing.join(', ')}`);

    await actions.saveTask(payload.id || `${fd.get('id') || ''}`.trim(), payload);
    state.operationsUi.draft = {};
    state.operationsUi.moreDetailsOpen = false;
  });

  el.querySelectorAll('[data-task-details]').forEach((taskDetails) => taskDetails.addEventListener('toggle', () => {
    const taskId = taskDetails.dataset.taskDetails;
    const current = new Set(state.operationsUi.expandedTaskIds || []);
    if (taskDetails.open) current.add(taskId);
    else current.delete(taskId);
    state.operationsUi.expandedTaskIds = [...current];
  }));

  el.querySelectorAll('[data-closeout]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    state.operationsUi.scrollY = window.scrollY;
    const taskId = f.dataset.closeout;
    const closeout = Object.fromEntries(new FormData(f).entries());
    actions.completeTask(taskId, closeout);
  }));

  el.querySelectorAll('[data-reassign]').forEach((btn) => btn.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.reassignTask(btn.dataset.reassign);
  }));
  el.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.deleteTask(btn.dataset.del);
  }));
  el.querySelectorAll('[data-run-ai]').forEach((btn) => btn.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.runAi(btn.dataset.runAi);
  }));
  el.querySelectorAll('[data-rerun-ai]').forEach((btn) => btn.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.rerunAi(btn.dataset.rerunAi);
  }));
  el.querySelectorAll('[data-save-fix]').forEach((btn) => btn.addEventListener('click', () => {
    state.operationsUi.scrollY = window.scrollY;
    actions.saveFix(btn.dataset.saveFix);
  }));
  el.querySelectorAll('[data-followup]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    state.operationsUi.scrollY = window.scrollY;
    const taskId = f.dataset.followup;
    const runId = f.dataset.run;
    const answers = [...new FormData(f).entries()].map(([, answer], idx) => ({ question: (state.taskAiFollowups.find((x) => x.runId === runId)?.questions || [])[idx] || `Question ${idx + 1}`, answer }));
    actions.submitFollowup(taskId, runId, answers);
  }));
}
