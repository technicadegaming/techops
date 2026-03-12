export function renderReports(el, state) {
  const completedTasks = state.tasks.filter((t) => t.status === 'completed').length;
  const completedOperations = state.operations.filter((o) => o.status === 'completed').length;
  el.innerHTML = `<h2>Reports</h2>
  <div class="item">Completed tasks: <b>${completedTasks}</b></div>
  <div class="item">Completed operations: <b>${completedOperations}</b></div>
  <div class="tiny">Export and restore are in Admin.</div>`;
}
