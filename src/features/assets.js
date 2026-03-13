import { canDelete, canEditAssets, isAdmin } from '../roles.js';
import { detectRepeatIssues } from './workflow.js';

const ENRICHMENT_STATUS_LABELS = {
  searching_docs: 'searching docs',
  in_progress: 'searching docs',
  needs_follow_up: 'needs follow-up',
  docs_found: 'docs found',
  no_match_yet: 'no reliable match yet',
  idle: 'not started'
};

const ENRICHMENT_STATUS_STYLES = {
  searching_docs: { bg: '#dbeafe', border: '#93c5fd', text: '#1d4ed8' },
  in_progress: { bg: '#dbeafe', border: '#93c5fd', text: '#1d4ed8' },
  needs_follow_up: { bg: '#fef3c7', border: '#fbbf24', text: '#92400e' },
  docs_found: { bg: '#dcfce7', border: '#86efac', text: '#166534' },
  no_match_yet: { bg: '#fee2e2', border: '#fca5a5', text: '#991b1b' },
  idle: { bg: '#f3f4f6', border: '#d1d5db', text: '#4b5563' }
};

function renderStatusChip(status) {
  const key = status || 'idle';
  const style = ENRICHMENT_STATUS_STYLES[key] || ENRICHMENT_STATUS_STYLES.idle;
  return `<span style="display:inline-flex; align-items:center; gap:6px; border-radius:999px; border:1px solid ${style.border}; background:${style.bg}; color:${style.text}; font-size:12px; padding:2px 10px; font-weight:600;">${ENRICHMENT_STATUS_LABELS[key] || key}</span>`;
}

