import { detectRepeatIssues } from './workflow.js';

export function renderDashboard(el, state, navigate) {
  const openTasks = state.tasks.filter((t) => t.status !== 'completed');
  const critical = openTasks.filter((t) => t.severity === 'critical');
  const duePm = state.pmSchedules.filter((p) => p.status !== 'completed');
  const repeat = detectRepeatIssues(state.tasks || []);
  const needsFollowup = state.taskAiRuns.filter((r) => r.status === 'followup_required');
  const noDocs = state.assets.filter((a) => !(a.manualLinks || []).length);
  const workload = state.users.filter((u) => u.enabled !== false).map((u) => ({ u, count: openTasks.filter((t) => (t.assignedWorkers || []).includes(u.id) || (t.assignedWorkers || []).includes(u.email)).length }));

  el.innerHTML = `
    <h2>Dashboard</h2>
    <div class="grid grid-2">
      <button class="item jump" data-tab="operations"><b>True open critical issues:</b> ${critical.length}</button>
      <button class="item jump" data-tab="calendar"><b>Overdue PM count:</b> ${duePm.length}</button>
      <button class="item jump" data-tab="assets"><b>Repeat-failure assets:</b> ${new Set(repeat.map((r) => r.assetId)).size}</button>
      <button class="item jump" data-tab="operations"><b>Tasks needing AI follow-up:</b> ${needsFollowup.length}</button>
      <button class="item jump" data-tab="assets"><b>Assets with no documentation:</b> ${noDocs.length}</button>
      <div class="item"><b>Recent completions:</b> ${state.tasks.filter((t) => t.status === 'completed').slice(0, 5).map((t) => t.id).join(', ') || 'none'}</div>
    </div>
    <h3>Staff workload snapshot</h3>
    <div class="list">${workload.map((row) => `<div class="item tiny">${row.u.email || row.u.id} (${row.u.role || 'staff'}) · open workload ${row.count} · ${row.u.available === false ? 'unavailable' : 'available'}</div>`).join('')}</div>
    <h3>Recurring-problem watchlist</h3>
    <div class="list">${repeat.slice(0, 6).map((r) => `<button class="item jump" data-tab="assets" data-asset="${r.assetId}">${r.assetId || 'n/a'} · ${r.issueCategory || 'uncategorized'} · ${r.count}</button>`).join('') || '<div class="tiny">No repeat issues detected.</div>'}</div>
    <h3>Priority queue links</h3>
    <div class="list">
      ${openTasks.slice(0, 10).map((t) => `<button class="item jump" data-tab="operations" data-id="${t.id}">${t.title || t.id} (${t.status || 'open'})</button>`).join('')}
    </div>`;
  el.querySelectorAll('.jump').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.tab, b.dataset.id || null, b.dataset.asset || null)));
}
