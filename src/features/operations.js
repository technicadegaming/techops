import { canDelete, canEditTasks } from '../roles.js';

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
}
