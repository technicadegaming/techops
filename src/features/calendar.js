export function renderCalendar(el, state) {
  el.innerHTML = `<h2>Calendar / PM</h2>
  <p class="tiny">PM schedule from shared Firestore data.</p>
  <div class="list">${state.pmSchedules.map((p) => `<div class="item"><b>${p.title || p.id}</b> · due ${p.dueDate || '-'} · ${p.status || 'open'}</div>`).join('')}</div>`;
}