function renderPreviewPanel(state) {
  const preview = state.assetDraft?.preview || null;
  const status = state.assetDraft?.previewStatus || 'idle';
  const labels = {
    idle: 'idle',
    searching: 'searching',
    searching_refined: 'refining',
    found_suggestions: 'found suggestions',
    needs_follow_up: 'needs follow-up',
    no_strong_match: 'no strong match'
  };
  if (!preview && status === 'idle') {
    return '<div class="tiny">Preview assistant is idle. Use this only when you want to pre-check docs before saving.</div>';
  }

  if (!preview && ['searching', 'searching_refined'].includes(status)) {
    return '<div class="tiny">Searching official/manual sources…</div>';
  }

  if (!preview && status === 'no_strong_match') {
    return '<div class="tiny">No strong match yet. Verify manufacturer/model text and try again.</div>';
  }

  const docs = (preview?.documentationSuggestions || []).slice(0, 3);
  const support = (preview?.supportResourcesSuggestion || []).slice(0, 3);

  return `
    <div class="tiny"><b>Preview status:</b> ${labels[status] || status}</div>
    <div class="tiny">Best match: ${preview?.normalizedName || 'n/a'} (${Math.round(Number(preview?.confidence || 0) * 100)}%)</div>
    <div class="tiny">Suggested manufacturer: ${preview?.likelyManufacturer || 'n/a'} · Category: ${preview?.likelyCategory || 'n/a'}</div>
    <div class="tiny">Manual/docs: ${docs.map((d) => `<a href="${d.url}" target="_blank" rel="noopener">${d.title || d.url}</a>`).join(' | ') || 'none'}</div>
    <div class="tiny">Support links: ${support.map((d) => `<a href="${d.url}" target="_blank" rel="noopener">${d.label || d.title || d.url}</a>`).join(' | ') || 'none'}</div>
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
  const supportLinks = Array.isArray(asset.supportResourcesSuggestion) ? asset.supportResourcesSuggestion : [];
  const contacts = Array.isArray(asset.supportContactsSuggestion) ? asset.supportContactsSuggestion : [];
  const showFollowup = status === 'needs_follow_up' && asset.enrichmentFollowupQuestion;

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin:4px 0 8px;">
      ${renderStatusChip(status)}
      <span class="tiny">${status === 'in_progress' || status === 'searching_docs' ? 'Searching official/manual sources…' : ''}</span>
    </div>

    <div style="display:grid; gap:6px; margin-bottom:8px;">
      <div class="tiny"><b>Model suggestion:</b> ${asset.normalizedName || 'n/a'}${asset.enrichmentConfidence ? ` (${Math.round(Number(asset.enrichmentConfidence) * 100)}% confidence)` : ''}</div>
      <div class="tiny" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;"><b>Inferred manufacturer:</b> ${asset.manufacturerSuggestion || asset.manufacturer || 'n/a'}${manager && asset.manufacturerSuggestion && asset.manufacturerSuggestion !== asset.manufacturer ? `<button data-apply-enrichment="manufacturer" data-asset-id="${asset.id}" type="button">Apply manufacturer</button>` : ''}</div>
    </div>

    <div style="margin-bottom:10px;">
      <div class="tiny" style="font-weight:700; margin-bottom:4px;">Suggested manuals</div>
      ${suggestions.length ? suggestions.map((s) => {
    const confidence = s.confidence ? ` · ${Math.round(Number(s.confidence) * 100)}%` : '';
    const score = Number.isFinite(Number(s.matchScore)) ? ` · score ${Math.round(Number(s.matchScore))}` : '';
    const source = s.isOfficial ? ' · official' : (s.isLikelyManual ? ' · manual' : '');
    return `<div class="tiny" style="display:flex; justify-content:space-between; gap:8px; align-items:center; margin:2px 0;"><span><a href="${s.url}" target="_blank" rel="noopener">${s.title || s.url}</a>${confidence}${score}${source}</span></div>`;
  }).join('') : '<div class="tiny">No manual linked yet.</div>'}
      ${manager && suggestions.length ? `<div style="margin-top:6px;"><button data-apply-docs="${asset.id}" type="button">Apply top doc suggestions</button> <button data-apply-enrichment="manuals" data-asset-id="${asset.id}" type="button">Apply top manual</button></div>` : ''}
    </div>

    <div style="margin-bottom:10px;">
      <div class="tiny" style="font-weight:700; margin-bottom:4px;">Support links</div>
      ${supportLinks.length ? supportLinks.map((s) => `<div class="tiny"><a href="${s.url || s}" target="_blank" rel="noopener">${s.label || s.title || s.url || s}</a></div>`).join('') : '<div class="tiny">No support link linked yet.</div>'}
      ${manager && supportLinks.length ? `<div style="margin-top:6px;"><button data-apply-enrichment="support" data-asset-id="${asset.id}" type="button">Apply support link(s)</button></div>` : ''}
    </div>

    <div style="margin-bottom:10px;">
      <div class="tiny" style="font-weight:700; margin-bottom:4px;">Notes / contacts</div>
      ${contacts.length ? `<div class="tiny">${contacts.map((c) => `${c.label || c.contactType}: ${c.value}`).join(' | ')}</div>` : '<div class="tiny">No contact suggestions yet.</div>'}
      ${manager && contacts.length ? `<div style="margin-top:6px;"><button data-apply-enrichment="contacts" data-asset-id="${asset.id}" type="button">Apply contact info / notes</button></div>` : ''}
    </div>

    ${showFollowup ? `<div style="border:1px solid #fbbf24; background:#fffbeb; border-radius:8px; padding:8px; margin-bottom:10px;"><div class="tiny" style="font-weight:700; margin-bottom:4px;">Need one detail to improve the match</div><div class="tiny" style="margin-bottom:6px;">${asset.enrichmentFollowupQuestion}</div><form data-enrichment-followup-form="${asset.id}" class="grid" style="gap:4px;"><textarea name="followupAnswer" rows="2" placeholder="Add answer to improve match...">${asset.enrichmentFollowupAnswer || ''}</textarea><div style="display:flex; gap:6px; flex-wrap:wrap;"><button type="submit">Submit answer and retry</button><button data-enrich="${asset.id}" type="button">Retry without answer</button></div></form></div>` : ''}

    <div style="display:flex; gap:6px; flex-wrap:wrap;">
      <button data-enrich="${asset.id}" type="button">Search AI/docs</button>
      ${manager ? `<button data-docs="${asset.id}" type="button">Update docs review date</button>` : ''}
    </div>
  `;
}

