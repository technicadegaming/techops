import { detectRepeatIssues } from './workflow.js';

export function renderReports(el, state) {
  const completed = state.tasks.filter((t) => t.status === 'completed');
  const unresolvedBySeverity = ['critical', 'high', 'medium', 'low'].map((s) => ({ severity: s, count: state.tasks.filter((t) => t.status !== 'completed' && (t.severity || 'medium') === s).length }));
  const averageCloseByCategory = Object.values(completed.reduce((acc, t) => {
    const cat = t.issueCategory || 'uncategorized';
    const time = Number(t.closeout?.timeSpentMinutes || 0);
    const entry = acc[cat] || { category: cat, total: 0, count: 0 };
    entry.total += time;
    entry.count += 1;
    acc[cat] = entry;
    return acc;
  }, {})).map((row) => ({ ...row, avg: row.count ? Math.round(row.total / row.count) : 0 }));
  const aiHelpfulness = state.tasks.reduce((acc, t) => {
    const v = t.closeout?.aiHelpfulness;
    if (!v) return acc;
    acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});
  const repeat = detectRepeatIssues(state.tasks || []).slice(0, 8);

  el.innerHTML = `<h2>Reports</h2>
  <div class="item"><b>Top recurring issues</b><div class="tiny">${repeat.map((r) => `${r.issueCategory || 'uncategorized'} (${r.count})`).join(' · ') || 'none'}</div></div>
  <div class="item"><b>Most-down assets</b><div class="tiny">${repeat.map((r) => `${r.assetId || 'n/a'} (${r.count})`).join(' · ') || 'none'}</div></div>
  <div class="item"><b>AI helpfulness feedback</b><div class="tiny">Helpful: ${aiHelpfulness.helpful || 0} · Partial: ${aiHelpfulness.partial || 0} · Not helpful: ${aiHelpfulness.not_helpful || 0}</div></div>
  <div class="item"><b>Average time to close by category</b><div class="tiny">${averageCloseByCategory.map((r) => `${r.category}: ${r.avg}m`).join(' · ') || 'none yet'}</div></div>
  <div class="item"><b>Unresolved tasks by severity</b><div class="tiny">${unresolvedBySeverity.map((r) => `${r.severity}: ${r.count}`).join(' · ')}</div></div>`;
}
