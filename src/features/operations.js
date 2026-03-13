import { canDelete, canEditTasks, canRunAiTroubleshooting, canAnswerAiFollowups, canSaveFixToLibrary, canCloseTasks } from '../roles.js';
import { normalizeTaskIntake, validateTaskIntake } from './workflow.js';

function renderAiPanel(task, state) {
  const run = (state.taskAiRuns || []).find((r) => r.taskId === task.id);
  const followup = run ? (state.taskAiFollowups || []).find((f) => f.runId === run.id) : null;
  return `<div class="item mt"><b>AI Troubleshooting</b>
    <div class="tiny">Status: ${run?.status || 'not_started'} ${task.aiSummary?.summary ? `· ${task.aiSummary.summary}` : ''}</div>
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

export function renderOperations(el, state, actions) {
  const editable = canEditTasks(state.profile);
  el.innerHTML = `
    <div class="row space"><h2>Operations & Tasks</h2><div class="tiny">Structured intake enabled</div></div>
    <form id="taskForm" class="grid grid-2">
      <input name="id" placeholder="Task ID" required ${editable ? '' : 'disabled'} />
      <input name="title" placeholder="Task title" required ${editable ? '' : 'disabled'} />
      <input name="assetId" list="assetOptions" placeholder="Asset / game" required ${editable ? '' : 'disabled'} />
      <input name="location" placeholder="Location / zone / area" ${editable ? '' : 'disabled'} />
      <input name="issueCategory" placeholder="Issue category" required ${editable ? '' : 'disabled'} />
      <input name="symptomTags" placeholder="Symptom tags (comma-separated)" ${editable ? '' : 'disabled'} />
      <input name="symptomTagsExtra" placeholder="Additional symptoms" ${editable ? '' : 'disabled'} />
      <select name="severity" ${editable ? '' : 'disabled'}><option>critical</option><option>high</option><option selected>medium</option><option>low</option></select>
      <input name="customerImpact" placeholder="Customer impact" ${editable ? '' : 'disabled'} />
      <input name="errorText" placeholder="Observed error text/code" ${editable ? '' : 'disabled'} />
      <input name="startedAt" type="datetime-local" ${editable ? '' : 'disabled'} />
      <select name="occurrence" ${editable ? '' : 'disabled'}><option value="constant">Constant</option><option value="intermittent">Intermittent</option></select>
      <select name="reproducible" ${editable ? '' : 'disabled'}><option value="yes">Reproducible</option><option value="no">Not reproducible</option><option value="unknown">Unknown</option></select>
      <input name="alreadyTried" placeholder="What already tried" ${editable ? '' : 'disabled'} />
      <input name="visibleCondition" placeholder="Visible condition notes" ${editable ? '' : 'disabled'} />
      <input name="assignedWorkers" placeholder="Assigned worker IDs/emails (comma-separated)" ${editable ? '' : 'disabled'} />
      <input name="reporter" placeholder="Reporter" ${editable ? '' : 'disabled'} />
      <select name="status" ${editable ? '' : 'disabled'}><option>open</option><option>in_progress</option><option>completed</option></select>
      <textarea name="description" placeholder="Freeform description (auto-generated if blank)" ${editable ? '' : 'disabled'}></textarea>
      <textarea name="notes" placeholder="Optional notes" ${editable ? '' : 'disabled'}></textarea>
      <button class="primary" ${editable ? '' : 'disabled'}>Save task</button>
      <datalist id="assetOptions">${state.assets.map((a) => `<option value="${a.id}">${a.name || a.id}</option>`).join('')}</datalist>
    </form>
    <div class="list mt">
      ${state.tasks.map((t) => {
      const unavailable = (t.assignedWorkers || []).filter((w) => state.users.some((u) => (u.id === w || u.email === w) && (u.enabled === false || u.available === false)));
      return `<div class="item ${state.route?.taskId === t.id ? 'selected' : ''}" id="task-${t.id}"><b>${t.title || t.id}</b> · ${t.status || 'open'} · asset ${t.assetId || '-'}
      <div class="tiny">${t.issueCategory || 'uncategorized'} · ${t.severity || 'medium'} · Assigned: ${(t.assignedWorkers || []).join(', ') || 'unassigned'} ${unavailable.length ? `· ⚠️ unavailable: ${unavailable.join(', ')}` : ''}</div>
      <div class="tiny">${(t.symptomTags || []).join(', ')}</div>
      <div class="tiny">${t.description || ''}</div>
      ${renderCloseout(t, state)}
      ${renderAiPanel(t, state)}
      ${unavailable.length ? `<button data-reassign="${t.id}">Quick reassign</button>` : ''}
      ${canDelete(state.profile) ? `<button data-del="${t.id}" class="danger">Delete</button>` : ''}
      </div>`; }).join('')}
    </div>`;

  const form = el.querySelector('#taskForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = normalizeTaskIntake(Object.fromEntries(fd.entries()), state.settings || {});
    const validation = validateTaskIntake({ ...payload, id: fd.get('id') }, state.settings.taskIntakeRequiredFields || undefined);
    if (!validation.ok) return alert(`Missing required fields: ${validation.missing.join(', ')}`);
    actions.saveTask(fd.get('id'), payload);
    form.reset();
  });

  el.querySelectorAll('[data-closeout]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const taskId = f.dataset.closeout;
    const closeout = Object.fromEntries(new FormData(f).entries());
    actions.completeTask(taskId, closeout);
  }));

  el.querySelectorAll('[data-reassign]').forEach((btn) => btn.addEventListener('click', () => actions.reassignTask(btn.dataset.reassign)));
  el.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => actions.deleteTask(btn.dataset.del)));
  el.querySelectorAll('[data-run-ai]').forEach((btn) => btn.addEventListener('click', () => actions.runAi(btn.dataset.runAi)));
  el.querySelectorAll('[data-rerun-ai]').forEach((btn) => btn.addEventListener('click', () => actions.rerunAi(btn.dataset.rerunAi)));
  el.querySelectorAll('[data-save-fix]').forEach((btn) => btn.addEventListener('click', () => actions.saveFix(btn.dataset.saveFix)));
  el.querySelectorAll('[data-followup]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const taskId = f.dataset.followup;
    const runId = f.dataset.run;
    const answers = [...new FormData(f).entries()].map(([, answer], idx) => ({ question: (state.taskAiFollowups.find((x) => x.runId === runId)?.questions || [])[idx] || `Question ${idx + 1}`, answer }));
    actions.submitFollowup(taskId, runId, answers);
  }));
}
