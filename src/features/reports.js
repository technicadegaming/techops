import { detectRepeatIssues } from './workflow.js';
import { buildLocationOptions, buildLocationSummary, getLocationSelection } from './locationContext.js';

function getTaskAgeHours(task) {
  const openedAt = new Date(task.openedAt || task.createdAtClient || task.updatedAt || task.updatedAtClient || 0);
  if (Number.isNaN(openedAt.getTime())) return 0;
  return (Date.now() - openedAt.getTime()) / (1000 * 60 * 60);
}

function getOverdueThresholdHours(severity = 'medium') {
  if (severity === 'critical') return 4;
  if (severity === 'high') return 24;
  if (severity === 'low') return 168;
  return 72;
}

function isTaskOverdue(task) {
  if (task.status === 'completed') return false;
  return getTaskAgeHours(task) >= getOverdueThresholdHours(task.severity || 'medium');
}

function isTaskBlocked(task, state) {
  if (task.status === 'completed') return false;
  const assigned = task.assignedWorkers || [];
  const unavailable = assigned.filter((worker) => state.users.some((user) => (
    (user.id === worker || user.email === worker) && (user.enabled === false || user.available === false)
  )));
  const needsFollowup = (state.taskAiRuns || []).some((run) => run.taskId === task.id && run.status === 'followup_required');
  return needsFollowup || unavailable.length > 0 || (task.status === 'in_progress' && assigned.length === 0);
}

function createDefaultReportsUiState() {
  return {
    locationKey: '',
    taskStatus: 'open'
  };
}

function getSelectionForReports(state) {
  const locationKey = `${state.reportsUi?.locationKey || ''}`.trim();
  if (!locationKey) return getLocationSelection(state);
  return buildLocationOptions(state).find((option) => option.key === locationKey) || getLocationSelection(state);
}

