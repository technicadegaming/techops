import { canDelete, canEditAssets, isManager } from '../roles.js';
import { detectRepeatIssues } from './workflow.js';

export function renderAssets(el, state, actions) {
  const editable = canEditAssets(state.profile);
  const repeatPatterns = detectRepeatIssues(state.tasks || []);
  el.innerHTML = `
    <h2>Assets (Operational source of truth)</h2>
    <form id="assetForm" class="grid grid-2">
      <input name="id" placeholder="Asset ID" required ${editable ? '' : 'disabled'} />
      <input name="name" placeholder="Asset name" required ${editable ? '' : 'disabled'} />
      <input name="status" placeholder="Current status" ${editable ? '' : 'disabled'} />
      <input name="ownerWorkers" placeholder="Assigned workers / owners (comma-separated)" ${editable ? '' : 'disabled'} />
      <input name="manualLinks" placeholder="Manual links (comma-separated URLs)" ${editable ? '' : 'disabled'} />
      <textarea name="historyNote" placeholder="Service note (added to timeline)" ${editable ? '' : 'disabled'}></textarea>
      <button class="primary" ${editable ? '' : 'disabled'}>Save asset</button>
    </form>
    <div class="list">${state.assets.map((a) => {
      const openTasks = state.tasks.filter((t) => t.assetId === a.id && t.status !== 'completed');
      const completedTasks = state.tasks.filter((t) => t.assetId === a.id && t.status === 'completed').slice(0, 5);
      const aiRuns = state.taskAiRuns.filter((r) => r.assetId === a.id || state.tasks.find((t) => t.id === r.taskId)?.assetId === a.id).slice(0, 4);
      const docs = state.manuals.filter((m) => m.assetId === a.id);
      const overduePm = state.pmSchedules.filter((p) => p.assetId === a.id && p.status !== 'completed');
      const recurring = repeatPatterns.filter((p) => p.assetId === a.id);
      const library = state.troubleshootingLibrary?.filter((row) => row.assetId === a.id).slice(0, 5) || [];
      return `<div class="item" id="asset-${a.id}"><b>${a.name || a.id}</b> · ${a.status || 'active'}
      <div class="tiny">Owners: ${(a.ownerWorkers || []).join(', ') || 'unassigned'} · Urgency flags: ${(openTasks.filter((t) => ['high', 'critical'].includes(t.severity)).length)}</div>
      <div class="tiny">Quick stats: open ${openTasks.length} · overdue PM ${overduePm.length} · repeat failures ${recurring.reduce((sum, r) => sum + r.count, 0)} · recent repairs ${completedTasks.length}</div>
      <details><summary>Open tasks (${openTasks.length})</summary>${openTasks.map((t) => `<div class="tiny"><a href="?tab=operations&taskId=${t.id}">${t.title || t.id}</a> · ${t.severity || 'medium'} · ${(t.assignedWorkers || []).join(', ') || 'unassigned'}</div>`).join('') || '<div class="tiny">None</div>'}</details>
      <details><summary>Recent completed tasks (${completedTasks.length})</summary>${completedTasks.map((t) => `<div class="tiny">${t.title || t.id} · ${t.closeout?.bestFixSummary || t.closeout?.fixPerformed || 'completed'}</div>`).join('') || '<div class="tiny">None</div>'}</details>
      <details><summary>AI runs (${aiRuns.length})</summary>${aiRuns.map((r) => `<div class="tiny">${r.status}: ${r.finalSummary || 'no summary'} </div>`).join('') || '<div class="tiny">None</div>'}</details>
      <details><summary>Documentation status (${docs.length ? 'linked' : 'missing'})</summary>
        <div class="tiny">Linked manuals: ${(a.manualLinks || []).concat(docs.map((d) => d.url || d.title)).filter(Boolean).join(' | ') || 'none'}</div>
        <div class="tiny">Missing docs: ${docs.length ? 'none flagged' : 'manual not linked'}</div>
        <div class="tiny">Last reviewed: ${a.docsLastReviewedAt || 'n/a'}</div>
        ${isManager(state.profile) ? `<button data-docs="${a.id}">Update docs review date</button>` : ''}
      </details>
      <details><summary>Service notes timeline (${(a.history || []).length})</summary>${(a.history || []).slice(0, 8).map((h) => `<div class="tiny">${h.at}: ${h.note || h.fixPerformed || ''}</div>`).join('') || '<div class="tiny">No history</div>'}</details>
      ${recurring.length ? `<div class="tiny"><b>Recurring patterns:</b> ${recurring.map((r) => `${r.issueCategory || 'uncategorized'} (${r.count})`).join(', ')}</div>` : ''}
      ${library.length ? `<div class="tiny"><b>Troubleshooting library:</b> ${library.map((row) => row.successfulFix || row.title).join(' | ')}</div>` : ''}
      ${canDelete(state.profile) ? `<button data-del="${a.id}" class="danger">Delete</button>` : ''}
      </div>`;
    }).join('')}</div>`;
  const form = el.querySelector('#assetForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const p = Object.fromEntries(fd.entries());
    actions.saveAsset(p.id, p);
    form.reset();
  });
  el.querySelectorAll('[data-docs]').forEach((btn) => btn.addEventListener('click', () => actions.markDocsReviewed(btn.dataset.docs)));
  el.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => actions.deleteAsset(btn.dataset.del)));
}
