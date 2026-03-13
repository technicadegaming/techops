import { canDelete, canEditAssets, isAdmin, isManager } from '../roles.js';
import { detectRepeatIssues } from './workflow.js';

const ENRICHMENT_STATUS_LABELS = {
  searching_docs: 'searching for documentation',
  in_progress: 'enrichment in progress',
  needs_follow_up: 'needs follow-up',
  docs_found: 'documentation found',
  no_match_yet: 'no reliable match yet',
  idle: 'not started'
};


function renderPreviewPanel(state) {
  const preview = state.assetDraft?.preview || null;
  const status = state.assetDraft?.previewStatus || 'idle';
  const labels = {
    idle: 'idle',
    searching: 'searching',
    found_suggestions: 'found suggestions',
    needs_follow_up: 'needs follow-up',
    no_strong_match: 'no strong match'
  };
  if (!preview && status === 'idle') {
    return '<div class="tiny">Lookup assistant: idle</div>';
  }

  const docs = (preview?.documentationSuggestions || []).slice(0, 3);
  const support = (preview?.supportResourcesSuggestion || []).slice(0, 3);
  const contacts = (preview?.supportContactsSuggestion || []).slice(0, 3);
  const alternate = (preview?.alternateNames || []).join(', ');

  return `
    <div class="tiny"><b>Lookup assistant:</b> ${labels[status] || status}</div>
    <div class="tiny">Best match: ${preview?.normalizedName || 'n/a'} (${Math.round(Number(preview?.confidence || 0) * 100)}%)</div>
    <div class="tiny">Suggested manufacturer: ${preview?.likelyManufacturer || 'n/a'} · Category: ${preview?.likelyCategory || 'n/a'}</div>
    <div class="tiny">Top reason: ${preview?.topMatchReason || 'n/a'}</div>
    <div class="tiny">Manual/docs: ${docs.map((d) => `<a href="${d.url}" target="_blank" rel="noopener">${d.title || d.url}</a>`).join(' | ') || 'none'}</div>
    <div class="tiny">Support links: ${support.map((d) => `<a href="${d.url}" target="_blank" rel="noopener">${d.title || d.url}</a>`).join(' | ') || 'none'}</div>
    <div class="tiny">Support contacts: ${contacts.map((c) => `${c.label || c.contactType}: ${c.value}`).join(' | ') || 'none'}</div>
    <div class="tiny">Alternate names: ${alternate || 'none'}</div>
    ${preview?.oneFollowupQuestion ? `<div class="tiny"><b>Follow-up:</b> ${preview.oneFollowupQuestion}</div>` : ''}
    <div style="display:flex; gap:6px; flex-wrap:wrap; margin:6px 0;">
      <button type="button" data-apply-preview="manufacturer">Apply manufacturer</button>
      <button type="button" data-apply-preview="manuals">Apply top manual link(s)</button>
      <button type="button" data-apply-preview="support">Apply support link(s)</button>
      <button type="button" data-apply-preview="contacts">Apply contact info / notes</button>
      <button type="button" data-apply-preview="all">Apply all safe suggestions</button>
      <button type="button" data-clear-preview="1">Clear preview</button>
    </div>
  `;
}

function renderEnrichmentDetails(asset, manager) {
  const status = asset.enrichmentStatus || 'idle';
  const suggestions = Array.isArray(asset.documentationSuggestions) ? asset.documentationSuggestions : [];
  const suggestionsHtml = suggestions.length
    ? `<div class="tiny">Suggested docs: ${suggestions.map((s) => {
      const confidence = s.confidence ? ` (${Math.round(Number(s.confidence) * 100)}%)` : '';
      const score = Number.isFinite(Number(s.matchScore)) ? ` score:${Math.round(Number(s.matchScore))}` : '';
      const source = s.isOfficial ? ' official' : (s.isLikelyManual ? ' manual' : '');
      return `<a href="${s.url}" target="_blank" rel="noopener">${s.title || s.url}</a>${confidence}${score}${source}`;
    }).join(' | ')}</div>`
    : '<div class="tiny">Suggested docs: none yet</div>';
  const followup = asset.enrichmentFollowupQuestion
    ? `<div class="tiny"><b>Follow-up:</b> ${asset.enrichmentFollowupQuestion}</div>
       <form data-enrichment-followup-form="${asset.id}" class="grid" style="margin:6px 0; gap:4px;">
         <textarea name="followupAnswer" rows="2" placeholder="Add answer to improve match...">${asset.enrichmentFollowupAnswer || ''}</textarea>
         <button type="submit">Submit answer and retry</button>
       </form>`
    : '';
  return `
    <div class="tiny">Enrichment status: ${ENRICHMENT_STATUS_LABELS[status] || status}</div>
    <div class="tiny">Model suggestion: ${asset.normalizedName || 'n/a'}${asset.enrichmentConfidence ? ` (${Math.round(Number(asset.enrichmentConfidence) * 100)}% confidence)` : ''}</div>
    <div class="tiny">Inferred manufacturer: ${asset.manufacturer || 'n/a'}</div>
    ${suggestionsHtml}
    ${followup}
    <button data-enrich="${asset.id}">Search AI/docs</button>
    ${manager && suggestions.length ? `<button data-apply-docs="${asset.id}">Apply top doc suggestions</button>` : ''}
  `;
}

