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
    taskStatus: 'open',
    checklistDate: '',
    checklistType: 'all',
    checklistWorker: 'all'
  };
}

function toCsvCell(value) {
  const text = `${value == null ? '' : value}`;
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadChecklistCsv(rows = []) {
  const header = ['date', 'location', 'checklistType', 'totalItems', 'signedItems', 'lateSignedItems', 'missedUnsignedItems', 'completionPct'];
  const lines = rows.map((row) => header.map((key) => toCsvCell(row[key])).join(','));
  const csv = `${header.join(',')}\n${lines.join('\n')}`;
  const link = document.createElement('a');
  link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  link.download = `checklist-accountability-${Date.now()}.csv`;
  link.click();
}

function toIsoDate(value) {
  const parsed = new Date(value || 0);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function getSelectionForReports(state) {
  const locationKey = `${state.reportsUi?.locationKey || ''}`.trim();
  if (!locationKey) return getLocationSelection(state);
  return buildLocationOptions(state).find((option) => option.key === locationKey) || getLocationSelection(state);
}

export function renderReports(el, state, navigate = () => {}, applyFocus = () => {}, options = {}) {
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
  const checklistTasks = scopedTasks.filter((task) => ['opening_checklist', 'closing_checklist', 'upkeep_checklist'].includes(task.taskType));
  const checklistEvents = (state.checklistSignoffEvents || []).filter((event) => {
    const locationMatch = !selection?.name || selection.key === '__all_locations__'
      ? true
      : selection.key === '__unassigned_location__'
        ? !`${event.locationName || ''}`.trim()
        : `${event.locationName || ''}`.trim().toLowerCase() === `${selection.name || ''}`.trim().toLowerCase();
    return locationMatch;
  });
  const uniqueChecklistDates = Array.from(new Set([...(checklistTasks.map((task) => `${task.businessDate || task.scheduledForDate || ''}`.trim())), ...checklistEvents.map((event) => `${event.businessDate || event.scheduledForDate || ''}`.trim())].filter(Boolean))).sort().reverse();
  const selectedChecklistDate = `${state.reportsUi.checklistDate || uniqueChecklistDates[0] || ''}`.trim();
  const checklistTypeFilter = state.reportsUi.checklistType || 'all';
  const checklistWorkerFilter = state.reportsUi.checklistWorker || 'all';
  const filteredChecklistTasks = checklistTasks.filter((task) => {
    const matchesDate = !selectedChecklistDate || `${task.businessDate || task.scheduledForDate || ''}`.trim() === selectedChecklistDate;
    const matchesType = checklistTypeFilter === 'all' || task.taskType === checklistTypeFilter;
    return matchesDate && matchesType;
  });
  const filteredChecklistEvents = checklistEvents.filter((event) => {
    const matchesDate = !selectedChecklistDate || `${event.businessDate || event.scheduledForDate || ''}`.trim() === selectedChecklistDate;
    const matchesType = checklistTypeFilter === 'all' || `${event.taskType || ''}`.trim() === checklistTypeFilter;
    const workerValue = `${event.workerId || event.completedBy || ''}`.trim();
    const matchesWorker = checklistWorkerFilter === 'all' || workerValue === checklistWorkerFilter;
    return matchesDate && matchesType && matchesWorker;
  });
  const workerOptions = Array.from(new Set(checklistEvents.map((event) => `${event.workerId || event.completedBy || ''}`.trim()).filter(Boolean))).sort();
  const checklistSummaryByType = ['opening_checklist', 'closing_checklist', 'upkeep_checklist'].map((type) => {
    const typeTasks = filteredChecklistTasks.filter((task) => task.taskType === type);
    const totalItems = typeTasks.reduce((sum, task) => sum + (Array.isArray(task.checklistItems) ? task.checklistItems.length : 0), 0);
    const signedItems = typeTasks.reduce((sum, task) => sum + (Array.isArray(task.checklistItems) ? task.checklistItems.filter((item) => item.completed).length : 0), 0);
    return { type, totalItems, signedItems, completionPct: totalItems ? Math.round((signedItems / totalItems) * 100) : 0 };
  });
  const totalSignedItems = filteredChecklistEvents.length;
  const lateSignedItems = filteredChecklistEvents.filter((event) => event.completedLate === true).length;
  const unsignedItems = filteredChecklistTasks.reduce((sum, task) => sum + (Array.isArray(task.checklistItems) ? task.checklistItems.filter((item) => !item.completed).length : 0), 0);
  const staffSignoffs = Object.values(filteredChecklistEvents.reduce((acc, event) => {
    const key = `${event.workerId || event.completedBy || 'unknown'}`.trim() || 'unknown';
    const label = `${event.completedBy || event.workerId || 'Unknown worker'}`.trim();
    const entry = acc[key] || { key, label, count: 0, late: 0 };
    entry.count += 1;
    if (event.completedLate === true) entry.late += 1;
    acc[key] = entry;
    return acc;
  }, {})).sort((a, b) => b.count - a.count);
  const checklistVisibleRows = checklistSummaryByType.map((row) => ({
    date: selectedChecklistDate || 'all',
    location: selection?.label || 'All locations',
    checklistType: row.type,
    totalItems: row.totalItems,
    signedItems: row.signedItems,
    lateSignedItems,
    missedUnsignedItems: unsignedItems,
    completionPct: row.completionPct
  }));
  const selectedBusinessDate = selectedChecklistDate;
  const incidents = (state.incidentReports || []).filter((incident) => {
    if (!selection?.name || selection.key === '__all_locations__') return true;
    if (selection.key === '__unassigned_location__') return !incident.locationId;
    return `${incident.locationId || ''}`.trim() === `${selection.key || ''}`.trim();
  });
  const openIncidents = incidents.filter((incident) => `${incident.status || 'open'}` !== 'closed' && `${incident.status || ''}` !== 'archived');
  const dailyTasks = (scope.scopedTasks || []).filter((task) => `${task.businessDate || task.scheduledForDate || ''}`.trim() === selectedBusinessDate);
  const taskOpenedForDate = dailyTasks.filter((task) => toIsoDate(task.openedAt || task.createdAtClient || task.createdAt || task.updatedAtClient || task.updatedAt) === selectedBusinessDate).length;
  const taskClosedForDate = dailyTasks.filter((task) => task.status === 'completed' && toIsoDate(task.closedAt || task.completedAt || task.updatedAt || task.updatedAtClient) === selectedBusinessDate).length;
  const openCriticalTasks = (scope.scopedTasks || []).filter((task) => task.status !== 'completed' && (task.severity || 'medium') === 'critical').length;
  const overdueOpenTasks = (scope.scopedTasks || []).filter((task) => task.status !== 'completed' && isTaskOverdue(task)).length;
  const assetsDown = (scope.scopedAssets || []).filter((asset) => ['down', 'broken', 'out_of_service'].includes(`${asset.status || ''}`.trim().toLowerCase())).length;
  const aiFollowupBacklog = ((state.taskAiRuns || []).filter((run) => run.status === 'followup_required')).length;
  const pendingDocsCount = (scope.scopedAssets || []).filter((asset) => asset.documentationStatus === 'manual_review' || asset.manualReviewRequired === true || asset.pendingDocumentation === true).length;
  const dailySummaryText = [
    `Daily Manager Summary — ${selection?.label || 'All locations'} — ${selectedBusinessDate || 'All dates'}`,
    `Opening checklist: ${checklistSummaryByType.find((row) => row.type === 'opening_checklist')?.completionPct || 0}%`,
    `Closing checklist: ${checklistSummaryByType.find((row) => row.type === 'closing_checklist')?.completionPct || 0}%`,
    `Upkeep checklist: ${checklistSummaryByType.find((row) => row.type === 'upkeep_checklist')?.completionPct || 0}%`,
    `Signed items: ${totalSignedItems}`,
    `Late items: ${lateSignedItems}`,
    `Missed/unsigned: ${unsignedItems}`,
    `Tasks opened: ${taskOpenedForDate}`,
    `Tasks closed: ${taskClosedForDate}`,
    `Critical open: ${openCriticalTasks}`,
    `Overdue open: ${overdueOpenTasks}`,
    `Assets down: ${assetsDown}`,
    `AI follow-ups: ${aiFollowupBacklog}`,
    `Pending doc/manual review: ${pendingDocsCount}`,
    `Open incidents: ${openIncidents.length}`,
    'Notes: '
  ].join('\n');

  el.innerHTML = `
    <div class="page-shell page-narrow">
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
      <span>Open incidents: ${openIncidents.length}</span>
    </div>
    <div class="item mt">
      <div class="row space"><b>Incident Summary</b></div>
      <div class="kpi-line mt"><span>Total: ${incidents.length}</span><span>Open: ${openIncidents.length}</span></div>
      <form class="grid grid-2 mt" data-incident-form>
        <label>Incident date<input name="incidentDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></label>
        <label>Type<select name="incidentType"><option value="safety">Safety</option><option value="customer_complaint">Customer complaint</option><option value="injury">Injury</option><option value="machine_damage">Machine damage</option><option value="cash_ticket_prize_issue">Cash/ticket/prize issue</option><option value="behavior_security_issue">Behavior/security issue</option><option value="general_operations">General operations</option></select></label>
        <label>Severity<select name="severity"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
        <label>Location<select name="locationId"><option value="">No location</option>${(state.companyLocations || []).map((location) => `<option value="${location.id}">${location.name || location.id}</option>`).join('')}</select></label>
        <label class="closeout-wide">Title<input name="title" required /></label>
        <label class="closeout-wide">Description<textarea name="description" required></textarea></label>
        <button type="submit">Submit incident</button>
      </form>
      <div class="list mt">${incidents.slice(0, 20).map((incident) => `<div class="item tiny"><b>${incident.title || incident.id}</b> · ${incident.status || 'open'} · ${incident.incidentType || 'general_operations'} · ${incident.incidentDate || ''}<form data-incident-update="${incident.id}" class="row mt"><select name="status"><option value="open">Open</option><option value="reviewed">Reviewed</option><option value="resolved">Resolved</option><option value="archived">Archived</option></select><input name="managerNotes" value="${incident.managerNotes || ''}" placeholder="Manager notes" /><button type="submit">Update</button></form></div>`).join('')}</div>
    </div>
    <div class="item mt">
      <div class="row space"><b>Checklist Accountability</b><button type="button" data-checklist-export class="filter-chip">Export CSV</button></div>
      <div class="grid grid-4 mt">
        <label class="tiny">Business date
          <select data-checklist-date>
            <option value="">All dates</option>
            ${uniqueChecklistDates.map((date) => `<option value="${date}" ${date === selectedChecklistDate ? 'selected' : ''}>${date}</option>`).join('')}
          </select>
        </label>
        <label class="tiny">Checklist type
          <select data-checklist-type>
            <option value="all" ${checklistTypeFilter === 'all' ? 'selected' : ''}>All checklist types</option>
            <option value="opening_checklist" ${checklistTypeFilter === 'opening_checklist' ? 'selected' : ''}>Opening checklist</option>
            <option value="closing_checklist" ${checklistTypeFilter === 'closing_checklist' ? 'selected' : ''}>Closing checklist</option>
            <option value="upkeep_checklist" ${checklistTypeFilter === 'upkeep_checklist' ? 'selected' : ''}>Upkeep checklist</option>
          </select>
        </label>
        <label class="tiny">Worker
          <select data-checklist-worker>
            <option value="all" ${checklistWorkerFilter === 'all' ? 'selected' : ''}>All workers</option>
            ${workerOptions.map((worker) => `<option value="${worker}" ${worker === checklistWorkerFilter ? 'selected' : ''}>${worker}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="kpi-line mt">
        ${checklistSummaryByType.map((row) => `<span>${row.type.replace('_checklist', '')}: ${row.completionPct}%</span>`).join('')}
      </div>
      <div class="kpi-line mt">
        <span>Total signed items: ${totalSignedItems}</span><span>Late signed items: ${lateSignedItems}</span><span>Missed/unsigned items: ${unsignedItems}</span>
      </div>
      ${staffSignoffs.length ? `<div class="list mt">${staffSignoffs.map((row) => `<div class="item tiny"><b>${row.label}</b> | sign-offs ${row.count} | late ${row.late}</div>`).join('')}</div>` : '<div class="inline-state info mt">No checklist sign-off events available for the selected filters.</div>'}
    </div>
    <div class="item mt" data-daily-manager-summary>
      <div class="row space">
        <b>Daily Manager Summary</b>
        <button type="button" data-copy-daily-summary class="filter-chip">Copy summary</button>
      </div>
      <div class="tiny mt" data-daily-summary-filters>Filters: location ${selection?.label || 'All locations'} · business date ${selectedBusinessDate || 'All dates'}</div>
      <div class="kpi-line mt">
        <span>Opening checklist: ${checklistSummaryByType.find((row) => row.type === 'opening_checklist')?.completionPct || 0}%</span>
        <span>Closing checklist: ${checklistSummaryByType.find((row) => row.type === 'closing_checklist')?.completionPct || 0}%</span>
        <span>Upkeep checklist: ${checklistSummaryByType.find((row) => row.type === 'upkeep_checklist')?.completionPct || 0}%</span>
      </div>
      <div class="kpi-line mt">
        <span>Signed items: ${totalSignedItems}</span><span>Late items: ${lateSignedItems}</span><span>Missed/unsigned: ${unsignedItems}</span>
      </div>
      <div class="kpi-line mt">
        <span>Tasks opened: ${taskOpenedForDate}</span><span>Tasks closed: ${taskClosedForDate}</span><span>Critical open: ${openCriticalTasks}</span><span>Overdue open: ${overdueOpenTasks}</span>
      </div>
      <div class="kpi-line mt">
        <span>Assets down: ${assetsDown}</span><span>AI follow-ups: ${aiFollowupBacklog}</span><span>Pending doc/manual review: ${pendingDocsCount}</span>
      </div>
      <label class="tiny mt">Manager notes (client-only placeholder)
        <textarea data-daily-summary-notes rows="3" placeholder="Notes for handoff..."></textarea>
      </label>
    </div>


    <div class="item mt" data-quiz-training-reports>
      <div class="row space"><b>Quiz & Training Results</b><button type="button" class="filter-chip" data-quiz-export>Export CSV</button></div>
      <div class="kpi-line mt"><span>Participation by business date/location: MVP scaffold</span><span>Scores by worker: MVP scaffold</span><span>Scores by category: MVP scaffold</span></div>
      <div class="tiny mt">Optional leaderboard intentionally deferred to keep rollout low risk.</div>
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
  el.querySelector('[data-checklist-date]')?.addEventListener('change', (event) => {
    state.reportsUi.checklistDate = `${event.target.value || ''}`.trim();
    rerender();
  });
  el.querySelector('[data-checklist-type]')?.addEventListener('change', (event) => {
    state.reportsUi.checklistType = `${event.target.value || 'all'}`.trim() || 'all';
    rerender();
  });
  el.querySelector('[data-checklist-worker]')?.addEventListener('change', (event) => {
    state.reportsUi.checklistWorker = `${event.target.value || 'all'}`.trim() || 'all';
    rerender();
  });
  el.querySelector('[data-checklist-export]')?.addEventListener('click', () => downloadChecklistCsv(checklistVisibleRows));
  el.querySelector('[data-copy-daily-summary]')?.addEventListener('click', async () => {
    const notes = `${el.querySelector('[data-daily-summary-notes]')?.value || ''}`.trim();
    const payload = notes ? `${dailySummaryText}${notes}` : dailySummaryText;
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload);
      return;
    }
    window.prompt('Copy daily summary:', payload);
  });
  el.querySelector('[data-incident-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const id = `incident_${Date.now()}`;
    await options.upsertIncidentReport?.(id, {
      companyId: state.company?.id || '',
      locationId: `${fd.get('locationId') || ''}`.trim(),
      incidentDate: `${fd.get('incidentDate') || ''}`.trim(),
      incidentType: `${fd.get('incidentType') || ''}`.trim(),
      severity: `${fd.get('severity') || 'medium'}`.trim(),
      title: `${fd.get('title') || ''}`.trim(),
      description: `${fd.get('description') || ''}`.trim(),
      assetId: '',
      customerInvolved: false,
      injuryReported: false,
      prizeOrCashImpact: '',
      status: 'open',
      submittedByUid: state.user?.uid || '',
      submittedByWorkerId: '',
      reviewedBy: '',
      reviewedAt: '',
      managerNotes: ''
    }, state.user);
    rerender();
  });
  el.querySelectorAll('[data-incident-update]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = event.currentTarget.dataset.incidentUpdate;
    const current = incidents.find((entry) => entry.id === id);
    if (!current) return;
    const fd = new FormData(event.currentTarget);
    await options.upsertIncidentReport?.(id, {
      ...current,
      status: `${fd.get('status') || current.status || 'open'}`.trim(),
      managerNotes: `${fd.get('managerNotes') || ''}`.trim(),
      reviewedBy: state.user?.uid || '',
      reviewedAt: new Date().toISOString()
    }, state.user);
    rerender();
  }));
}
