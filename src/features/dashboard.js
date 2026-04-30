import { detectRepeatIssues } from './workflow.js';
import { buildLocationSummary, getLocationEmptyState, getLocationScopeLabel } from './locationContext.js';
import { formatRelativeTime } from './notifications.js';
import { buildPmHealthSummary, summarizePmByField } from './reportingSummary.js';
import { computeChecklistTiming } from './businessHours.js';

function statusChip(label, tone = 'muted') {
  return `<span class="state-chip ${tone}">${label}</span>`;
}

function formatChecklistTime(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

const CHECKLIST_TYPES = ['opening_checklist', 'closing_checklist', 'upkeep_checklist'];
const CHECKLIST_TAB_META = {
  opening_checklist: { label: 'Opening', empty: 'No opening checklist in this scope yet.' },
  closing_checklist: { label: 'Closing', empty: 'No closing checklist in this scope yet.' },
  upkeep_checklist: { label: 'Upkeep', empty: 'No upkeep checklist in this scope yet.' },
  all: { label: 'All', empty: 'No daily checklists in this scope yet.' }
};

export function renderDashboard(el, state, navigate, applyFocus = () => {}, options = {}) {
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
  const allChecklistTasks = openTasks.filter((task) => CHECKLIST_TYPES.includes(task.taskType));
  const locationById = new Map((state.companyLocations || []).map((loc) => [loc.id, loc]));
  const todaysOperationsWorkflow = openTasks.filter((task) => task.taskType === 'general' && !task.assetId && (!task.scheduledForDate || `${task.scheduledForDate}` === now.toISOString().slice(0,10)));
  const checklistUi = state.dashboardUi?.checklistFocus || {};
  const defaultChecklistType = allChecklistTasks.some((task) => task.taskType === 'opening_checklist')
    ? 'opening_checklist'
    : (allChecklistTasks[0]?.taskType || 'all');
  const selectedChecklistType = CHECKLIST_TAB_META[checklistUi.type] ? checklistUi.type : defaultChecklistType;
  const filteredChecklistTasks = selectedChecklistType === 'all'
    ? allChecklistTasks
    : allChecklistTasks.filter((task) => task.taskType === selectedChecklistType);
  const activeChecklistIndex = Math.max(0, Math.min(Number(checklistUi.index || 0), Math.max(filteredChecklistTasks.length - 1, 0)));
  const activeChecklistTask = filteredChecklistTasks[activeChecklistIndex] || null;
  const checklistFocusMinimized = checklistUi.minimized === true;

  el.innerHTML = `
    <div class="page-shell page-narrow">
    <header class="page-header">
      <div>
        <h2 class="page-title">Dashboard</h2>
        <p class="page-subtitle">Today’s operations snapshot for this workspace. ${getLocationScopeLabel(scope.selection)}</p>
      </div>
      <div class="page-actions">
        <button class="btn-primary jump" data-tab="operations">New operations task</button>
        <button class="btn-secondary jump" data-tab="dailyOperations">Today’s Operations</button>
        <button class="btn-secondary jump" data-tab="assets">Add asset</button>
        <button class="btn-secondary jump" data-tab="reports">Report Incident</button>
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

    <div class="item mt">
      <div class="row space">
        <b>Daily Checklist focus</b>
        <button type="button" class="filter-chip" data-checklist-minimize-toggle>${checklistFocusMinimized ? 'Expand' : 'Minimize'}</button>
      </div>
      <div class="row mt">
        ${Object.entries(CHECKLIST_TAB_META).map(([type, meta]) => `<button type="button" class="filter-chip ${selectedChecklistType === type ? 'active' : ''}" data-checklist-type="${type}">${meta.label}</button>`).join('')}
        <button class="filter-chip jump" data-tab="dailyOperations" type="button">Open daily operations</button>
      </div>
      ${checklistUi.message ? `<div class="inline-state ${checklistUi.tone || 'info'} mt">${checklistUi.message}</div>` : ''}
      ${checklistFocusMinimized
        ? `<div class="tiny mt"><b>${CHECKLIST_TAB_META[selectedChecklistType]?.label || 'All'}</b> · ${filteredChecklistTasks.length} checklist task${filteredChecklistTasks.length === 1 ? '' : 's'} in view</div>
           <div class="tiny">${activeChecklistTask ? `${(activeChecklistTask.checklistItems || []).filter((item) => item.completed).length} of ${(activeChecklistTask.checklistItems || []).length} signed off` : 'No active checklist selected.'}</div>`
        : activeChecklistTask
        ? `<div class="tiny mt"><b>${activeChecklistTask.title || activeChecklistTask.id}</b> · ${(activeChecklistTask.locationName || activeChecklistTask.location || activeChecklistTask.locationId || 'No location')}</div>
           <div class="tiny">${(activeChecklistTask.checklistItems || []).filter((item) => item.completed).length} of ${(activeChecklistTask.checklistItems || []).length} signed off</div>${(() => { const timing = computeChecklistTiming({ taskType: activeChecklistTask.taskType, scheduledForDate: activeChecklistTask.scheduledForDate, location: locationById.get(activeChecklistTask.locationId) || {} }); return `<div class="tiny ${timing.overdueStatus === 'overdue' ? 'warn' : ''}">${timing.timingLabel}</div>`; })()}
           ${filteredChecklistTasks.length > 1 ? `<div class="row mt"><button type="button" data-checklist-prev>Previous</button><div class="tiny">${activeChecklistIndex + 1} of ${filteredChecklistTasks.length}</div><button type="button" data-checklist-next>Next</button></div>` : ''}
           <div class="list mt">${(activeChecklistTask.checklistItems || []).map((item) => {
    const itemId = `${item.id || ''}`.trim();
    return `<div class="item tiny ${item.completed ? '' : 'warn'}"><div class="row space"><b>${item.label || itemId || 'Checklist item'}</b>${item.completed ? '' : '<span class="state-chip bad">Needs sign-off</span>'}</div>${item.completed
      ? `<div class="inline-state success mt"><b>Signed off</b>${item.completedBy ? `<div>Completed by <b>${item.completedBy}</b></div>` : ''}${item.completedAt ? `<div><b>${formatChecklistTime(item.completedAt)}</b></div>` : ''}</div>`
      : `<form class="grid mt" data-dashboard-checklist-signoff="${activeChecklistTask.id}"><input type="hidden" name="checklistItemId" value="${itemId}" /><label>PIN<input type="password" name="pin" autocomplete="off" inputmode="numeric" /></label><div class="action-row"><button type="submit">Sign off</button></div></form>`}
    </div>`;
  }).join('')}</div>`
        : `<div class="inline-state info mt">${CHECKLIST_TAB_META[selectedChecklistType]?.empty || CHECKLIST_TAB_META.all.empty}</div>`}
    </div>

    
    <div class="item mt">
      <div class="row space"><b>Today's Operations Workflow</b><button class="filter-chip jump" data-tab="dailyOperations" type="button">Open daily operations</button></div>
      ${todaysOperationsWorkflow.length ? `<div class="list mt">${todaysOperationsWorkflow.slice(0,6).map((task) => `<button class="item jump" data-tab="dailyOperations" data-id="${task.id}"><b>${task.title || task.id}</b><div class="tiny">${task.locationName || task.location || 'No location'} · ${task.status || 'open'} · owner ${(task.assignedWorkers || []).join(', ') || 'unassigned'} · ${(task.scheduledForDate || task.createdAtClient || '').toString().slice(0,16)}</div></button>`).join('')}</div>` : '<div class="inline-state info mt">No one-off daily operations tasks are open for today.</div>'}
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


    <div class="item mt" data-daily-quiz-widget>
      <div class="row space"><b>Daily Quiz</b><span class="tiny">Staff training accountability</span></div>
      <div class="tiny mt">Answer today’s assigned quiz with your location PIN.</div>
      <form class="grid grid-2 mt" data-daily-quiz-form>
        <label>PIN<input type="password" name="pin" inputmode="numeric" autocomplete="off" /></label>
        <label>Answer<select name="answerChoiceId"><option value="">Select answer</option></select></label>
        <button type="button" disabled>Submit quiz answer (MVP scaffold)</button>
      </form>
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
  el.querySelector('[data-checklist-prev]')?.addEventListener('click', () => {
    state.dashboardUi = { ...(state.dashboardUi || {}), checklistFocus: { ...(state.dashboardUi?.checklistFocus || {}), index: Math.max(0, activeChecklistIndex - 1) } };
    renderDashboard(el, state, navigate, applyFocus, options);
  });
  el.querySelector('[data-checklist-next]')?.addEventListener('click', () => {
    state.dashboardUi = { ...(state.dashboardUi || {}), checklistFocus: { ...(state.dashboardUi?.checklistFocus || {}), index: Math.min(filteredChecklistTasks.length - 1, activeChecklistIndex + 1) } };
    renderDashboard(el, state, navigate, applyFocus, options);
  });
  el.querySelectorAll('[data-checklist-type]').forEach((button) => button.addEventListener('click', () => {
    state.dashboardUi = { ...(state.dashboardUi || {}), checklistFocus: { ...(state.dashboardUi?.checklistFocus || {}), type: button.dataset.checklistType || 'all', index: 0 } };
    renderDashboard(el, state, navigate, applyFocus, options);
  }));
  el.querySelector('[data-checklist-minimize-toggle]')?.addEventListener('click', () => {
    state.dashboardUi = { ...(state.dashboardUi || {}), checklistFocus: { ...(state.dashboardUi?.checklistFocus || {}), minimized: !checklistFocusMinimized } };
    renderDashboard(el, state, navigate, applyFocus, options);
  });
  el.querySelectorAll('[data-dashboard-checklist-signoff]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const taskId = form.dataset.dashboardChecklistSignoff;
    const fd = new FormData(form);
    const task = filteredChecklistTasks.find((entry) => entry.id === taskId);
    if (!task || !task.locationId) return;
    const success = await options.onChecklistSignoff?.({ companyId: state.company?.id, taskId, checklistItemId: `${fd.get('checklistItemId') || ''}`.trim(), locationId: task.locationId, pin: `${fd.get('pin') || ''}`.trim() });
    if (success) {
      form.reset();
      state.dashboardUi = { ...(state.dashboardUi || {}), checklistFocus: { ...(state.dashboardUi?.checklistFocus || {}), message: 'Checklist item signed off.', tone: 'success' } };
      options.onAfterChecklistSignoff?.();
    }
  }));
}