export function renderAssets(el, state, actions) {
  const editable = canEditAssets(state.profile);
  const manager = isAdmin(state.profile);
  const repeatPatterns = detectRepeatIssues(state.tasks || []);
  el.innerHTML = `
    <h2>Assets (Operational source of truth)</h2>
    <form id="assetForm" class="grid grid-2" style="margin-bottom:12px; border:1px solid #e5e7eb; border-radius:10px; padding:10px;">
      <div class="tiny" style="grid-column:1/-1; font-weight:700;">Quick add asset</div>
      <input name="name" value="${state.assetDraft?.name || ''}" placeholder="Asset name *" required ${editable ? '' : 'disabled'} />
      <input name="manufacturer" value="${state.assetDraft?.manufacturer || ''}" placeholder="Manufacturer *" required ${editable ? '' : 'disabled'} />
      <details style="grid-column:1/-1;">
        <summary class="tiny">Advanced fields (optional)</summary>
        <div class="grid grid-2" style="margin-top:8px;">
          <input name="serialNumber" value="${state.assetDraft?.serialNumber || ''}" placeholder="Serial number" ${editable ? '' : 'disabled'} />
          <input name="id" value="${state.assetDraft?.id || ''}" placeholder="Asset ID (optional; auto-generated if blank)" ${editable ? '' : 'disabled'} />
          <input name="status" value="${state.assetDraft?.status || ''}" placeholder="Current status" ${editable ? '' : 'disabled'} />
          <input name="ownerWorkers" value="${state.assetDraft?.ownerWorkers || ''}" placeholder="Assigned workers / owners (comma-separated)" ${editable ? '' : 'disabled'} />
          <input name="manualLinks" value="${state.assetDraft?.manualLinksText || ''}" placeholder="Manual links (comma-separated URLs)" ${editable ? '' : 'disabled'} />
          <textarea name="historyNote" placeholder="Service note (added to timeline)" ${editable ? '' : 'disabled'}>${state.assetDraft?.historyNote || ''}</textarea>
        </div>
      </details>
      <details style="grid-column:1/-1;">
        <summary class="tiny">Preview before save (optional)</summary>
        <div class="grid" style="gap:6px; border:1px solid #ddd; padding:8px; border-radius:8px; margin-top:8px;">
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
            <button type="button" data-preview-lookup="1" ${(editable && !['searching', 'searching_refined'].includes(state.assetDraft?.previewStatus)) ? '' : 'disabled'}>${['searching', 'searching_refined'].includes(state.assetDraft?.previewStatus) ? 'Looking up...' : 'Run preview lookup'}</button>
            <span class="tiny">Optional pre-check only.</span>
          </div>
          ${renderPreviewPanel(state)}
        </div>
      </details>
      ${state.assetDraft?.saveFeedback ? `<div class="tiny" style="grid-column:1/-1; color:#166534;">${state.assetDraft.saveFeedback}</div>` : ''}
      <button type="submit" class="primary" ${editable && !state.assetDraft?.saving ? '' : 'disabled'}>${state.assetDraft?.saving ? 'Saving…' : 'Save asset'}</button>
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

      <div style="display:grid; gap:6px; margin:8px 0;">
        <div class="tiny"><b>Header</b></div>
        <div class="tiny">Manufacturer: ${a.manufacturer || 'n/a'} · Serial: ${a.serialNumber || 'n/a'}</div>
        <div class="tiny">Owners: ${(a.ownerWorkers || []).join(', ') || 'unassigned'} · Urgency flags: ${(openTasks.filter((t) => ['high', 'critical'].includes(t.severity)).length)}</div>
        <div class="tiny">Quick stats: open ${openTasks.length} · overdue PM ${overduePm.length} · repeat failures ${recurring.reduce((sum, r) => sum + r.count, 0)} · recent repairs ${completedTasks.length}</div>
      </div>

      <details><summary>Documentation / AI status (${docsStatus})</summary>
        <div class="tiny" style="margin:8px 0;">Linked manuals: ${(a.manualLinks || []).concat(docs.map((d) => d.url || d.title)).filter(Boolean).join(' | ') || 'No manual linked yet'}</div>
        <div class="tiny">Last reviewed: ${a.docsLastReviewedAt || 'n/a'}</div>
        <div style="margin-top:8px; border-top:1px solid #e5e7eb; padding-top:8px;">
          ${renderEnrichmentDetails(a, manager)}
        </div>
      </details>

      <details><summary>Open tasks (${openTasks.length})</summary>${openTasks.map((t) => `<div class="tiny"><a href="?tab=operations&taskId=${t.id}">${t.title || t.id}</a> · ${t.severity || 'medium'} · ${(t.assignedWorkers || []).join(', ') || 'unassigned'}</div>`).join('') || '<div class="tiny">None</div>'}</details>
      <details><summary>Recent completed tasks (${completedTasks.length})</summary>${completedTasks.map((t) => `<div class="tiny">${t.title || t.id} · ${t.closeout?.bestFixSummary || t.closeout?.fixPerformed || 'completed'}</div>`).join('') || '<div class="tiny">None</div>'}</details>
      <details><summary>AI runs (${aiRuns.length})</summary>${aiRuns.map((r) => `<div class="tiny">${r.status}: ${r.finalSummary || 'no summary'} </div>`).join('') || '<div class="tiny">None</div>'}</details>
      <details><summary>Service notes timeline (${(a.history || []).length})</summary>${(a.history || []).slice(0, 8).map((h) => `<div class="tiny">${h.at}: ${h.note || h.fixPerformed || ''}</div>`).join('') || '<div class="tiny">No history</div>'}</details>
      ${recurring.length ? `<div class="tiny"><b>Recurring patterns:</b> ${recurring.map((r) => `${r.issueCategory || 'uncategorized'} (${r.count})`).join(', ')}</div>` : ''}
      ${library.length ? `<div class="tiny"><b>Troubleshooting library:</b> ${library.map((row) => row.successfulFix || row.title).join(' | ')}</div>` : ''}

      ${isAdmin(state.profile) ? `<details><summary>Edit core fields</summary><form data-edit="${a.id}" class="grid grid-2"><input name="name" value="${a.name || ''}" placeholder="Asset name" /><input name="id" value="${a.id || ''}" placeholder="Asset ID" /><input name="serialNumber" value="${a.serialNumber || ''}" placeholder="Serial number" /><input name="manufacturer" value="${a.manufacturer || ''}" placeholder="Manufacturer" /><input name="status" value="${a.status || ''}" placeholder="Status" /><input name="manualLinks" value="${(a.manualLinks || []).join(', ')}" placeholder="Manual links (comma-separated)" /><textarea name="notes" placeholder="Notes">${a.notes || ''}</textarea><button>Save core fields</button></form></details>` : ''}

      ${canDelete(state.profile) ? `<button data-del="${a.id}" class="danger" type="button">Delete</button>` : ''}
      </details>`;
    }).join('')}</div>`;

  const form = el.querySelector('#assetForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = {
      name: `${state.assetDraft?.name || ''}`,
      serialNumber: `${state.assetDraft?.serialNumber || ''}`,
      manufacturer: `${state.assetDraft?.manufacturer || ''}`,
      id: `${state.assetDraft?.id || ''}`,
      status: `${state.assetDraft?.status || ''}`,
      ownerWorkers: `${state.assetDraft?.ownerWorkers || ''}`,
      manualLinks: `${state.assetDraft?.manualLinksText || ''}`,
      historyNote: `${state.assetDraft?.historyNote || ''}`
    };
    actions.saveAsset(p.id, p);
  });

  const nameInput = form?.querySelector('[name="name"]');
  const serialInput = form?.querySelector('[name="serialNumber"]');
  const manufacturerInput = form?.querySelector('[name="manufacturer"]');
  const idInput = form?.querySelector('[name="id"]');
  const statusInput = form?.querySelector('[name="status"]');
  const ownerWorkersInput = form?.querySelector('[name="ownerWorkers"]');
  const manualLinksInput = form?.querySelector('[name="manualLinks"]');
  const historyNoteInput = form?.querySelector('[name="historyNote"]');
  const requestPreview = () => {
    const assetName = `${state.assetDraft?.name || ''}`.trim();
    if (assetName.length < 3) return;
    const manufacturer = `${state.assetDraft?.manufacturer || ''}`.trim();
    const serialNumber = `${state.assetDraft?.serialNumber || ''}`.trim();
    const assetId = `${state.assetDraft?.id || ''}`.trim();
    actions.previewAssetLookup({ assetName, manufacturer, serialNumber, assetId });
  };

  nameInput?.addEventListener('input', () => {
    const name = nameInput?.value || '';
    actions.updateAssetDraftField('name', name);
    actions.handleDraftNameChange(name);
  });
  serialInput?.addEventListener('input', () => actions.updateAssetDraftField('serialNumber', serialInput?.value || ''));
  manufacturerInput?.addEventListener('input', () => actions.updateAssetDraftField('manufacturer', manufacturerInput?.value || ''));
  idInput?.addEventListener('input', () => actions.updateAssetDraftField('id', idInput?.value || ''));
  statusInput?.addEventListener('input', () => actions.updateAssetDraftField('status', statusInput?.value || ''));
  ownerWorkersInput?.addEventListener('input', () => actions.updateAssetDraftField('ownerWorkers', ownerWorkersInput?.value || ''));
  manualLinksInput?.addEventListener('input', () => actions.updateAssetDraftField('manualLinksText', manualLinksInput?.value || ''));
  historyNoteInput?.addEventListener('input', () => actions.updateAssetDraftField('historyNote', historyNoteInput?.value || ''));

  form?.querySelector('[data-preview-lookup]')?.addEventListener('click', requestPreview);

  form?.querySelectorAll('[data-apply-preview]').forEach((btn) => btn.addEventListener('click', () => {
    const preview = state.assetDraft?.preview || {};
    const docs = (preview.documentationSuggestions || []).map((d) => d.url).filter(Boolean);
    const support = (preview.supportResourcesSuggestion || []).map((d) => d.url).filter(Boolean);
    const contacts = (preview.supportContactsSuggestion || []).map((c) => `${c.label || c.contactType}: ${c.value}`).filter(Boolean);
    const mode = btn.dataset.applyPreview;
    if (mode === 'support' || mode === 'all') {
      actions.applyPreviewToDraft({ supportResources: support.slice(0, 3) });
    }
    if (mode === 'contacts' || mode === 'all') {
      actions.applyPreviewToDraft({ notes: contacts.join(' | '), supportContacts: preview.supportContactsSuggestion || [] });
    }
    if (mode === 'manuals' || mode === 'all') actions.applyPreviewToDraft({ manualLinks: docs.slice(0, 2), manualLinksText: docs.slice(0, 2).join(', ') });
    if (mode === 'manufacturer' || mode === 'all') actions.applyPreviewToDraft({ manufacturer: preview.likelyManufacturer || '', triggerRefinedPreview: mode === 'manufacturer' });
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
  el.querySelectorAll('[data-apply-enrichment]').forEach((btn) => btn.addEventListener('click', () => actions.applyEnrichmentSuggestions(btn.dataset.assetId, btn.dataset.applyEnrichment)));
  el.querySelectorAll('[data-edit]').forEach((assetForm) => assetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(assetForm);
    actions.editAsset(assetForm.dataset.edit, Object.fromEntries(fd.entries()));
  }));
}
