import { canDelete, canEditTasks, canRunAiTroubleshooting, canAnswerAiFollowups, canSaveFixToLibrary } from '../roles.js';

function renderAiPanel(task, state, editable) {
  const run = (state.taskAiRuns || []).find((r) => r.taskId === task.id);
  const followup = run ? (state.taskAiFollowups || []).find((f) => f.runId === run.id) : null;
  return `<div class="item mt"><b>AI Troubleshooting</b>
    <div class="tiny">Status: ${run?.status || 'not_started'} ${task.aiSummary?.summary ? `· ${task.aiSummary.summary}` : ''}</div>
    ${run?.probableCauses?.length ? `<div class="tiny"><b>Probable causes:</b> ${run.probableCauses.join('; ')}</div>` : ''}
    ${run?.diagnosticSteps?.length ? `<div class="tiny"><b>Steps:</b> ${run.diagnosticSteps.join(' | ')}</div>` : ''}
    ${run?.toolsNeeded?.length ? `<div class="tiny"><b>Tools:</b> ${run.toolsNeeded.join(', ')}</div>` : ''}
    ${run?.partsPossiblyNeeded?.length ? `<div class="tiny"><b>Parts:</b> ${run.partsPossiblyNeeded.join(', ')}</div>` : ''}
    ${run?.confidence !== undefined ? `<div class="tiny"><b>Confidence:</b> ${Math.round(run.confidence * 100)}%</div>` : ''}
    ${followup?.questions?.length ? `<form data-followup="${task.id}" data-run="${run.id}" class="grid">${followup.questions.map((q, i) => `<label class="tiny">${q}<input name="a${i}" placeholder="Answer" ${canAnswerAiFollowups(state.profile) ? '' : 'disabled'} /></label>`).join('')}<button ${canAnswerAiFollowups(state.profile) ? '' : 'disabled'}>Submit follow-up answers</button></form>` : ''}
    <div class="row mt">
      <button data-run-ai="${task.id}" ${canRunAiTroubleshooting(state.profile) ? '' : 'disabled'}>Run AI Troubleshooting</button>
      <button data-rerun-ai="${task.id}" ${canRunAiTroubleshooting(state.profile) ? '' : 'disabled'}>Regenerate</button>
      <button data-save-fix="${task.id}" ${canSaveFixToLibrary(state.profile) ? '' : 'disabled'}>Save useful fix to library</button>
    </div>
  </div>`;
}

export function renderOperations(el, state, actions) {
  const editable = canEditTasks(state.profile);
  el.innerHTML = `
    <div class="row space"><h2>Operations & Tasks</h2></div>
    <form id="taskForm" class="grid grid-2">
      <input name="id" placeholder="Task ID" required ${editable ? '' : 'disabled'} />
      <input name="title" placeholder="Task title" required ${editable ? '' : 'disabled'} />
      <input name="assetId" placeholder="Linked Asset ID" ${editable ? '' : 'disabled'} />
      <select name="status" ${editable ? '' : 'disabled'}><option>open</option><option>in_progress</option><option>completed</option></select>
      <textarea name="notes" placeholder="Notes" ${editable ? '' : 'disabled'}></textarea>
      <button class="primary" ${editable ? '' : 'disabled'}>Save task</button>
    </form>
    <div class="list mt">
      ${state.tasks.map((t) => `<div class="item" id="task-${t.id}"><b>${t.title || t.id}</b> · ${t.status || 'open'} · asset ${t.assetId || '-'}
      <div class="tiny">${t.notes || ''}</div>
      <div class="tiny">AI: ${t.aiSummary?.status || 'queued/running/follow-up needed/completed will appear here'}</div>
      ${renderAiPanel(t, state, editable)}
      ${canDelete(state.profile) ? `<button data-del="${t.id}" class="danger">Delete</button>` : ''}
      </div>`).join('')}
    </div>`;

  const form = el.querySelector('#taskForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    actions.saveTask(payload.id, payload);
    form.reset();
  });

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