export function renderAssets(el, state, actions) {
  const editable = canEditAssets(state.profile);
  const repeatPatterns = detectRepeatIssues(state.tasks || []);
  el.innerHTML = `
    <h2>Assets (Operational source of truth)</h2>
    <form id="assetForm" class="grid grid-2">
      <input name="name" placeholder="Asset name *" required ${editable ? '' : 'disabled'} />
      <input name="serialNumber" placeholder="Serial number" ${editable ? '' : 'disabled'} />
      <input name="manufacturer" placeholder="Manufacturer" ${editable ? '' : 'disabled'} />
      <input name="id" placeholder="Asset ID (optional; auto-generated if blank)" ${editable ? '' : 'disabled'} />
      <input name="status" placeholder="Current status" ${editable ? '' : 'disabled'} />
      <input name="ownerWorkers" placeholder="Assigned workers / owners (comma-separated)" ${editable ? '' : 'disabled'} />
      <input name="manualLinks" placeholder="Manual links (comma-separated URLs)" ${editable ? '' : 'disabled'} />
      <textarea name="historyNote" placeholder="Service note (added to timeline)" ${editable ? '' : 'disabled'}></textarea>
      <div class="grid" style="grid-column:1/-1; gap:6px; border:1px solid #ddd; padding:8px; border-radius:8px;">
        <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
          <button type="button" data-preview-lookup="1" ${editable ? '' : 'disabled'}>Find manufacturer/manual info</button>
          <span class="tiny">Runs on unsaved draft, no auto-save.</span>
        </div>
        ${renderPreviewPanel(state)}
      </div>
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
      const docsStatus = docs.length || (a.manualLinks || []).length ? 'linked' : 'missing';
      return `<details class="item" id="asset-${a.id}">
      <summary><b>${a.name || a.id}</b> · ${a.status || 'active'} · ${a.id}</summary>
      <div class="tiny">Manufacturer: ${a.manufacturer || 'n/a'} · Serial: ${a.serialNumber || 'n/a'}</div>
      <div class="tiny">Owners: ${(a.ownerWorkers || []).join(', ') || 'unassigned'} · Urgency flags: ${(openTasks.filter((t) => ['high', 'critical'].includes(t.severity)).length)}</div>
      <div class="tiny">Quick stats: open ${openTasks.length} · overdue PM ${overduePm.length} · repeat failures ${recurring.reduce((sum, r) => sum + r.count, 0)} · recent repairs ${completedTasks.length}</div>
      <details><summary>Open tasks (${openTasks.length})</summary>${openTasks.map((t) => `<div class="tiny"><a href="?tab=operations&taskId=${t.id}">${t.title || t.id}</a> · ${t.severity || 'medium'} · ${(t.assignedWorkers || []).join(', ') || 'unassigned'}</div>`).join('') || '<div class="tiny">None</div>'}</details>
      <details><summary>Recent completed tasks (${completedTasks.length})</summary>${completedTasks.map((t) => `<div class="tiny">${t.title || t.id} · ${t.closeout?.bestFixSummary || t.closeout?.fixPerformed || 'completed'}</div>`).join('') || '<div class="tiny">None</div>'}</details>
      <details><summary>AI runs (${aiRuns.length})</summary>${aiRuns.map((r) => `<div class="tiny">${r.status}: ${r.finalSummary || 'no summary'} </div>`).join('') || '<div class="tiny">None</div>'}</details>
      <details><summary>Documentation status (${docsStatus})</summary>
        <div class="tiny">Linked manuals: ${(a.manualLinks || []).concat(docs.map((d) => d.url || d.title)).filter(Boolean).join(' | ') || 'none'}</div>
        <div class="tiny">Missing docs: ${docsStatus === 'linked' ? 'none flagged' : 'manual not linked'}</div>
        <div class="tiny">Last reviewed: ${a.docsLastReviewedAt || 'n/a'}</div>

        ${renderEnrichmentDetails(a, isAdmin(state.profile))}

        ${isManager(state.profile) ? `<button data-docs="${a.id}">Update docs review date</button>` : ''}
      </details>
      <details><summary>Service notes timeline (${(a.history || []).length})</summary>${(a.history || []).slice(0, 8).map((h) => `<div class="tiny">${h.at}: ${h.note || h.fixPerformed || ''}</div>`).join('') || '<div class="tiny">No history</div>'}</details>
      ${recurring.length ? `<div class="tiny"><b>Recurring patterns:</b> ${recurring.map((r) => `${r.issueCategory || 'uncategorized'} (${r.count})`).join(', ')}</div>` : ''}
      ${library.length ? `<div class="tiny"><b>Troubleshooting library:</b> ${library.map((row) => row.successfulFix || row.title).join(' | ')}</div>` : ''}

      ${isAdmin(state.profile) ? `<details><summary>Edit core fields</summary><form data-edit="${a.id}" class="grid grid-2"><input name="name" value="${a.name || ''}" placeholder="Asset name" /><input name="id" value="${a.id || ''}" placeholder="Asset ID" /><input name="serialNumber" value="${a.serialNumber || ''}" placeholder="Serial number" /><input name="manufacturer" value="${a.manufacturer || ''}" placeholder="Manufacturer" /><input name="status" value="${a.status || ''}" placeholder="Status" /><input name="manualLinks" value="${(a.manualLinks || []).join(', ')}" placeholder="Manual links (comma-separated)" /><textarea name="notes" placeholder="Notes">${a.notes || ''}</textarea><button>Save core fields</button></form></details>` : ''}

      ${canDelete(state.profile) ? `<button data-del="${a.id}" class="danger">Delete</button>` : ''}
      </details>`;
    }).join('')}</div>`;
  const form = el.querySelector('#assetForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const p = Object.fromEntries(fd.entries());
    actions.saveAsset(p.id, p);
    form.reset();
  });

  let previewTimer = null;
  const nameInput = form?.querySelector('[name="name"]');
  const requestPreview = () => {
    const assetName = `${nameInput?.value || ''}`.trim();
    if (assetName.length < 3) return;
    const manufacturer = `${form?.querySelector('[name="manufacturer"]')?.value || ''}`.trim();
    const serialNumber = `${form?.querySelector('[name="serialNumber"]')?.value || ''}`.trim();
    const assetId = `${form?.querySelector('[name="id"]')?.value || ''}`.trim();
    actions.previewAssetLookup({ assetName, manufacturer, serialNumber, assetId });
  };

  nameInput?.addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(requestPreview, 700);
  });

  form?.querySelector('[data-preview-lookup]')?.addEventListener('click', requestPreview);

  form?.querySelectorAll('[data-apply-preview]').forEach((btn) => btn.addEventListener('click', () => {
    const preview = state.assetDraft?.preview || {};
    const docs = (preview.documentationSuggestions || []).map((d) => d.url).filter(Boolean);
    const support = (preview.supportResourcesSuggestion || []).map((d) => d.url).filter(Boolean);
    const contacts = (preview.supportContactsSuggestion || []).map((c) => `${c.label || c.contactType}: ${c.value}`).filter(Boolean);
    const mode = btn.dataset.applyPreview;
    if (mode === 'manufacturer' || mode === 'all') {
      if (preview.likelyManufacturer) form.querySelector('[name="manufacturer"]').value = preview.likelyManufacturer;
    }
    if (mode === 'manuals' || mode === 'all') {
      if (docs.length) form.querySelector('[name="manualLinks"]').value = docs.slice(0, 2).join(', ');
    }
    if (mode === 'support' || mode === 'all') {
      actions.applyPreviewToDraft({ supportResources: support.slice(0, 3) });
    }
    if (mode === 'contacts' || mode === 'all') {
      actions.applyPreviewToDraft({ notes: contacts.join(' | '), supportContacts: preview.supportContactsSuggestion || [] });
    }
    if (mode === 'manuals' || mode === 'all') actions.applyPreviewToDraft({ manualLinks: docs.slice(0, 2) });
    if (mode === 'manufacturer' || mode === 'all') actions.applyPreviewToDraft({ manufacturer: preview.likelyManufacturer || '' });
  }));

  form?.querySelector('[data-clear-preview]')?.addEventListener('click', () => actions.clearPreview());
  el.querySelectorAll('[data-docs]').forEach((btn) => btn.addEventListener('click', () => actions.markDocsReviewed(btn.dataset.docs)));
  el.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => actions.deleteAsset(btn.dataset.del)));
  el.querySelectorAll('[data-enrich]').forEach((btn) => btn.addEventListener('click', () => actions.runAssetEnrichment(btn.dataset.enrich)));
  el.querySelectorAll('[data-enrichment-followup-form]').forEach((followupForm) => followupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(followupForm);
    actions.submitEnrichmentFollowup(followupForm.dataset.enrichmentFollowupForm, `${fd.get('followupAnswer') || ''}`);
  }));
  el.querySelectorAll('[data-apply-docs]').forEach((btn) => btn.addEventListener('click', () => actions.applyDocSuggestions(btn.dataset.applyDocs)));
  el.querySelectorAll('[data-edit]').forEach((assetForm) => assetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(assetForm);
    actions.editAsset(assetForm.dataset.edit, Object.fromEntries(fd.entries()));
  }));
}
