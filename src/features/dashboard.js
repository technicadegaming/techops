export function renderDashboard(el, state, navigate) {
  const openTasks = state.tasks.filter((t) => t.status !== 'completed').length;
  const openOps = state.operations.filter((o) => o.status !== 'completed').length;
  const duePm = state.pmSchedules.filter((p) => p.status !== 'completed').length;
  el.innerHTML = `
    <h2>Dashboard</h2>
    <div class="grid grid-2">
      <div class="item"><b>Open Tasks:</b> ${openTasks}</div>
      <div class="item"><b>Open Operations:</b> ${openOps}</div>
      <div class="item"><b>Assets:</b> ${state.assets.length}</div>
      <div class="item"><b>PM Queue:</b> ${duePm}</div>
    </div>
    <h3>Quick queue links</h3>
    <div class="list">
      ${state.tasks.slice(0, 8).map((t) => `<button class="item jump" data-tab="operations" data-id="${t.id}">${t.title || t.id} (${t.status || 'open'})</button>`).join('')}
    </div>`;
  el.querySelectorAll('.jump').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.tab, b.dataset.id)));
}
