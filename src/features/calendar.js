import { buildPmHealthSummary, isPmDueSoon, isPmOverdue, summarizePmByField } from './reportingSummary.js';

export function renderCalendar(el, state) {
  const pmFilter = state.route?.pmFilter || 'all';
  const now = new Date();
  const allRows = state.pmSchedules || [];
  const rows = allRows.filter((p) => {
    if (pmFilter === 'overdue') return isPmOverdue(p, now);
    if (pmFilter === 'due_soon') return isPmDueSoon(p, now);
    return true;
  });
  const health = buildPmHealthSummary(allRows, now);
  const assetById = new Map((state.assets || []).map((asset) => [asset.id, asset]));
  const byLocation = summarizePmByField(allRows, (schedule) => schedule.locationName || schedule.location || 'Unassigned location', now).slice(0, 6);
  const byAssetGroup = summarizePmByField(allRows, (schedule) => assetById.get(schedule.assetId)?.category || schedule.assetCategory || 'Uncategorized assets', now).slice(0, 6);

  el.innerHTML = `<div class="page-shell page-narrow"><div class="page-header">
    <div>
      <h2 class="page-title">Calendar & PM</h2>
      <p class="page-subtitle">Track upcoming maintenance, overdue work, and scheduled service.</p>
    </div>
  </div>
  <div class="kpi-line"><span>Open PM: ${health.open.length}</span><span>Overdue: ${health.overdue.length}</span><span>Due soon: ${health.dueSoon.length}</span><span>Compliance: ${health.compliance}%</span></div>
  <div class="filter-row mt">
    <button class="filter-chip ${pmFilter === 'all' ? 'active' : ''}" data-pm-filter="all" type="button">All PM</button>
    <button class="filter-chip ${pmFilter === 'due_soon' ? 'active' : ''}" data-pm-filter="due_soon" type="button">Due soon</button>
    <button class="filter-chip ${pmFilter === 'overdue' ? 'active' : ''}" data-pm-filter="overdue" type="button">Overdue</button>
  </div>
  ${pmFilter === 'overdue' ? '<div class="inline-state warn mt">Showing overdue PM only.</div>' : ''}
  ${pmFilter === 'due_soon' ? '<div class="inline-state info mt">Showing PM due in next 7 days.</div>' : ''}
  <div class="grid grid-2 mt">
    <div class="item"><b>By location</b>${byLocation.length ? `<div class="list mt">${byLocation.map((row) => `<div class="item tiny"><b>${row.label}</b> | overdue ${row.overdue} | due soon ${row.dueSoon} | compliance ${row.compliance}%</div>`).join('')}</div>` : '<div class="inline-state success mt">No scheduled maintenance yet for current locations.</div><div class="tiny mt">Create PM schedules from asset records to start tracking preventive work.</div>'}</div>
    <div class="item"><b>By asset group</b>${byAssetGroup.length ? `<div class="list mt">${byAssetGroup.map((row) => `<div class="item tiny"><b>${row.label}</b> | overdue ${row.overdue} | due soon ${row.dueSoon} | compliance ${row.compliance}%</div>`).join('')}</div>` : '<div class="inline-state info mt">No PM group trends yet.</div><div class="tiny mt">Assign asset groups/categories and add PM schedules to build this view.</div>'}</div>
  </div>
  <div class="list mt">${rows.map((p) => `<div class="item"><b>${p.title || p.id}</b> · due ${p.dueDate || '-'} · ${p.status || 'open'} · ${p.locationName || p.location || 'Unassigned location'}</div>`).join('') || '<div class="inline-state success">No scheduled maintenance yet.</div><div class="tiny">Create PM schedules from asset records to start tracking preventive work.</div>'}</div></div>`;

  el.querySelectorAll('[data-pm-filter]').forEach((button) => button.addEventListener('click', () => {
    state.route = { ...(state.route || {}), pmFilter: button.dataset.pmFilter || 'all' };
    renderCalendar(el, state);
  }));
}
