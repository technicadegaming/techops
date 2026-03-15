import { detectRepeatIssues } from './workflow.js';
import { buildLocationSummary, getLocationEmptyState, getLocationScopeLabel } from './locationContext.js';

export function renderDashboard(el, state, navigate) {
  const scope = buildLocationSummary(state);
  const openTasks = scope.openTasks;
  const critical = openTasks.filter((task) => task.severity === 'critical');
  const duePm = state.pmSchedules.filter((schedule) => schedule.status !== 'completed');
  const repeat = detectRepeatIssues(scope.scopedTasks || []);
  const needsFollowup = state.taskAiRuns.filter((run) => run.status === 'followup_required');
  const workload = state.users
    .filter((user) => user.enabled !== false)
    .map((user) => ({
      user,
      count: openTasks.filter((task) => (task.assignedWorkers || []).includes(user.id) || (task.assignedWorkers || []).includes(user.email)).length
    }));

  el.innerHTML = `
    <h2>Dashboard</h2>
    <div class="item" style="margin-bottom:12px;">
      <div><b>${getLocationScopeLabel(scope.selection)}</b></div>
      <div class="tiny">Broken assets: ${scope.brokenAssets.length} | Open work: ${scope.openTasks.length} | Assets here: ${scope.scopedAssets.length}</div>
    </div>
    <div class="grid grid-2">
      <button class="item jump" data-tab="operations"><b>True open critical issues:</b> ${critical.length}</button>
      <button class="item jump" data-tab="calendar"><b>Overdue PM count:</b> ${duePm.length}</button>
      <button class="item jump" data-tab="assets"><b>Repeat-failure assets:</b> ${new Set(repeat.map((entry) => entry.assetId)).size}</button>
      <button class="item jump" data-tab="operations"><b>Tasks needing AI follow-up:</b> ${needsFollowup.length}</button>
      <button class="item jump" data-tab="assets"><b>Assets with no documentation:</b> ${scope.assetsWithoutDocs.length}</button>
      <div class="item"><b>Recent completions:</b> ${scope.scopedTasks.filter((task) => task.status === 'completed').slice(0, 5).map((task) => task.id).join(', ') || 'none'}</div>
    </div>
    <h3>Staff workload snapshot</h3>
    <div class="list">${workload.map((row) => `<div class="item tiny">${row.user.email || row.user.id} (${row.user.role || 'staff'}) | open workload ${row.count} | ${row.user.available === false ? 'unavailable' : 'available'}</div>`).join('')}</div>
    <h3>Location focus</h3>
    <div class="grid grid-2">
      <div class="item">
        <b>What is broken here</b>
        <div class="tiny">${scope.brokenAssets.slice(0, 5).map((asset) => asset.name || asset.id).join(' | ') || getLocationEmptyState(scope.selection, 'broken assets', 'broken asset')}</div>
      </div>
      <div class="item">
        <b>What work is open here</b>
        <div class="tiny">${scope.openTasks.slice(0, 5).map((task) => task.title || task.id).join(' | ') || getLocationEmptyState(scope.selection, 'open tasks', 'open task')}</div>
      </div>
    </div>
    <h3>Recurring-problem watchlist</h3>
    <div class="list">${repeat.slice(0, 6).map((entry) => `<button class="item jump" data-tab="assets" data-asset="${entry.assetId}">${entry.assetId || 'n/a'} | ${entry.issueCategory || 'uncategorized'} | ${entry.count}</button>`).join('') || '<div class="tiny">No repeat issues detected.</div>'}</div>
    <h3>Priority queue links</h3>
    <div class="list">
      ${openTasks.slice(0, 10).map((task) => `<button class="item jump" data-tab="operations" data-id="${task.id}">${task.title || task.id} (${task.status || 'open'})</button>`).join('') || `<div class="tiny">${getLocationEmptyState(scope.selection, 'open tasks', 'open task')}</div>`}
    </div>`;

  el.querySelectorAll('.jump').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.tab, button.dataset.id || null, button.dataset.asset || null)));
}
