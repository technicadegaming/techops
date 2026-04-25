import { detectRepeatIssues } from './workflow.js';
import { buildLocationOptions, buildLocationSummary, getLocationSelection } from './locationContext.js';
import {
  PM_DUE_SOON_DAYS,
  buildAssetAttentionSummary,
  buildAssigneeWorkloadSummary,
  buildLocationComparisonSummary,
  buildPmHealthSummary,
  summarizePmByField
} from './reportingSummary.js';

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

export function renderReports(el, state, navigate = () => {}, applyFocus = () => {}) {
  state.reportsUi = { ...createDefaultReportsUiState(), ...(state.reportsUi || {}) };
  const now = new Date();
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

  const pmHealth = buildPmHealthSummary(pmSchedules, now);
  const assetById = new Map((scope.scopedAssets || []).map((asset) => [asset.id, asset]));
  const pmByLocation = summarizePmByField(pmSchedules, (schedule) => schedule.locationName || schedule.location || 'Unassigned location', now).slice(0, 6);
  const pmByAssetGroup = summarizePmByField(pmSchedules, (schedule) => {
    const linkedAsset = assetById.get(schedule.assetId);
    return linkedAsset?.category || schedule.assetCategory || 'Uncategorized assets';
  }, now).slice(0, 6);
  const assetAttention = buildAssetAttentionSummary(scopedTasks, scope.scopedAssets).slice(0, 8);
  const workload = buildAssigneeWorkloadSummary(scopedTasks, state.users || [], now).slice(0, 8);
  const locationComparison = buildLocationComparisonSummary(state, now).slice(0, 8);
  const completionRate = scopedTasks.length ? Math.round((completed.length / scopedTasks.length) * 100) : 0;
  const blockedRate = unresolved.length ? Math.round((blockedTasks.length / unresolved.length) * 100) : 0;
  const reportActiveFilters = [
    selection?.key && selection.key !== '__all_locations__' ? `location: ${selection.label}` : '',
    statusFilter !== 'open' ? `status: ${statusFilter.replace('_', ' ')}` : ''
  ].filter(Boolean);

  el.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Reports</h2>
        <p class="page-subtitle">Review operational trends, exports, and workspace data.</p>
      </div>
      <div class="kpi-line page-actions">
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
      <div class="row space mt">
        <div class="tiny">Active filters: ${reportActiveFilters.length ? reportActiveFilters.join(' · ') : 'default view (all locations, open tasks)'}</div>
        <div class="tiny">Result count: ${scopedTasks.length} tasks</div>
      </div>
    </div>

    <div class="kpi-line" style="margin-bottom:8px;">
      <span>Completion rate: ${completionRate}%</span>
      <span>Blocked share: ${blockedRate}% of unresolved</span>
      <span>AI follow-up backlog: ${followupTasks.length}</span>
    </div>

    <div class="stats-grid">
      <button class="stat-card ${pmHealth.overdue.length ? 'warn' : 'good'} report-jump" data-tab="calendar" data-focus="overdue_pm">
        <div class="tiny">Overdue PM</div>
        <strong>${pmHealth.overdue.length}</strong>
        <div class="tiny">${pmHealth.dueSoon.length} due in next ${PM_DUE_SOON_DAYS} days.</div>
      </button>
      <button class="stat-card ${repeat.length ? 'warn' : 'good'} report-jump" data-tab="operations" data-focus="priority">
        <div class="tiny">Recurring issue patterns</div>
        <strong>${repeat.length}</strong>
        <div class="tiny">${repeat.length ? 'Root-cause review recommended.' : 'No repeat patterns found.'}</div>
      </button>
      <button class="stat-card ${unresolvedBySeverity[0].count ? 'bad' : 'good'} report-jump" data-tab="operations" data-focus="critical">
        <div class="tiny">Critical unresolved</div>
        <strong>${unresolvedBySeverity[0].count}</strong>
        <div class="tiny">Highest-severity backlog in the selected scope.</div>
      </button>
      <button class="stat-card ${pmHealth.compliance < 85 ? 'warn' : 'good'} report-jump" data-tab="calendar">
        <div class="tiny">PM compliance</div>
        <strong>${pmHealth.compliance}%</strong>
        <div class="tiny">${pmHealth.completed} completed out of ${pmHealth.totalWithStatus} PM records.</div>
      </button>
    </div>

    ${scopedTasks.length ? '' : '<div class="inline-state success mt">No task data matches the current report filters yet.</div>'}

    <div class="report-alert-grid mt">
      <button class="report-alert-card report-jump" data-tab="operations" data-focus="overdue_open">
        <b>Overdue execution</b>
        <div class="tiny mt">${overdueTasks.length} task${overdueTasks.length === 1 ? '' : 's'} past age target</div>
      </button>
      <button class="report-alert-card report-jump" data-tab="operations" data-focus="blocked">
        <b>Blocked work</b>
        <div class="tiny mt">${blockedTasks.length} task${blockedTasks.length === 1 ? '' : 's'} slowed by assignment/follow-up blockers</div>
      </button>
      <button class="report-alert-card report-jump" data-tab="operations" data-focus="followup">
        <b>Follow-up queue</b>
        <div class="tiny mt">${followupTasks.length} task${followupTasks.length === 1 ? '' : 's'} waiting on AI follow-up answers</div>
      </button>
    </div>

    <div class="grid grid-2 mt">
      <div class="item">
        <div class="row space"><b>PM due soon / overdue by location</b><button class="filter-chip report-jump" data-tab="calendar" data-focus="due_soon_pm" type="button">Due soon list</button></div>
        ${pmByLocation.length
          ? `<div class="list mt">${pmByLocation.map((row) => `<button class="item tiny report-jump" data-tab="calendar" data-focus="${row.overdue ? 'overdue_pm' : 'due_soon_pm'}"><b>${row.label}</b> | overdue ${row.overdue} | due soon ${row.dueSoon} | compliance ${row.compliance}%</button>`).join('')}</div>`
          : '<div class="inline-state success mt">No PM records in this location scope.</div>'}
      </div>
      <div class="item">
        <div class="row space"><b>PM by asset group</b><button class="filter-chip report-jump" data-tab="assets" type="button">Asset view</button></div>
        ${pmByAssetGroup.length
          ? `<div class="list mt">${pmByAssetGroup.map((row) => `<div class="item tiny"><b>${row.label}</b> | overdue ${row.overdue} | due soon ${row.dueSoon} | compliance ${row.compliance}%</div>`).join('')}</div>`
          : '<div class="inline-state info mt">Add asset categories and PM links to improve this summary.</div>'}
      </div>
      <div class="item">
        <div class="row space"><b>Assets needing repeat/downtime attention</b><button class="filter-chip report-jump" data-tab="assets" type="button">Open assets</button></div>
        ${assetAttention.length
          ? `<div class="list mt">${assetAttention.map((row) => `<button class="item tiny report-jump" data-tab="assets" data-asset="${row.assetId || ''}"><b>${row.assetName}</b> | open ${row.openTasks} | recurring ${row.recurringTasks} | est downtime ${row.estimatedDowntimeHours}h${row.topCategories.length ? ` | patterns ${row.topCategories.join(', ')}` : ''}</button>`).join('')}</div>`
          : '<div class="inline-state success mt">No downtime/repeat concentration found for current filters.</div>'}
      </div>
      <div class="item">
        <div class="row space"><b>Technician workload</b><button class="filter-chip report-jump" data-tab="operations" data-focus="unassigned" type="button">Open operations</button></div>
        ${workload.length
          ? `<div class="list mt">${workload.map((row) => `<div class="item tiny"><div class="row space"><b>${row.label}</b><span>open ${row.open} · overdue ${row.overdue}</span></div><div class="tiny">critical open ${row.criticalOpen} · closed last 7d ${row.closedRecently}</div></div>`).join('')}</div>`
          : '<div class="inline-state success mt">No assignee workload records yet.</div>'}
      </div>
    </div>

    <div class="item mt">
      <div class="row space"><b>Location comparison (operational load)</b><button class="filter-chip report-jump" data-tab="dashboard" type="button">Dashboard</button></div>
      ${locationComparison.length
        ? `<div class="list mt">${locationComparison.map((row) => `<button class="item tiny report-location" data-location-key="${row.key}"><b>${row.label}</b> | open ${row.openWork} | overdue PM ${row.overduePm} | missing docs ${row.missingDocs} | recurring concentration ${row.recurringConcentration}</button>`).join('')}</div>`
        : '<div class="inline-state info mt">No named locations available for comparison yet.</div>'}
    </div>

    <div class="grid grid-2 mt">
      <div class="item">
        <b>Recurring issues</b>
        ${repeat.length
          ? `<div class="list mt">${repeat.map((entry) => `<button class="item tiny report-jump" data-tab="assets" data-asset="${entry.assetId || ''}"><b>${entry.issueCategory || 'uncategorized'}</b> | asset ${entry.assetId || 'n/a'} | repeated ${entry.count} times</button>`).join('')}</div>`
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

  const rerender = () => renderReports(el, state, navigate, applyFocus);
  el.querySelector('[data-reports-location]')?.addEventListener('change', (event) => {
    state.reportsUi.locationKey = `${event.target.value || ''}`.trim();
    rerender();
  });
  el.querySelectorAll('[data-report-status]').forEach((button) => button.addEventListener('click', () => {
    state.reportsUi.taskStatus = button.dataset.reportStatus || 'open';
    rerender();
  }));
  el.querySelectorAll('.report-jump').forEach((button) => button.addEventListener('click', () => {
    const focus = button.dataset.focus || null;
    if (focus) applyFocus(focus);
    navigate(button.dataset.tab, null, button.dataset.asset || null);
  }));
  el.querySelectorAll('.report-location').forEach((button) => button.addEventListener('click', () => {
    state.route = { ...(state.route || {}), locationKey: button.dataset.locationKey || null };
    navigate('dashboard');
  }));
}
