import { detectRepeatIssues } from './workflow.js';
import { buildLocationSummary, getLocationEmptyState, getLocationScopeLabel } from './locationContext.js';

function isPmOverdue(schedule, now = new Date()) {
  if (!schedule?.dueDate || schedule.status === 'completed') return false;
  const due = new Date(schedule.dueDate);
  return !Number.isNaN(due.getTime()) && due < now;
}

function isPmDueSoon(schedule, now = new Date()) {
  if (!schedule?.dueDate || schedule.status === 'completed') return false;
  const due = new Date(schedule.dueDate);
  if (Number.isNaN(due.getTime())) return false;
  const diffDays = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= 7;
}

export function renderDashboard(el, state, navigate) {
  const now = new Date();
  const scope = buildLocationSummary(state);
  const openTasks = scope.openTasks;
  const critical = scope.openCriticalTasks;
  const repeat = detectRepeatIssues(scope.scopedTasks || []);
  const needsFollowup = (state.taskAiRuns || []).filter((run) => run.status === 'followup_required');
  const completedToday = (scope.scopedTasks || []).filter((task) => task.status === 'completed').slice(0, 5);
  const pmSchedules = (state.pmSchedules || []).filter((schedule) => {
    const locationName = `${schedule.locationName || schedule.location || ''}`.trim().toLowerCase();
    if (!scope.selection?.name || scope.selection?.key === '__all_locations__') return true;
    if (scope.selection.key === '__unassigned_location__') return !locationName;
    return locationName === `${scope.selection.name || ''}`.trim().toLowerCase();
  });
  const overduePm = pmSchedules.filter((schedule) => isPmOverdue(schedule, now));
  const dueSoonPm = pmSchedules.filter((schedule) => isPmDueSoon(schedule, now));
  const openPm = pmSchedules.filter((schedule) => schedule.status !== 'completed');
  const workload = (state.users || [])
    .filter((user) => user.enabled !== false)
    .map((user) => ({
      user,
      count: openTasks.filter((task) => (task.assignedWorkers || []).includes(user.id) || (task.assignedWorkers || []).includes(user.email)).length
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  el.innerHTML = `
    <div class="row space">
      <div>
        <h2>Dashboard</h2>
        <div class="tiny">${getLocationScopeLabel(scope.selection)}</div>
      </div>
      <div class="kpi-line">
        <span>Assets here: ${scope.scopedAssets.length}</span>
        <span>Broken assets: ${scope.brokenAssets.length}</span>
        <span>Open work: ${openTasks.length}</span>
      </div>
    </div>

    <div class="stats-grid">
      <button class="stat-card ${critical.length ? 'bad' : 'good'} jump" data-tab="operations">
        <div class="tiny">Critical work orders</div>
        <strong>${critical.length}</strong>
        <div class="tiny">${critical.length ? 'Immediate follow-up recommended.' : 'No critical tasks open.'}</div>
      </button>
      <button class="stat-card ${overduePm.length ? 'warn' : 'good'} jump" data-tab="calendar">
        <div class="tiny">Overdue preventive maintenance</div>
        <strong>${overduePm.length}</strong>
        <div class="tiny">${dueSoonPm.length} due in the next 7 days</div>
      </button>
      <button class="stat-card ${repeat.length ? 'warn' : 'good'} jump" data-tab="assets">
        <div class="tiny">Repeat-failure watchlist</div>
        <strong>${new Set(repeat.map((entry) => entry.assetId).filter(Boolean)).size}</strong>
        <div class="tiny">${repeat.length ? 'Recurring issue patterns detected.' : 'No repeat patterns in scope.'}</div>
      </button>
      <button class="stat-card ${needsFollowup.length ? 'warn' : 'good'} jump" data-tab="operations">
        <div class="tiny">Workflow follow-ups waiting</div>
        <strong>${needsFollowup.length}</strong>
        <div class="tiny">${needsFollowup.length ? 'AI runs need frontline answers.' : 'No follow-up backlog.'}</div>
      </button>
      <button class="stat-card ${scope.assetsWithoutDocs.length ? 'warn' : 'good'} jump" data-tab="assets">
        <div class="tiny">Assets missing docs</div>
        <strong>${scope.assetsWithoutDocs.length}</strong>
        <div class="tiny">Focus documentation work where repeat failures are showing up.</div>
      </button>
      <div class="stat-card ${completedToday.length ? 'good' : ''}">
        <div class="tiny">Recent completions</div>
        <strong>${completedToday.length}</strong>
        <div class="tiny">${completedToday.map((task) => task.id).join(' | ') || 'No completed work in this scope yet.'}</div>
      </div>
    </div>

    <div class="grid grid-2 mt">
      <div class="item">
        <div class="row space">
          <b>Preventive maintenance focus</b>
          <button class="filter-chip jump" data-tab="calendar" type="button">Open PM list</button>
        </div>
        ${openPm.length
          ? `<div class="kpi-line mt"><span>Open PM: ${openPm.length}</span><span>Overdue: ${overduePm.length}</span><span>Due soon: ${dueSoonPm.length}</span></div>
             <div class="list mt">${openPm.slice(0, 5).map((schedule) => `<div class="item tiny"><b>${schedule.title || schedule.id}</b> | due ${schedule.dueDate || 'not set'} | ${schedule.status || 'open'}</div>`).join('')}</div>`
          : `<div class="inline-state success mt">No open PM items in this scope.</div>`}
      </div>
      <div class="item">
        <div class="row space">
          <b>Workflow visibility</b>
          <button class="filter-chip jump" data-tab="operations" type="button">Open task board</button>
        </div>
        ${openTasks.length
          ? `<div class="kpi-line mt"><span>Open: ${openTasks.length}</span><span>Critical: ${critical.length}</span><span>Unassigned: ${openTasks.filter((task) => !(task.assignedWorkers || []).length).length}</span></div>
             <div class="list mt">${openTasks.slice(0, 5).map((task) => `<button class="item jump" data-tab="operations" data-id="${task.id}"><b>${task.title || task.id}</b><div class="tiny">${task.status || 'open'} | ${task.severity || 'medium'} | ${(task.assignedWorkers || []).join(', ') || 'unassigned'}</div></button>`).join('')}</div>`
          : `<div class="inline-state success mt">${getLocationEmptyState(scope.selection, 'open work orders', 'open work order')}</div>`}
      </div>
    </div>

    <h3>Staff workload snapshot</h3>
    ${workload.length
      ? `<div class="list">${workload.map((row) => `<div class="item tiny"><b>${row.user.email || row.user.id}</b> | ${row.user.role || 'staff'} | open workload ${row.count} | ${row.user.available === false ? 'unavailable' : 'available'}</div>`).join('')}</div>`
      : '<div class="inline-state info">No active staff records are available for workload balancing yet.</div>'}

    <h3>Recurring-problem watchlist</h3>
    ${repeat.length
      ? `<div class="list">${repeat.slice(0, 6).map((entry) => `<button class="item jump" data-tab="assets" data-asset="${entry.assetId}"><b>${entry.assetId || 'Unknown asset'}</b><div class="tiny">${entry.issueCategory || 'uncategorized'} | repeated ${entry.count} times</div></button>`).join('')}</div>`
      : '<div class="inline-state success">No repeat issues detected in the current scope.</div>'}
  `;

  el.querySelectorAll('.jump').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.tab, button.dataset.id || null, button.dataset.asset || null)));
}
