import { canDelete, canEditAssets, isAdmin, isManager } from '../roles.js';
import { detectRepeatIssues } from './workflow.js';
import {
  buildLocationOptions,
  buildLocationSummary,
  getAssetLocationRecord,
  getLocationEmptyState,
  getLocationScopeLabel
} from './locationContext.js';

function renderAssetCardFallback(asset, error) {
  const id = `${asset?.id || 'unknown'}`;
  const label = `${asset?.name || id}`;
  console.error('[render_asset_card]', { assetId: id, error });
  return `<div class="item" style="border:1px solid #fecaca; background:#fef2f2;">
    <div><b>${label}</b></div>
    <div class="tiny" style="color:#991b1b;">This asset has invalid data and could not be fully rendered.</div>
  </div>`;
}

const ENRICHMENT_STATUS_LABELS = {
  searching_docs: 'search in progress',
  in_progress: 'search in progress',
  verified_manual_found: 'verified manual found',
  strong_suggestion_found: 'strong suggestion found',
  support_resources_found: 'support resources found',
  likely_manual_unreachable: 'manual likely unreachable',
  followup_needed: 'follow-up needed',
  no_match_yet: 'no match yet',
  permission_blocked: 'permission blocked',
  lookup_failed: 'lookup failed',
  idle: 'not started'
};

const ENRICHMENT_STATUS_STYLES = {
  searching_docs: { bg: '#dbeafe', border: '#93c5fd', text: '#1d4ed8' },
  in_progress: { bg: '#dbeafe', border: '#93c5fd', text: '#1d4ed8' },
  verified_manual_found: { bg: '#dcfce7', border: '#86efac', text: '#166534' },
  strong_suggestion_found: { bg: '#dcfce7', border: '#86efac', text: '#166534' },
  support_resources_found: { bg: '#ccfbf1', border: '#5eead4', text: '#0f766e' },
  likely_manual_unreachable: { bg: '#fef3c7', border: '#fbbf24', text: '#92400e' },
  followup_needed: { bg: '#fef3c7', border: '#fbbf24', text: '#92400e' },
  no_match_yet: { bg: '#fee2e2', border: '#fca5a5', text: '#991b1b' },
  permission_blocked: { bg: '#fef3c7', border: '#fbbf24', text: '#92400e' },
  lookup_failed: { bg: '#fee2e2', border: '#fca5a5', text: '#991b1b' },
  idle: { bg: '#f3f4f6', border: '#d1d5db', text: '#4b5563' }
};

const STALE_ENRICHMENT_MS = 10 * 60 * 1000;
const LEGACY_STATUS_MAP = {
  needs_follow_up: 'followup_needed',
  docs_found: 'verified_manual_found',
  docs_blocked: 'permission_blocked',
  docs_failed: 'lookup_failed'
};

function normalizeEnrichmentStatus(status) {
  const key = `${status || 'idle'}`.trim();
  return LEGACY_STATUS_MAP[key] || key || 'idle';
}