export function renderReports(el, state) {
  state.reportsUi = { ...createDefaultReportsUiState(), ...(state.reportsUi || {}) };
  const selection = getSelectionForReports(state);
  const scope = buildLocationSummary(state, selection);
  const statusFilter = state.reportsUi.taskStatus || 'open';
  const scopedTasks = (scope.scopedTasks || []).filter((task) => (
    statusFilter === 'all'
      ? true
      : statusFilter === 'open'
        ? task.status !== 'completed'
        : task.status === statusFilter
  ));
  const completed = scopedTasks.filter((task) => task.status === 'completed');
  const unresolved = scopedTasks.filter((task) => task.status !== 'completed');
  const overdueTasks = unresolved.filter((task) => isTaskOverdue(task));
  const blockedTasks = unresolved.filter((task) => isTaskBlocked(task, state));
  const followupTasks = unresolved.filter((task) => (state.taskAiRuns || []).some((run) => run.taskId === task.id && run.status === 'followup_required'));
  const unresolvedBySeverity = ['critical', 'high', 'medium', 'low'].map((severity) => ({
    severity,
    count: unresolved.filter((task) => (task.severity || 'medium') === severity).length
  }));
  const averageCloseByCategory = Object.values(completed.reduce((acc, task) => {
    const category = task.issueCategory || 'uncategorized';
    const time = Number(task.closeout?.timeSpentMinutes || 0);
    const entry = acc[category] || { category, total: 0, count: 0 };
    entry.total += time;
    entry.count += 1;
    acc[category] = entry;
    return acc;
  }, {})).map((row) => ({ ...row, avg: row.count ? Math.round(row.total / row.count) : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  const aiHelpfulness = completed.reduce((acc, task) => {
    const value = task.closeout?.aiHelpfulness;
    if (!value) return acc;
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
  const repeat = detectRepeatIssues(scopedTasks || []).slice(0, 8);
  const pmSchedules = (state.pmSchedules || []).filter((schedule) => {
    if (!selection?.name || selection.key === '__all_locations__') return true;
    const locationName = `${schedule.locationName || schedule.location || ''}`.trim().toLowerCase();
    if (selection.key === '__unassigned_location__') return !locationName;
    return locationName === `${selection.name || ''}`.trim().toLowerCase();
  });
  const pmOpen = pmSchedules.filter((schedule) => schedule.status !== 'completed');

  el.innerHTML = `
    <div class="row space">
      <div>
        <h2>Reports</h2>
        <div class="tiny">Summary view for downtime, closeout quality, and preventive-maintenance exposure.</div>
      </div>
      <div class="kpi-line">
        <span>Tasks in scope: ${scopedTasks.length}</span>
        <span>Completed: ${completed.length}</span>
        <span>Open: ${unresolved.length}</span>
      </div>
    </div>

    <div class="item" style="margin:12px 0;">
      <div class="row space">
        <label class="tiny" style="min-width:220px;">Report location
          <select data-reports-location>
            ${buildLocationOptions(state).map((option) => `<option value="${option.key}" ${option.key === selection?.key ? 'selected' : ''}>${option.label}</option>`).join('')}
          </select>
        </label>
        <div class="filter-row">
          <button class="filter-chip ${statusFilter === 'open' ? 'active' : ''}" data-report-status="open" type="button">Open work</button>
          <button class="filter-chip ${statusFilter === 'completed' ? 'active' : ''}" data-report-status="completed" type="button">Completed</button>
          <button class="filter-chip ${statusFilter === 'in_progress' ? 'active' : ''}" data-report-status="in_progress" type="button">In progress</button>
          <button class="filter-chip ${statusFilter === 'all' ? 'active' : ''}" data-report-status="all" type="button">All tasks</button>
        </div>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card ${unresolvedBySeverity[0].count ? 'bad' : 'good'}">
        <div class="tiny">Critical unresolved</div>
        <strong>${unresolvedBySeverity[0].count}</strong>
        <div class="tiny">Highest-severity backlog in the selected scope.</div>
      </div>
      <div class="stat-card ${repeat.length ? 'warn' : 'good'}">
        <div class="tiny">Recurring issue patterns</div>
        <strong>${repeat.length}</strong>
        <div class="tiny">${repeat.length ? 'Patterns worth root-cause review.' : 'No repeat patterns found.'}</div>
      </div>
      <div class="stat-card ${pmOpen.length ? 'warn' : 'good'}">
        <div class="tiny">Open PM items</div>
        <strong>${pmOpen.length}</strong>
        <div class="tiny">${pmSchedules.length} PM records in the selected scope.</div>
      </div>
    </div>

    ${scopedTasks.length ? '' : '<div class="inline-state success mt">No task data matches the current report filters yet.</div>'}

    <div class="report-alert-grid mt">
      <div class="report-alert-card">
        <b>Overdue execution</b>
        <div class="tiny mt">${overdueTasks.length} task${overdueTasks.length === 1 ? '' : 's'} past age target</div>
      </div>
      <div class="report-alert-card">
        <b>Blocked work</b>
        <div class="tiny mt">${blockedTasks.length} task${blockedTasks.length === 1 ? '' : 's'} slowed by owner or follow-up blockers</div>
      </div>
      <div class="report-alert-card">
        <b>Follow-up queue</b>
        <div class="tiny mt">${followupTasks.length} task${followupTasks.length === 1 ? '' : 's'} waiting on AI follow-up answers</div>
      </div>
    </div>

    <div class="grid grid-2 mt">
      <div class="item">
        <b>Recurring issues</b>
        ${repeat.length
          ? `<div class="list mt">${repeat.map((entry) => `<div class="item tiny"><b>${entry.issueCategory || 'uncategorized'}</b> | asset ${entry.assetId || 'n/a'} | repeated ${entry.count} times</div>`).join('')}</div>`
          : '<div class="inline-state success mt">No repeat-failure clusters in this view.</div>'}
      </div>
      <div class="item">
        <b>AI helpfulness feedback</b>
        ${completed.length
          ? `<div class="kpi-line mt"><span>Helpful: ${aiHelpfulness.helpful || 0}</span><span>Partial: ${aiHelpfulness.partial || 0}</span><span>Not helpful: ${aiHelpfulness.not_helpful || 0}</span></div>`
          : '<div class="inline-state info mt">Close a few tasks with AI helpfulness ratings to make this trend useful.</div>'}
      </div>
      <div class="item">
        <b>Average time to close by category</b>
        ${averageCloseByCategory.length
          ? `<div class="list mt">${averageCloseByCategory.map((row) => `<div class="item tiny"><b>${row.category}</b> | avg ${row.avg} min across ${row.count} closeouts</div>`).join('')}</div>`
          : '<div class="inline-state info mt">No completed tasks with time spent recorded yet.</div>'}
      </div>
      <div class="item">
        <b>Unresolved tasks by severity</b>
        <div class="list mt">${unresolvedBySeverity.map((row) => `<div class="item tiny"><b>${row.severity}</b> | ${row.count} task${row.count === 1 ? '' : 's'}</div>`).join('')}</div>
      </div>
    </div>
  `;

  const rerender = () => renderReports(el, state);
  el.querySelector('[data-reports-location]')?.addEventListener('change', (event) => {
    state.reportsUi.locationKey = `${event.target.value || ''}`.trim();
    rerender();
  });
  el.querySelectorAll('[data-report-status]').forEach((button) => button.addEventListener('click', () => {
    state.reportsUi.taskStatus = button.dataset.reportStatus || 'open';
    rerender();
  }));
}
