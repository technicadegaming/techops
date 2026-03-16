export function renderCalendar(el, state) {
  const pmFilter = state.route?.pmFilter || 'all';
  const now = Date.now();
  const rows = (state.pmSchedules || []).filter((p) => {
    if (pmFilter !== 'overdue') return true;
    if ((p.status || 'open') === 'completed' || !p.dueDate) return false;
    const due = new Date(p.dueDate).getTime();
    return Number.isFinite(due) && due < now;
  });
  el.innerHTML = `<h2>Calendar / PM</h2>
  <p class="tiny">PM schedule from shared Firestore data.</p>
  ${pmFilter === 'overdue' ? '<div class="inline-state warn">Showing overdue PM only.</div>' : ''}
  <div class="list">${rows.map((p) => `<div class="item"><b>${p.title || p.id}</b> · due ${p.dueDate || '-'} · ${p.status || 'open'}</div>`).join('') || '<div class="inline-state success">No PM items match this filter.</div>'}</div>`;
}