function getTimestampValue(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isEnrichmentStale(asset) {
  const status = normalizeEnrichmentStatus(asset.enrichmentStatus || 'idle');
  if (!['searching_docs', 'in_progress'].includes(status)) return false;
  const lastTouchedAt = getTimestampValue(asset.enrichmentRequestedAt)
    || getTimestampValue(asset.enrichmentUpdatedAt)
    || getTimestampValue(asset.updatedAt)
    || getTimestampValue(asset.createdAt);
  if (!lastTouchedAt) return false;
  return (Date.now() - lastTouchedAt) >= STALE_ENRICHMENT_MS;
}

function renderStatusChip(status) {
  const key = normalizeEnrichmentStatus(status || 'idle');
  const style = ENRICHMENT_STATUS_STYLES[key] || ENRICHMENT_STATUS_STYLES.idle;
  return `<span style="display:inline-flex; align-items:center; gap:6px; border-radius:999px; border:1px solid ${style.border}; background:${style.bg}; color:${style.text}; font-size:12px; padding:2px 10px; font-weight:600;">${ENRICHMENT_STATUS_LABELS[key] || key}</span>`;
}

function renderLinkChip(url, { label = '', removeAttr = '', removable = false } = {}) {
  const text = label || url;
  return `<span style="display:inline-flex; align-items:center; gap:6px; border:1px solid #d1d5db; border-radius:999px; padding:2px 8px; margin:2px 4px 2px 0;">
    <a href="${url}" target="_blank" rel="noopener" class="tiny">${text}</a>
    ${removable ? `<button type="button" ${removeAttr} style="border:none; background:transparent; padding:0 2px; font-size:11px; line-height:1; cursor:pointer;" aria-label="Remove link">x</button>` : ''}
  </span>`;
}

function renderSuggestionSource(entry) {
  const provenance = [];
  if (entry?.verified) provenance.push('verified');
  if (entry?.isOfficial) provenance.push('official');
  if (entry?.sourceType) provenance.push(entry.sourceType);
  if (!entry?.verified && !entry?.isOfficial) provenance.push('support-only');
  return provenance.join(' | ');
}

function renderInlineFeedback(message, tone = 'info') {
  const palette = tone === 'error'
    ? { border: '#fca5a5', background: '#fef2f2', text: '#991b1b' }
    : tone === 'success'
      ? { border: '#86efac', background: '#f0fdf4', text: '#166534' }
      : { border: '#d1d5db', background: '#f9fafb', text: '#374151' };
  return `<div class="tiny" style="margin:8px 0; padding:8px 10px; border-radius:8px; border:1px solid ${palette.border}; background:${palette.background}; color:${palette.text};">${message}</div>`;
}

function renderPreviewPanel(state) {
  const preview = state.assetDraft?.preview || null;
  const status = state.assetDraft?.previewStatus || 'idle';
  if (!preview && status === 'idle') return renderInlineFeedback('Preview assistant is idle. Use this only when you want to pre-check docs before saving.', 'info');
  if (!preview && ['searching', 'searching_refined'].includes(status)) return renderInlineFeedback('Searching official/manual sources...', 'info');
  if (!preview && status === 'no_strong_match') return renderInlineFeedback('No strong match yet. Verify manufacturer/model text and try again.', 'error');

  const docs = (preview?.documentationSuggestions || []).slice(0, 3);
  const support = (preview?.supportResourcesSuggestion || []).slice(0, 3);
  const statusTone = docs.length || support.length ? 'success' : 'info';
  return `
    ${renderInlineFeedback(`Preview status: ${status}${docs.length || support.length ? ' with suggestions ready to apply.' : ' with no strong links yet.'}`, statusTone)}
    <div class="tiny">Best match: ${preview?.normalizedName || 'n/a'} (${Math.round(Number(preview?.confidence || 0) * 100)}%)</div>
    <div class="tiny">Suggested manufacturer: ${preview?.likelyManufacturer || 'n/a'} | Category: ${preview?.likelyCategory || 'n/a'}</div>
    <div class="tiny">Manual/docs: ${docs.map((entry) => `<a href="${entry.url}" target="_blank" rel="noopener">${entry.title || entry.url}</a>`).join(' | ') || 'none'}</div>
    <div class="tiny">Support links: ${support.map((entry) => `<a href="${entry.url}" target="_blank" rel="noopener">${entry.label || entry.title || entry.url}</a>`).join(' | ') || 'none'}</div>
    <div style="display:flex; gap:6px; flex-wrap:wrap; margin:6px 0;">
      <button type="button" data-apply-preview="manufacturer">Apply manufacturer</button>
      <button type="button" data-apply-preview="manuals">Apply top manual link(s)</button>
      <button type="button" data-apply-preview="support">Apply support resources</button>
      <button type="button" data-apply-preview="contacts">Apply contacts and notes</button>
      <button type="button" data-apply-preview="all">Apply all safe suggestions</button>
      <button type="button" data-clear-preview="1">Clear preview</button>
    </div>
  `;
}

function renderEnrichmentDetails(asset, manager, state) {
  const status = normalizeEnrichmentStatus(asset.enrichmentStatus || 'idle');
  const stale = isEnrichmentStale(asset);
  const suggestions = Array.isArray(asset.documentationSuggestions) ? asset.documentationSuggestions : [];
  const supportLinks = Array.isArray(asset.supportResourcesSuggestion) ? asset.supportResourcesSuggestion : [];
  const contacts = Array.isArray(asset.supportContactsSuggestion) ? asset.supportContactsSuggestion : [];
  const showFollowup = status === 'followup_needed' && asset.enrichmentFollowupQuestion;
  const linkedManuals = Array.isArray(asset.manualLinks) ? asset.manualLinks : [];
  const actionFeedback = state?.assetUi?.lastActionByAsset?.[asset.id] || null;
  const statusHelp = status === 'permission_blocked'
    ? 'Lookup could not verify docs because this role lacks access to the enrichment path.'
    : status === 'lookup_failed'
      ? (asset.enrichmentErrorMessage || 'Lookup failed before suggestions were returned.')
      : status === 'no_match_yet'
        ? 'No reliable documentation match has been found yet.'
        : '';

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin:4px 0 8px;">
      ${renderStatusChip(status)}
      <span class="tiny">${stale ? 'Search is taking longer than expected.' : (status === 'in_progress' || status === 'searching_docs' ? 'Searching official/manual sources...' : '')}</span>
    </div>
    ${actionFeedback?.message ? renderInlineFeedback(actionFeedback.message, actionFeedback.tone) : ''}
    ${statusHelp ? renderInlineFeedback(statusHelp, status === 'lookup_failed' ? 'error' : 'info') : ''}
    <div class="tiny"><b>Model suggestion:</b> ${asset.normalizedName || 'n/a'}${asset.enrichmentConfidence ? ` (${Math.round(Number(asset.enrichmentConfidence) * 100)}% confidence)` : ''}</div>
    <div class="tiny" style="margin-bottom:8px;"><b>Inferred manufacturer:</b> ${asset.manufacturerSuggestion || asset.manufacturer || 'n/a'}${manager && asset.manufacturerSuggestion && asset.manufacturerSuggestion !== asset.manufacturer ? ` <button data-apply-enrichment="manufacturer" data-asset-id="${asset.id}" type="button">Apply manufacturer</button>` : ''}</div>

    <div style="margin-bottom:10px;">
      <div class="tiny" style="font-weight:700; margin-bottom:4px;">Suggested manuals</div>
      ${suggestions.length ? suggestions.map((entry, index) => {
    const confidence = entry.confidence ? ` | ${Math.round(Number(entry.confidence) * 100)}%` : '';
    const score = Number.isFinite(Number(entry.matchScore)) ? ` | score ${Math.round(Number(entry.matchScore))}` : '';
    return `<div class="tiny" style="display:flex; justify-content:space-between; gap:8px; align-items:center; margin:2px 0;"><span><a href="${entry.url}" target="_blank" rel="noopener">${entry.title || entry.url}</a>${confidence}${score} | ${renderSuggestionSource(entry)}</span>${manager ? `<button data-apply-doc-item="${asset.id}" data-doc-index="${index}" type="button">Apply</button>` : ''}</div>`;
  }).join('') : '<div class="tiny">No suggestion yet.</div>'}
      ${manager && suggestions.length ? `<div style="margin-top:6px;"><button data-apply-docs="${asset.id}" type="button">Apply top trusted docs</button> <button data-apply-enrichment="manuals" data-asset-id="${asset.id}" type="button">Apply best manual link</button></div>` : ''}
    </div>

    <div style="margin-bottom:10px;">
      <div class="tiny" style="font-weight:700; margin-bottom:4px;">Support links</div>
      ${supportLinks.length ? supportLinks.map((entry, index) => `<div class="tiny" style="display:flex; justify-content:space-between; gap:8px; align-items:center; margin:2px 0;"><span><a href="${entry.url || entry}" target="_blank" rel="noopener">${entry.label || entry.title || entry.url || entry}</a> | ${renderSuggestionSource(entry)}</span>${manager ? `<button data-apply-support-item="${asset.id}" data-support-index="${index}" type="button">Apply</button>` : ''}</div>`).join('') : '<div class="tiny">No support suggestion yet.</div>'}
      ${manager && supportLinks.length ? `<div style="margin-top:6px;"><button data-apply-enrichment="support" data-asset-id="${asset.id}" type="button">Apply support resources</button></div>` : ''}
    </div>

    <div style="margin-bottom:10px;">
      <div class="tiny" style="font-weight:700; margin-bottom:4px;">Contacts / notes</div>
      ${contacts.length ? `<div class="tiny">${contacts.map((contact) => `${contact.label || contact.contactType}: ${contact.value}`).join(' | ')}</div>` : '<div class="tiny">No contact suggestions yet.</div>'}
      ${manager && contacts.length ? `<div style="margin-top:6px;"><button data-apply-enrichment="contacts" data-asset-id="${asset.id}" type="button">Apply contacts and notes</button></div>` : ''}
    </div>

    ${showFollowup ? `<div style="border:1px solid #fbbf24; background:#fffbeb; border-radius:8px; padding:8px; margin-bottom:10px;"><div class="tiny" style="font-weight:700; margin-bottom:4px;">Need one detail to improve the match</div><div class="tiny" style="margin-bottom:6px;">${asset.enrichmentFollowupQuestion}</div><form data-enrichment-followup-form="${asset.id}" class="grid" style="gap:4px;"><textarea name="followupAnswer" rows="2" placeholder="Add answer to improve match...">${asset.enrichmentFollowupAnswer || ''}</textarea><div style="display:flex; gap:6px; flex-wrap:wrap;"><button type="submit">Submit answer and retry</button><button data-enrich="${asset.id}" type="button">Retry without answer</button></div></form></div>` : ''}

    <div style="display:flex; gap:6px; flex-wrap:wrap;">
      <button data-enrich="${asset.id}" type="button">Run lookup</button>
      ${manager ? `<button data-docs="${asset.id}" type="button">Update docs review date</button>` : ''}
      ${manager && linkedManuals.length ? `<button data-remove-all-manuals="${asset.id}" type="button">Remove all linked manuals</button>` : ''}
      ${manager && supportLinks.length ? `<button data-remove-all-support="${asset.id}" type="button">Remove all support links</button>` : ''}
      ${manager && stale ? `<button data-clear-enrichment="${asset.id}" type="button">Clear stuck status</button>` : ''}
    </div>
  `;
}

export function renderAssets(el, state, actions) {
  const editable = canEditAssets(state.permissions);
  const manager = isManager(state.permissions);
  const repeatPatterns = detectRepeatIssues(state.tasks || []);
  const locationOptions = buildLocationOptions(state);
  const scope = buildLocationSummary(state);
  const scopedAssets = scope.scopedAssets;
  const assetTasks = scope.scopedTasks;
  const docsReadyCount = scopedAssets.filter((asset) => (asset.manualLinks || []).length > 0).length;
  const docsMissingCount = scope.assetsWithoutDocs.length;

  el.innerHTML = `
    <h2>Assets</h2>
    <div class="item" style="margin-bottom:12px;">
      <div class="row space">
        <div>
          <b>${getLocationScopeLabel(scope.selection)}</b>
          <div class="tiny">Assets here: ${scopedAssets.length} | Broken assets: ${scope.brokenAssets.length} | Open work here: ${scope.openTasks.length}</div>
          <div class="tiny">Documentation linked: ${docsReadyCount} | Missing docs: ${docsMissingCount}</div>
        </div>
        <label class="tiny" style="min-width:220px;">Filter
          <select data-location-filter>
            ${locationOptions.map((option) => `<option value="${option.key}" ${option.key === scope.selection?.key ? 'selected' : ''}>${option.label}</option>`).join('')}
          </select>
        </label>
      </div>
    </div>
    <form id="assetForm" class="grid grid-2" style="margin-bottom:12px; border:1px solid #e5e7eb; border-radius:10px; padding:10px;">
      <div class="tiny" style="grid-column:1/-1; font-weight:700;">Quick add asset</div>
      <input name="name" value="${state.assetDraft?.name || ''}" placeholder="Asset name *" required ${editable ? '' : 'disabled'} />
      <input name="manufacturer" value="${state.assetDraft?.manufacturer || ''}" placeholder="Manufacturer *" required ${editable ? '' : 'disabled'} />
      <select name="locationId" ${editable ? '' : 'disabled'}>
        <option value="">No linked location yet</option>
        ${locationOptions.filter((option) => option.id).map((option) => `<option value="${option.id}" ${option.id === state.assetDraft?.locationId ? 'selected' : ''}>${option.name}</option>`).join('')}
      </select>
      <input name="locationName" value="${state.assetDraft?.locationName || ''}" list="assetLocationNames" placeholder="Location label" ${editable ? '' : 'disabled'} />
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
      ${state.assetDraft?.saveFeedback ? `<div class="tiny" style="grid-column:1/-1; color:${state.assetDraft?.saveFeedbackTone === 'error' ? '#b91c1c' : '#166534'};">${state.assetDraft.saveFeedback}</div>` : ''}
      ${state.assetDraft?.saveSecondaryFeedback ? `<div class="tiny" style="grid-column:1/-1; color:#4b5563;">${state.assetDraft.saveSecondaryFeedback}</div>` : ''}
      ${state.assetDraft?.saveDebugContext ? `<div class="tiny" style="grid-column:1/-1; color:#6b7280;">${state.assetDraft.saveDebugContext}</div>` : ''}
      <button type="submit" class="primary" ${editable && !state.assetDraft?.saving ? '' : 'disabled'}>${state.assetDraft?.saving ? 'Saving...' : 'Save asset'}</button>
      <datalist id="assetLocationNames">${locationOptions.filter((option) => option.name && option.id).map((option) => `<option value="${option.name}"></option>`).join('')}</datalist>
    </form>

    <div class="list">${scopedAssets.map((asset) => {
      try {
        const openTasks = assetTasks.filter((task) => task.assetId === asset.id && task.status !== 'completed');
        const completedTasks = assetTasks.filter((task) => task.assetId === asset.id && task.status === 'completed').slice(0, 5);
        const aiRuns = state.taskAiRuns.filter((run) => run.assetId === asset.id || assetTasks.find((task) => task.id === run.taskId)?.assetId === asset.id).slice(0, 4);
        const docs = state.manuals.filter((manual) => manual.assetId === asset.id);
        const overduePm = state.pmSchedules.filter((schedule) => schedule.assetId === asset.id && schedule.status !== 'completed');
        const recurring = repeatPatterns.filter((pattern) => pattern.assetId === asset.id);
        const library = state.troubleshootingLibrary?.filter((row) => row.assetId === asset.id).slice(0, 5) || [];
        const docsStatus = docs.length || (asset.manualLinks || []).length ? 'linked' : 'missing';
        const location = getAssetLocationRecord(state, asset);
        return `<details class="item" id="asset-${asset.id}">
          <summary><b>${asset.name || asset.id}</b> | ${asset.status || 'active'} | ${location.label}</summary>
          <div style="display:grid; gap:6px; margin:8px 0;">
            <div class="tiny"><b>Header</b></div>
            <div class="tiny">Location: ${location.label} | Manufacturer: ${asset.manufacturer || 'n/a'} | Serial: ${asset.serialNumber || 'n/a'}</div>
            <div class="tiny">Owners: ${(asset.ownerWorkers || []).join(', ') || 'unassigned'} | Urgency flags: ${openTasks.filter((task) => ['high', 'critical'].includes(task.severity)).length}</div>
            <div class="tiny">Quick stats: open ${openTasks.length} | overdue PM ${overduePm.length} | repeat failures ${recurring.reduce((sum, row) => sum + row.count, 0)} | recent repairs ${completedTasks.length}</div>
          </div>

          <details><summary>Documentation / AI status (${docsStatus})</summary>
            <div class="tiny" style="margin:8px 0;">Linked manuals:</div>
            <div style="margin:4px 0 8px;">${(asset.manualLinks || []).length ? (asset.manualLinks || []).map((url) => renderLinkChip(url, { removable: manager, removeAttr: `data-remove-manual="${asset.id}" data-url="${encodeURIComponent(url)}"` })).join('') : renderInlineFeedback('No manual linked yet. Run lookup or apply a suggested manual below.', 'info')}</div>
            <div class="tiny" style="margin:4px 0;">Linked support links:</div>
            <div style="margin:4px 0 8px;">${(asset.supportResourcesSuggestion || []).length ? (asset.supportResourcesSuggestion || []).map((entry) => {
          const url = entry?.url || entry;
          const label = entry?.label || entry?.title || url;
          if (!url) return '';
          return renderLinkChip(url, { label, removable: manager, removeAttr: `data-remove-support="${asset.id}" data-url="${encodeURIComponent(url)}"` });
        }).join('') : renderInlineFeedback('No support links linked.', 'info')}</div>
            <div class="tiny">Last reviewed: ${asset.docsLastReviewedAt || 'n/a'}</div>
            <div style="margin-top:8px; border-top:1px solid #e5e7eb; padding-top:8px;">${renderEnrichmentDetails(asset, manager, state)}</div>
          </details>

          <details><summary>Open tasks (${openTasks.length})</summary>${openTasks.map((task) => `<div class="tiny"><a href="?tab=operations&taskId=${task.id}&location=${encodeURIComponent(scope.selection?.key || '')}">${task.title || task.id}</a> | ${task.severity || 'medium'} | ${task.location || location.label}</div>`).join('') || '<div class="tiny">None</div>'}</details>
          <details><summary>Recent completed tasks (${completedTasks.length})</summary>${completedTasks.map((task) => `<div class="tiny">${task.title || task.id} | ${task.closeout?.bestFixSummary || task.closeout?.fixPerformed || 'completed'}</div>`).join('') || '<div class="tiny">None</div>'}</details>
          <details><summary>AI runs (${aiRuns.length})</summary>${aiRuns.map((run) => `<div class="tiny">${run.status}: ${run.finalSummary || 'no summary'}</div>`).join('') || '<div class="tiny">None</div>'}</details>
          <details><summary>Service notes timeline (${(asset.history || []).length})</summary>${(asset.history || []).slice(0, 8).map((entry) => `<div class="tiny">${entry.at}: ${entry.note || entry.fixPerformed || ''}</div>`).join('') || '<div class="tiny">No history</div>'}</details>
          ${recurring.length ? `<div class="tiny"><b>Recurring patterns:</b> ${recurring.map((entry) => `${entry.issueCategory || 'uncategorized'} (${entry.count})`).join(', ')}</div>` : ''}
          ${library.length ? `<div class="tiny"><b>Troubleshooting library:</b> ${library.map((row) => row.successfulFix || row.title).join(' | ')}</div>` : ''}

          ${isAdmin(state.permissions) ? `<details><summary>Edit core fields</summary><form data-edit="${asset.id}" class="grid grid-2"><input name="name" value="${asset.name || ''}" placeholder="Asset name" /><input name="id" value="${asset.id || ''}" placeholder="Asset ID" /><input name="locationName" value="${asset.locationName || ''}" list="assetLocationNames" placeholder="Location" /><input name="serialNumber" value="${asset.serialNumber || ''}" placeholder="Serial number" /><input name="manufacturer" value="${asset.manufacturer || ''}" placeholder="Manufacturer" /><input name="status" value="${asset.status || ''}" placeholder="Status" /><input name="manualLinks" value="${(asset.manualLinks || []).join(', ')}" placeholder="Manual links (comma-separated)" /><textarea name="notes" placeholder="Notes">${asset.notes || ''}</textarea><button>Save core fields</button></form></details>` : ''}
          ${canDelete(state.permissions) ? `<button data-del="${asset.id}" class="danger" type="button">Delete</button>` : ''}
        </details>`;
      } catch (error) {
        return renderAssetCardFallback(asset, error);
      }
    }).join('') || `<div class="tiny">${getLocationEmptyState(scope.selection, 'assets', 'asset')}</div>`}</div>`;

  const form = el.querySelector('#assetForm');
  const nameInput = form?.querySelector('[name="name"]');
  const serialInput = form?.querySelector('[name="serialNumber"]');
  const manufacturerInput = form?.querySelector('[name="manufacturer"]');
  const locationIdInput = form?.querySelector('[name="locationId"]');
  const locationNameInput = form?.querySelector('[name="locationName"]');
  const idInput = form?.querySelector('[name="id"]');
  const statusInput = form?.querySelector('[name="status"]');
  const ownerWorkersInput = form?.querySelector('[name="ownerWorkers"]');
  const manualLinksInput = form?.querySelector('[name="manualLinks"]');
  const historyNoteInput = form?.querySelector('[name="historyNote"]');

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = {
      name: `${state.assetDraft?.name || ''}`,
      serialNumber: `${state.assetDraft?.serialNumber || ''}`,
      manufacturer: `${state.assetDraft?.manufacturer || ''}`,
      locationId: `${state.assetDraft?.locationId || ''}`,
      locationName: `${state.assetDraft?.locationName || ''}`,
      id: `${state.assetDraft?.id || ''}`,
      status: `${state.assetDraft?.status || ''}`,
      ownerWorkers: `${state.assetDraft?.ownerWorkers || ''}`,
      manualLinks: `${state.assetDraft?.manualLinksText || ''}`,
      historyNote: `${state.assetDraft?.historyNote || ''}`
    };
    actions.saveAsset(payload.id, payload);
  });

  const requestPreview = () => {
    const assetName = `${state.assetDraft?.name || ''}`.trim();
    if (assetName.length < 3) return;
    actions.previewAssetLookup({
      assetName,
      manufacturer: `${state.assetDraft?.manufacturer || ''}`.trim(),
      serialNumber: `${state.assetDraft?.serialNumber || ''}`.trim(),
      assetId: `${state.assetDraft?.id || ''}`.trim()
    });
  };

  nameInput?.addEventListener('input', () => {
    const name = nameInput?.value || '';
    actions.updateAssetDraftField('name', name);
    actions.handleDraftNameChange(name);
  });
  serialInput?.addEventListener('input', () => actions.updateAssetDraftField('serialNumber', serialInput?.value || ''));
  manufacturerInput?.addEventListener('input', () => actions.updateAssetDraftField('manufacturer', manufacturerInput?.value || ''));
  locationIdInput?.addEventListener('change', () => actions.updateAssetDraftField('locationId', locationIdInput?.value || ''));
  locationNameInput?.addEventListener('input', () => actions.updateAssetDraftField('locationName', locationNameInput?.value || ''));
  idInput?.addEventListener('input', () => actions.updateAssetDraftField('id', idInput?.value || ''));
  statusInput?.addEventListener('input', () => actions.updateAssetDraftField('status', statusInput?.value || ''));
  ownerWorkersInput?.addEventListener('input', () => actions.updateAssetDraftField('ownerWorkers', ownerWorkersInput?.value || ''));
  manualLinksInput?.addEventListener('input', () => actions.updateAssetDraftField('manualLinksText', manualLinksInput?.value || ''));
  historyNoteInput?.addEventListener('input', () => actions.updateAssetDraftField('historyNote', historyNoteInput?.value || ''));

  form?.querySelector('[data-preview-lookup]')?.addEventListener('click', requestPreview);
  form?.querySelectorAll('[data-apply-preview]').forEach((button) => button.addEventListener('click', () => {
    const preview = state.assetDraft?.preview || {};
    const docs = (preview.documentationSuggestions || []).map((entry) => entry.url).filter(Boolean);
    const support = (preview.supportResourcesSuggestion || []).map((entry) => entry.url).filter(Boolean);
    const contacts = (preview.supportContactsSuggestion || []).map((entry) => `${entry.label || entry.contactType}: ${entry.value}`).filter(Boolean);
    const mode = button.dataset.applyPreview;
    if (mode === 'support' || mode === 'all') actions.applyPreviewToDraft({ supportResources: support.slice(0, 3) });
    if (mode === 'contacts' || mode === 'all') actions.applyPreviewToDraft({ notes: contacts.join(' | '), supportContacts: preview.supportContactsSuggestion || [] });
    if (mode === 'manuals' || mode === 'all') actions.applyPreviewToDraft({ manualLinks: docs.slice(0, 2), manualLinksText: docs.slice(0, 2).join(', ') });
    if (mode === 'manufacturer' || mode === 'all') actions.applyPreviewToDraft({ manufacturer: preview.likelyManufacturer || '', triggerRefinedPreview: mode === 'manufacturer' });
  }));

  form?.querySelector('[data-clear-preview]')?.addEventListener('click', () => actions.clearPreview());
  el.querySelector('[data-location-filter]')?.addEventListener('change', (event) => actions.setLocationFilter(event.target.value));
  el.querySelectorAll('[data-docs]').forEach((button) => button.addEventListener('click', () => actions.markDocsReviewed(button.dataset.docs)));
  el.querySelectorAll('[data-del]').forEach((button) => button.addEventListener('click', () => actions.deleteAsset(button.dataset.del)));
  el.querySelectorAll('[data-enrich]').forEach((button) => button.addEventListener('click', () => actions.runAssetEnrichment(button.dataset.enrich)));
  el.querySelectorAll('[data-enrichment-followup-form]').forEach((followupForm) => followupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const fd = new FormData(followupForm);
    actions.submitEnrichmentFollowup(followupForm.dataset.enrichmentFollowupForm, `${fd.get('followupAnswer') || ''}`);
  }));
  el.querySelectorAll('[data-apply-docs]').forEach((button) => button.addEventListener('click', () => actions.applyDocSuggestions(button.dataset.applyDocs)));
  el.querySelectorAll('[data-apply-doc-item]').forEach((button) => button.addEventListener('click', () => actions.applySingleDocSuggestion(button.dataset.applyDocItem, Number(button.dataset.docIndex))));
  el.querySelectorAll('[data-apply-support-item]').forEach((button) => button.addEventListener('click', () => actions.applySingleSupportSuggestion(button.dataset.applySupportItem, Number(button.dataset.supportIndex))));
  el.querySelectorAll('[data-remove-manual]').forEach((button) => button.addEventListener('click', () => actions.removeManualLink(button.dataset.removeManual, decodeURIComponent(button.dataset.url || ''))));
  el.querySelectorAll('[data-remove-support]').forEach((button) => button.addEventListener('click', () => actions.removeSupportLink(button.dataset.removeSupport, decodeURIComponent(button.dataset.url || ''))));
  el.querySelectorAll('[data-remove-all-manuals]').forEach((button) => button.addEventListener('click', () => actions.removeAllManualLinks(button.dataset.removeAllManuals)));
  el.querySelectorAll('[data-remove-all-support]').forEach((button) => button.addEventListener('click', () => actions.removeAllSupportLinks(button.dataset.removeAllSupport)));
  el.querySelectorAll('[data-apply-enrichment]').forEach((button) => button.addEventListener('click', () => actions.applyEnrichmentSuggestions(button.dataset.assetId, button.dataset.applyEnrichment)));
  el.querySelectorAll('[data-clear-enrichment]').forEach((button) => button.addEventListener('click', () => actions.clearAssetEnrichmentState(button.dataset.clearEnrichment)));
  el.querySelectorAll('[data-edit]').forEach((assetForm) => assetForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const fd = new FormData(assetForm);
    actions.editAsset(assetForm.dataset.edit, Object.fromEntries(fd.entries()));
  }));
}
