import { detectRepeatIssues } from './workflow.js';
import { buildLocationSummary, getLocationEmptyState, getLocationScopeLabel } from './locationContext.js';
import { formatRelativeTime } from './notifications.js';
import { buildPmHealthSummary, summarizePmByField } from './reportingSummary.js';

function statusChip(label, tone = 'muted') {
  return `<span class="state-chip ${tone}">${label}</span>`;
}

export function renderDashboard(el, state, navigate, applyFocus = () => {}) {
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
  const pmHealth = buildPmHealthSummary(pmSchedules, now);
  const overduePm = pmHealth.overdue;
  const dueSoonPm = pmHealth.dueSoon;
  const openPm = pmHealth.open;
  const assetById = new Map((scope.scopedAssets || []).map((asset) => [asset.id, asset]));
  const pmByAssetGroup = summarizePmByField(pmSchedules, (schedule) => {
    const linked = assetById.get(schedule.assetId);
    return linked?.category || schedule.assetCategory || 'Uncategorized assets';
  }, now).slice(0, 4);
  const pendingInvites = (state.invites || []).filter((invite) => invite.status === 'pending' && invite.companyId === state.company?.id);
  const blockedOpen = openTasks.filter((task) => {
    const assignedWorkers = task.assignedWorkers || [];
    const hasUnavailableWorker = assignedWorkers.some((worker) => (state.users || []).some((user) => (
      (user.id === worker || user.email === worker) && (user.enabled === false || user.available === false)
    )));
    return hasUnavailableWorker || (task.status === 'in_progress' && assignedWorkers.length === 0);
  });
  const unassignedOpen = openTasks.filter((task) => !(task.assignedWorkers || []).length);
  const readyToClose = openTasks.filter((task) => task.status === 'in_progress' && (task.assignedWorkers || []).length > 0);
  const missingDocsAssets = scope.assetsWithoutDocs || [];
  const overdueTasks = openTasks.filter((task) => {
    const opened = new Date(task.openedAt || task.createdAtClient || task.updatedAt || 0);
    if (Number.isNaN(opened.getTime())) return false;
    const severity = task.severity || 'medium';
    const threshold = severity === 'critical' ? 4 : severity === 'high' ? 24 : severity === 'low' ? 168 : 72;
    return ((Date.now() - opened.getTime()) / (1000 * 60 * 60)) >= threshold;
  });

  const recentActivity = [
    ...completedToday.map((task) => ({
      id: `complete-${task.id}`,
      at: task.closedAt || task.updatedAt || task.updatedAtClient,
      text: `Task closed: ${task.title || task.id}`,
      tone: 'good'
    })),
    ...openTasks.slice(0, 8).map((task) => ({
      id: `open-${task.id}`,
      at: task.openedAt || task.createdAtClient,
      text: `Task opened: ${task.title || task.id}`,
      tone: 'info'
    })),
    ...(scope.scopedAssets || []).slice(0, 8).map((asset) => ({
      id: `asset-${asset.id}`,
      at: asset.updatedAt || asset.enrichmentUpdatedAt,
      text: `Asset updated: ${asset.name || asset.id}`,
      tone: (asset.manualLinks || []).length ? 'good' : 'warn'
    })),
    ...pendingInvites.map((invite) => ({
      id: `invite-${invite.id}`,
      at: invite.updatedAt || invite.createdAt,
      text: `Invite pending: ${invite.email || invite.id}`,
      tone: 'warn'
    }))
  ]
    .filter((entry) => entry.at)
    .sort((a, b) => `${b.at}`.localeCompare(`${a.at}`))
    .slice(0, 8);

  const workload = (state.users || [])
    .filter((user) => user.enabled !== false)
    .map((user) => ({
      user,
      count: openTasks.filter((task) => (task.assignedWorkers || []).includes(user.id) || (task.assignedWorkers || []).includes(user.email)).length
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  el.innerHTML = `
    <div class="page-shell page-narrow">
    <header class="page-header">
      <div>
        <h2 class="page-title">Dashboard</h2>
        <p class="page-subtitle">Today’s operations snapshot for this workspace. ${getLocationScopeLabel(scope.selection)}</p>
      </div>
      <div class="page-actions">
        <button class="btn-primary jump" data-tab="operations">New operations task</button>
        <button class="btn-secondary jump" data-tab="assets">Add asset</button>
        <button class="btn-secondary jump" data-tab="assets" data-focus="missing_docs">Review documentation</button>
        <button class="btn-secondary jump" data-tab="admin" data-focus="pending_invites">Invite member</button>
      </div>
    </header>
    <div class="kpi-line">
      <span>Assets here: ${scope.scopedAssets.length}</span>
      <span>Broken assets: ${scope.brokenAssets.length}</span>
      <span>Open work: ${openTasks.length}</span>
    </div>

    <div class="priority-band" role="status" aria-live="polite">
      <div>
        <div class="tiny">Attention now</div>
        <h3>Priority control center</h3>
        <div class="tiny">Urgent cards are highlighted first. Healthy cards stay quieter.</div>
      </div>
      <div class="kpi-line">
        ${statusChip(`${critical.length} urgent`, critical.length ? 'bad' : 'good')}
        ${statusChip(`${overduePm.length} overdue PM`, overduePm.length ? 'warn' : 'good')}
        ${statusChip(`${blockedOpen.length} blocked`, blockedOpen.length ? 'bad' : 'good')}
        ${statusChip(`${missingDocsAssets.length} missing docs`, missingDocsAssets.length ? 'warn' : 'good')}
      </div>
    </div>

    <div class="stats-grid dashboard-priority-grid mt">
      <button class="stat-card priority-card ${critical.length ? 'bad' : 'good'} jump" data-tab="operations" data-focus="critical">
        <div class="tiny">Critical / open issues</div>
        <strong>${critical.length}</strong>
        <div class="tiny">${critical.length ? 'Immediate follow-up recommended.' : 'Healthy: no critical tasks open.'}</div>
      </button>
      <button class="stat-card priority-card ${overduePm.length ? 'warn' : 'good'} jump" data-tab="calendar" data-focus="overdue_pm">
        <div class="tiny">Overdue preventive maintenance</div>
        <strong>${overduePm.length}</strong>
        <div class="tiny">${dueSoonPm.length} due in the next 7 days</div>
      </button>
      <button class="stat-card priority-card ${blockedOpen.length ? 'bad' : 'good'} jump" data-tab="operations" data-focus="blocked">
        <div class="tiny">Blocked work</div>
        <strong>${blockedOpen.length}</strong>
        <div class="tiny">${blockedOpen.length ? 'Needs assignment/follow-up unblock.' : 'Healthy: no blocked work right now.'}</div>
      </button>
      <button class="stat-card priority-card ${missingDocsAssets.length ? 'warn' : 'good'} jump" data-tab="assets" data-focus="missing_docs" data-asset="${missingDocsAssets[0]?.id || ''}">
        <div class="tiny">Assets missing docs</div>
        <strong>${missingDocsAssets.length}</strong>
        <div class="tiny">${missingDocsAssets.length ? 'Documentation review needed.' : 'Healthy: docs linked for scoped assets.'}</div>
      </button>
      <button class="stat-card ${needsFollowup.length ? 'warn' : 'good'} jump" data-tab="operations" data-focus="followup">
        <div class="tiny">Tasks needing follow-up</div>
        <strong>${needsFollowup.length}</strong>
        <div class="tiny">${needsFollowup.length ? 'AI runs need frontline answers.' : 'No follow-up backlog.'}</div>
      </button>
      <button class="stat-card ${pendingInvites.length ? 'warn' : 'good'} jump" data-tab="admin" data-focus="pending_invites">
        <div class="tiny">Pending invites</div>
        <strong>${pendingInvites.length}</strong>
        <div class="tiny">${pendingInvites.length ? 'Access requests awaiting acceptance.' : 'Healthy: no pending invites.'}</div>
      </button>
      <button class="stat-card ${unassignedOpen.length ? 'warn' : 'good'} jump" data-tab="operations" data-focus="unassigned">
        <div class="tiny">Unassigned open work</div>
        <strong>${unassignedOpen.length}</strong>
        <div class="tiny">${unassignedOpen.length ? 'Assign owners to keep queue moving.' : 'Healthy: open work has owners.'}</div>
      </button>
      <button class="stat-card ${overdueTasks.length ? 'warn' : 'good'} jump" data-tab="operations" data-focus="overdue_open">
        <div class="tiny">Overdue open tasks</div>
        <strong>${overdueTasks.length}</strong>
        <div class="tiny">${readyToClose.length} in-progress tasks could be reviewed for closeout.</div>
      </button>
    </div>

    <div class="grid grid-2 mt">
      <div class="item">
        <div class="row space">
          <b>Preventive maintenance focus</b>
          <button class="filter-chip jump" data-tab="calendar" type="button">Open PM list</button>
        </div>
        ${openPm.length
          ? `<div class="kpi-line mt"><span>Open PM: ${openPm.length}</span><span>Overdue: ${overduePm.length}</span><span>Due soon: ${dueSoonPm.length}</span><span>Compliance: ${pmHealth.compliance}%</span></div>
             <div class="list mt">${openPm.slice(0, 5).map((schedule) => `<div class="item tiny"><b>${schedule.title || schedule.id}</b> | due ${schedule.dueDate || 'not set'} | ${schedule.status || 'open'}</div>`).join('')}</div>
             ${pmByAssetGroup.length ? `<div class="list mt">${pmByAssetGroup.map((row) => `<button class="item jump" data-tab="calendar" data-focus="${row.overdue ? 'overdue_pm' : 'due_soon_pm'}"><b>${row.label}</b><div class="tiny">overdue ${row.overdue} · due soon ${row.dueSoon} · compliance ${row.compliance}%</div></button>`).join('')}</div>` : ''}`
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

    <h3>Recent activity</h3>
    ${recentActivity.length
      ? `<div class="list">${recentActivity.map((entry) => `<div class="item tiny"><div class="row space"><span>${entry.text}</span>${statusChip(formatRelativeTime(entry.at), entry.tone)}</div></div>`).join('')}</div>`
      : '<div class="inline-state info">No recent activity found in this scope yet.</div>'}

    <h3>Team workload snapshot</h3>
    ${workload.length
      ? `<div class="list">${workload.map((row) => `<div class="item tiny"><div class="row space"><b>${row.user.email || row.user.id}</b>${statusChip(row.count ? `open ${row.count}` : 'clear', row.count > 3 ? 'warn' : row.count ? 'info' : 'good')}</div><div class="tiny">${row.user.role || 'staff'} · ${row.user.available === false ? 'unavailable' : 'available'} · ${row.count > 0 ? 'assigned work in queue' : 'no assigned open tasks'}</div></div>`).join('')}</div>`
      : '<div class="inline-state info">No active staff records are available for workload balancing yet.</div>'}

    <details class="mt">
      <summary><b>Recurring-problem watchlist</b> <span class="tiny">(lower-priority detail)</span></summary>
      ${repeat.length
      ? `<div class="list mt">${repeat.slice(0, 6).map((entry) => `<button class="item jump" data-tab="assets" data-asset="${entry.assetId}"><b>${entry.assetId || 'Unknown asset'}</b><div class="tiny">${entry.issueCategory || 'uncategorized'} | repeated ${entry.count} times</div></button>`).join('')}</div>`
      : '<div class="inline-state success mt">No repeat issues detected in the current scope.</div>'}
    </details>
    </div>
  `;

  el.querySelectorAll('.jump').forEach((button) => button.addEventListener('click', () => {
    const focus = button.dataset.focus || null;
    if (focus) applyFocus(focus);
    navigate(button.dataset.tab, button.dataset.id || null, button.dataset.asset || null);
  }));
}
