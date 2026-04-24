import { canDelete, canEditAssets, isAdmin, isManager } from '../roles.js';
import { detectRepeatIssues } from './workflow.js';
import {
  buildLocationOptions,
  buildLocationSummary,
  getAssetLocationRecord,
  getLocationEmptyState,
  getLocationScopeLabel
} from './locationContext.js';
import { formatRelativeTime } from './notifications.js';
import { sortDocumentationSuggestions } from './documentationSuggestions.js';
import { getReviewableDocumentationSuggestions } from './documentationReview.js';
import { buildAssetDraftContextDebug, doesPreviewContextMatch, resolveAssetDraftContext } from './assetDraftContext.js';
import { normalizeManufacturerDisplayName } from './manufacturerNormalization.js';
import {
  buildManualReviewQueue,
  formatManualReviewLabel,
  summarizeManualReviewEvidence
} from './manualReviewQueue.js';

function renderAssetCardFallback(asset, error) {
  const id = `${asset?.id || 'unknown'}`;
  const label = `${asset?.name || id}`;
  console.error('[render_asset_card]', { assetId: id, error });
  return `<div class="item" style="border:1px solid #fecaca; background:#fef2f2;">
    <div><b>${label}</b></div>
    <div class="tiny" style="color:#991b1b;">This asset has invalid data and could not be fully rendered.</div>
  </div>`;
}

function normalizeQueryValue(value = '') {
  return `${value || ''}`.trim().toLowerCase();
}

const ENRICHMENT_STATUS_LABELS = {
  queued: 'queued',
  searching_docs: 'searching',
  in_progress: 'searching',
  verified_manual_found: 'verified manual found',
  strong_suggestion_found: 'strong suggestion found',
  support_resources_found: 'support resources found',
  likely_manual_unreachable: 'manual likely unreachable',
  followup_needed: 'follow-up needed',
  no_match_yet: 'no match yet',
  permission_blocked: 'permission blocked',
  lookup_failed: 'lookup failed',
  retry_needed: 'retry needed',
  unavailable_disabled: 'unavailable / disabled',
  idle: 'not started'
};

const ENRICHMENT_STATUS_STYLES = {
  queued: { bg: '#e0e7ff', border: '#a5b4fc', text: '#3730a3' },
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
  retry_needed: { bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },
  unavailable_disabled: { bg: '#f3f4f6', border: '#d1d5db', text: '#4b5563' },
  idle: { bg: '#f3f4f6', border: '#d1d5db', text: '#4b5563' }
};

const STALE_ENRICHMENT_MS = 3 * 60 * 1000;
const ACTIVE_ENRICHMENT_HEARTBEAT_MS = 2 * 60 * 1000;
const MANUAL_STATUS = Object.freeze({
  ATTACHED: 'manual_attached',
  QUEUED_FOR_REVIEW: 'queued_for_review',
  SUPPORT_CONTEXT_ONLY: 'support_context_only',
  NO_PUBLIC_MANUAL: 'no_public_manual',
});
const LEGACY_MANUAL_STATUS_MAP = {
  attached: MANUAL_STATUS.ATTACHED,
  review_needed: MANUAL_STATUS.QUEUED_FOR_REVIEW,
  support_only: MANUAL_STATUS.SUPPORT_CONTEXT_ONLY,
  no_manual: MANUAL_STATUS.NO_PUBLIC_MANUAL,
};
const TERMINAL_MANUAL_STATUSES = new Set([...Object.values(MANUAL_STATUS), ...Object.keys(LEGACY_MANUAL_STATUS_MAP)]);
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


function hasRecentEnrichmentHeartbeat(asset) {
  const heartbeatAt = getTimestampValue(asset.enrichmentHeartbeatAt);
  if (!heartbeatAt) return false;
  return (Date.now() - heartbeatAt) < ACTIVE_ENRICHMENT_HEARTBEAT_MS;
}

function getEffectiveEnrichmentStatus(asset = {}) {
  const normalizedStatus = normalizeEnrichmentStatus(asset.enrichmentStatus || 'idle');
  const explicitManualStatus = normalizeAssetManualStatus(asset?.manualStatus || '');
  const manualStatus = deriveAssetManualStatus(asset);
  if (manualStatus === MANUAL_STATUS.ATTACHED) return 'verified_manual_found';
  if (TERMINAL_MANUAL_STATUSES.has(explicitManualStatus) && ['queued', 'searching_docs', 'in_progress'].includes(normalizedStatus) && !hasRecentEnrichmentHeartbeat(asset)) {
    return explicitManualStatus === MANUAL_STATUS.NO_PUBLIC_MANUAL ? 'no_match_yet' : 'followup_needed';
  }
  const supportLinks = filterDisplaySupportResources(Array.isArray(asset.supportResourcesSuggestion) ? asset.supportResourcesSuggestion : []);
  const hasFollowupContext = supportLinks.length || `${asset.supportUrl || ''}`.trim() || `${asset.manualSourceUrl || ''}`.trim() || `${asset.enrichmentFollowupQuestion || ''}`.trim();
  const hasSuggestionContext = (Array.isArray(asset.documentationSuggestions) ? asset.documentationSuggestions : []).some((entry) => `${entry?.url || ''}`.trim());
  if (['queued', 'searching_docs', 'in_progress'].includes(normalizedStatus) && !hasRecentEnrichmentHeartbeat(asset) && isEnrichmentStale(asset)) {
    if (hasSuggestionContext) return hasFollowupContext ? 'followup_needed' : 'no_match_yet';
    if (hasFollowupContext) return 'followup_needed';
    return 'retry_needed';
  }
  if (!['queued', 'searching_docs', 'in_progress'].includes(normalizedStatus)) return normalizedStatus;
  if (hasRecentEnrichmentHeartbeat(asset)) return normalizedStatus;
  if (!isEnrichmentStale(asset)) return normalizedStatus;
  if (hasFollowupContext) return 'retry_needed';
  return 'retry_needed';
}

function renderStatusChip(status) {
  const key = normalizeEnrichmentStatus(status || 'idle');
  const style = ENRICHMENT_STATUS_STYLES[key] || ENRICHMENT_STATUS_STYLES.idle;
  return `<span style="display:inline-flex; align-items:center; gap:6px; border-radius:999px; border:1px solid ${style.border}; background:${style.bg}; color:${style.text}; font-size:12px; padding:2px 10px; font-weight:600;">${ENRICHMENT_STATUS_LABELS[key] || key}</span>`;
}


function renderAuditChip(label, tone = 'muted') {
  const tones = {
    good: { bg: '#dcfce7', border: '#86efac', text: '#166534' },
    warn: { bg: '#fef3c7', border: '#fbbf24', text: '#92400e' },
    bad: { bg: '#fee2e2', border: '#fca5a5', text: '#991b1b' },
    info: { bg: '#dbeafe', border: '#93c5fd', text: '#1d4ed8' },
    muted: { bg: '#f3f4f6', border: '#d1d5db', text: '#4b5563' }
  };
  const style = tones[tone] || tones.muted;
  return `<span style="display:inline-flex; align-items:center; border-radius:999px; border:1px solid ${style.border}; background:${style.bg}; color:${style.text}; font-size:11px; padding:2px 8px; font-weight:700;">${label}</span>`;
}

function renderAssetScanChips(asset, { openTasks = [], overduePm = [] } = {}) {
  const chips = [];
  const manualStatus = deriveAssetManualStatus(asset);
  if (manualStatus === MANUAL_STATUS.ATTACHED) chips.push(renderAuditChip('manual attached', 'good'));
  else if (manualStatus === MANUAL_STATUS.QUEUED_FOR_REVIEW) chips.push(renderAuditChip('manual queued for review', 'warn'));
  else if (manualStatus === MANUAL_STATUS.SUPPORT_CONTEXT_ONLY) chips.push(renderAuditChip('support context only', 'info'));
  else chips.push(renderAuditChip('no manual', 'warn'));
  if (['needs_review', 'pending_review'].includes((asset.reviewState || ''))) chips.push(renderAuditChip('review needed', 'warn'));
  if (asset.manualReviewState) chips.push(renderAuditChip(`manual ${`${asset.manualReviewState}`.replace(/_/g, ' ')}`, 'info'));
  if (['queued', 'searching_docs', 'in_progress'].includes(getEffectiveEnrichmentStatus(asset))) chips.push(renderAuditChip('enrichment running', 'info'));
  if (getEffectiveEnrichmentStatus(asset) === 'retry_needed') chips.push(renderAuditChip('retry needed', 'warn'));
  if (openTasks.length) chips.push(renderAuditChip('open issue', 'bad'));
  if (overduePm.length) chips.push(renderAuditChip('PM due', 'warn'));
  if (!openTasks.length && !overduePm.length) chips.push(renderAuditChip('healthy', 'good'));
  return `<div style="display:flex; gap:6px; flex-wrap:wrap;">${chips.join('')}</div>`;
}

function renderLinkChip(url, { label = '', linkUrl = '', linkAttrs = '', removeAttr = '', removable = false } = {}) {
  const text = label || url;
  const href = linkUrl || url;
  return `<span style="display:inline-flex; align-items:center; gap:6px; border:1px solid #d1d5db; border-radius:999px; padding:2px 8px; margin:2px 4px 2px 0;">
    <a href="${href}" target="_blank" rel="noopener" class="tiny" ${linkAttrs}>${text}</a>
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


function hasRenderableUrl(entry = {}) {
  return !!`${entry?.url || entry || ''}`.trim();
}

const JUNK_SUPPORT_DISPLAY_PATTERNS = [
  /\/(?:cart|checkout|login|register|create_account|account)\.php(?:$|[?#])/i,
  /\/shop-all-parts(?:\/|$)/i,
  /\/(?:balls|cable|cabinet-components|consumables|merchandise)(?:\/|$)/i,
  /\/(?:category|product-category)\//i,
];

function isJunkSupportDisplayUrl(url = '') {
  const value = `${url || ''}`.trim();
  if (!value) return true;
  return JUNK_SUPPORT_DISPLAY_PATTERNS.some((pattern) => pattern.test(value));
}

function filterDisplaySupportResources(entries = []) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const url = `${entry?.url || entry || ''}`.trim();
    return url && !entry?.deadPage && !entry?.unreachable && !isJunkSupportDisplayUrl(url);
  });
}

function isStoredManualUrl(value = '') {
  const normalized = `${value || ''}`.trim().toLowerCase();
  return normalized.startsWith('manual-library/') || normalized.startsWith('companies/');
}

function buildStoredManualDownloadUrl(value = '') {
  const storagePath = `${value || ''}`.trim();
  if (!isStoredManualUrl(storagePath)) return storagePath;
  return '#';
}

async function resolveStoredManualDownloadUrl(value = '', { storage = null, storageRef = null, getDownloadURL = null } = {}) {
  const storagePath = `${value || ''}`.trim();
  if (!isStoredManualUrl(storagePath)) return storagePath;
  if (!storage || typeof storageRef !== 'function' || typeof getDownloadURL !== 'function') return '';
  const manualRef = storageRef(storage, storagePath);
  const resolved = await getDownloadURL(manualRef).catch(() => '');
  return `${resolved || ''}`.trim();
}

function setManualOpenFeedback({ link, message = '', tone = 'error' } = {}) {
  const card = link?.closest?.('.item');
  if (!card) return;
  const existing = card.querySelector('[data-manual-open-feedback]');
  if (existing) existing.remove();
  if (!message) return;
  const wrapper = document.createElement('div');
  wrapper.dataset.manualOpenFeedback = '1';
  wrapper.innerHTML = renderInlineFeedback(message, tone);
  card.insertBefore(wrapper, card.firstChild);
}

function openPlaceholderManualWindow() {
  try {
    const manualWindow = window.open('', '_blank');
    if (manualWindow) {
      try {
        manualWindow.opener = null;
      } catch {
        // noop
      }
    }
    return manualWindow || null;
  } catch {
    return null;
  }
}

async function openStoredManualPath(link, state = {}) {
  const storagePath = decodeURIComponent(link?.dataset?.manualStoragePath || '');
  if (!storagePath) return;
  setManualOpenFeedback({ link, message: '' });
  const manualWindow = openPlaceholderManualWindow();
  let redirectAttempted = false;
  console.debug('[manual_open]', {
    storagePath,
    placeholderWindowObtained: !!manualWindow,
    resolvedDownloadUrlNonEmpty: false,
    redirectAttempted
  });
  const resolved = await resolveStoredManualDownloadUrl(storagePath, state.storageRuntime || {});
  const resolvedDownloadUrlNonEmpty = !!resolved;
  console.debug('[manual_open]', {
    storagePath,
    placeholderWindowObtained: !!manualWindow,
    resolvedDownloadUrlNonEmpty,
    redirectAttempted
  });
  if (resolved && manualWindow) {
    redirectAttempted = true;
    console.debug('[manual_open]', {
      storagePath,
      placeholderWindowObtained: !!manualWindow,
      resolvedDownloadUrlNonEmpty,
      redirectAttempted
    });
    if (typeof manualWindow.location?.replace === 'function') manualWindow.location.replace(resolved);
    else manualWindow.location.href = resolved;
    return;
  }
  if (resolved) {
    console.debug('[manual_open]', {
      storagePath,
      placeholderWindowObtained: !!manualWindow,
      resolvedDownloadUrlNonEmpty,
      redirectAttempted
    });
    setManualOpenFeedback({
      link,
      message: 'Popup was blocked before the manual was ready. Please allow popups and retry.',
      tone: 'error'
    });
    return;
  }
  try { manualWindow?.close?.(); } catch { /* noop */ }
  console.debug('[manual_open]', {
    storagePath,
    placeholderWindowObtained: !!manualWindow,
    resolvedDownloadUrlNonEmpty,
    redirectAttempted
  });
  setManualOpenFeedback({
    link,
    message: 'Unable to open this manual right now. Please retry or run manual lookup again.',
    tone: 'error'
  });
}

function getReviewableManualCandidateCount(asset = {}) {
  return getReviewableDocumentationSuggestions(asset).length;
}

function getDocumentationSuggestionBuckets(asset = {}) {
  const allCandidates = (Array.isArray(asset.documentationSuggestions) ? asset.documentationSuggestions : [])
    .filter((entry) => !entry?.deadPage && !entry?.unreachable && hasRenderableUrl(entry));
  const reviewable = getReviewableDocumentationSuggestions(asset);
  const reviewableUrls = new Set(reviewable.map((entry) => `${entry?.url || ''}`.trim().toLowerCase()).filter(Boolean));
  const followupCandidates = allCandidates.filter((entry) => !reviewableUrls.has(`${entry?.url || ''}`.trim().toLowerCase()));
  const strongReviewCandidates = followupCandidates.filter((entry) => ['verified_manual', 'likely_manual_install_service_doc'].includes(`${entry?.candidateBucket || ''}`));
  const weakLeads = followupCandidates.filter((entry) => `${entry?.candidateBucket || ''}` === 'weak_lead');
  return {
    reviewable,
    followupCandidates,
    allCandidates,
    strongReviewCandidates,
    weakLeads
  };
}

function renderCandidateBucket(entry = {}) {
  const bucket = `${entry?.candidateBucket || ''}`.trim();
  if (bucket === 'verified_manual') return 'verified manual';
  if (bucket === 'likely_manual_install_service_doc') return 'likely manual/install/service doc';
  if (bucket === 'support_product_page') return 'support/product page';
  if (bucket === 'weak_lead') return 'weak lead';
  return 'candidate';
}

function normalizeAssetManualStatus(value = '') {
  const normalized = `${value || ''}`.trim();
  return LEGACY_MANUAL_STATUS_MAP[normalized] || normalized;
}

function deriveAssetManualStatus(asset = {}) {
  const explicitStatus = normalizeAssetManualStatus(asset?.manualStatus || '');
  if (Object.values(MANUAL_STATUS).includes(explicitStatus)) return explicitStatus;
  const manualState = getAuthoritativeManualState(asset);
  if (manualState.hasAttachedManual) return MANUAL_STATUS.ATTACHED;
  if (getReviewableManualCandidateCount(asset) > 0) return MANUAL_STATUS.QUEUED_FOR_REVIEW;
  const supportOnlyCount = filterDisplaySupportResources(Array.isArray(asset.supportResourcesSuggestion) ? asset.supportResourcesSuggestion : []).length;
  if (supportOnlyCount > 0) return MANUAL_STATUS.SUPPORT_CONTEXT_ONLY;
  return MANUAL_STATUS.NO_PUBLIC_MANUAL;
}

function getAuthoritativeManualState(asset = {}) {
  const manualLibraryRef = `${asset?.manualLibraryRef || ''}`.trim();
  const manualStoragePath = `${asset?.manualStoragePath || ''}`.trim();
  const manualLinks = Array.isArray(asset?.manualLinks) ? asset.manualLinks : [];
  const authoritativeLinks = Array.from(new Set([
    manualStoragePath,
    ...manualLinks.map((value) => `${value || ''}`.trim()).filter((value) => isStoredManualUrl(value)),
  ].filter(Boolean))).slice(0, 5);
  return {
    manualLibraryRef,
    manualStoragePath,
    manualLinks: authoritativeLinks,
    hasAttachedManual: !!(manualLibraryRef || manualStoragePath || authoritativeLinks.length),
  };
}

function resolveStoragePreferredManualLink(asset = {}, candidateUrl = '') {
  const manualState = getAuthoritativeManualState(asset);
  const storagePreferredPath = `${manualState.manualStoragePath || manualState.manualLinks[0] || ''}`.trim();
  const hasStorageMetadata = !!storagePreferredPath;
  if (!hasStorageMetadata) {
    return {
      href: `${candidateUrl || ''}`.trim(),
      dataStoragePath: '',
      openedFromStoragePreferred: false,
      storageMetadataPresentButExternalUsed: false,
      manualSourceUrlSuppressedBecauseStorageExists: false,
    };
  }
  return {
    href: buildStoredManualDownloadUrl(storagePreferredPath),
    dataStoragePath: storagePreferredPath,
    openedFromStoragePreferred: true,
    storageMetadataPresentButExternalUsed: false,
    manualSourceUrlSuppressedBecauseStorageExists: !!`${candidateUrl || ''}`.trim(),
  };
}

function renderInlineFeedback(message, tone = 'info') {
  const palette = tone === 'error'
    ? { border: '#fca5a5', background: '#fef2f2', text: '#991b1b' }
    : tone === 'success'
      ? { border: '#86efac', background: '#f0fdf4', text: '#166534' }
      : { border: '#d1d5db', background: '#f9fafb', text: '#374151' };
  return `<div class="tiny" style="margin:8px 0; padding:8px 10px; border-radius:8px; border:1px solid ${palette.border}; background:${palette.background}; color:${palette.text};">${message}</div>`;
}

function getAttachmentGroups(asset = {}) {
  const refs = asset.attachmentRefs || {};
  return {
    images: Array.isArray(refs.images) ? refs.images : [],
    videos: Array.isArray(refs.videos) ? refs.videos : [],
    evidence: Array.isArray(refs.evidence) ? refs.evidence : []
  };
}

function renderAttachmentGroups(groups = {}, emptyLabel = 'No references recorded yet.') {
  const rows = [
    ['Images', groups.images || []],
    ['Videos', groups.videos || []],
    ['Evidence', groups.evidence || []]
  ].filter(([, values]) => values.length);
  if (!rows.length) return renderInlineFeedback(emptyLabel, 'info');
  return rows.map(([label, values]) => `<div class="tiny" style="margin:6px 0;"><b>${label}:</b> ${values.map((value) => `<span class="state-chip muted" style="margin:2px 4px 2px 0;">${value}</span>`).join('')}</div>`).join('');
}

function renderHistoryTimeline(history = []) {
  if (!history.length) return '<div class="tiny">No service history</div>';
  return history
    .slice()
    .sort((a, b) => `${b.at || ''}`.localeCompare(`${a.at || ''}`))
    .slice(0, 8)
    .map((entry) => `<div class="item" style="padding:8px; margin:6px 0;">
      <div class="row space">
        <b>${entry.type === 'task_closeout' ? 'Task closeout' : 'Asset update'}</b>
        <span class="tiny">${entry.at || 'n/a'}</span>
      </div>
      <div class="tiny" style="margin-top:4px;">${entry.note || entry.fixPerformed || entry.bestFixSummary || 'No summary recorded.'}</div>
      ${entry.detail ? `<div class="tiny" style="margin-top:4px;">${entry.detail}</div>` : ''}
      ${entry.attachments ? renderAttachmentGroups(entry.attachments, '') : ''}
    </div>`).join('');
}

function renderPreviewPanel(state) {
  const context = resolveAssetDraftContext(state, state.assetDraft || {});
  const preview = state.assetDraft?.preview || null;
  const status = state.assetDraft?.previewStatus || 'idle';
  const previewFeedback = `${state.assetDraft?.previewFeedback || ''}`.trim();
  if (!context.ok) return renderInlineFeedback(context.message, 'error');
  if (previewFeedback) return renderInlineFeedback(previewFeedback, 'info');
  if (!preview && status === 'idle') return renderInlineFeedback('Preview assistant is idle. Use this only when you want to pre-check docs before saving.', 'info');
  if (!preview && ['searching', 'searching_refined'].includes(status)) return renderInlineFeedback('Searching official/manual sources...', 'info');
  if (!preview && status === 'no_strong_match') return renderInlineFeedback('No strong match yet. Verify manufacturer/model text and try again.', 'error');
  if (preview && !doesPreviewContextMatch(context, state.assetDraft?.previewContext || {})) {
    return renderInlineFeedback('Preview suggestions are stale because the active company or location changed. Run research again before applying or saving.', 'error');
  }

  const docs = sortDocumentationSuggestions(preview?.documentationSuggestions || []).slice(0, 3);
  const support = filterDisplaySupportResources(preview?.supportResourcesSuggestion || []).slice(0, 3);
  const rawTitle = `${state.assetDraft?.name || ''}`.trim();
  const normalizedTitle = `${preview?.normalizedName || state.assetDraft?.normalizedName || ''}`.trim();
  const manufacturer = `${state.assetDraft?.manufacturer || preview?.likelyManufacturer || ''}`.trim();
  const normalizedManufacturer = normalizeManufacturerDisplayName(manufacturer);
  const titleVariantsPreview = [...new Set([
    rawTitle,
    normalizedTitle,
    rawTitle ? rawTitle.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim() : '',
    normalizedTitle ? normalizedTitle.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim() : '',
  ].filter(Boolean))].slice(0, 5);
  const weakTitle = rawTitle.length < 4 || rawTitle.split(/\s+/).filter(Boolean).length <= 1;
  const weakManufacturer = normalizedManufacturer.length < 3 || normalizedManufacturer.split(/\s+/).filter(Boolean).length <= 1;
  const adapterFamilyLabel = normalizedManufacturer
    ? `${normalizedManufacturer.toLowerCase()} adapter`
    : 'unknown adapter';
  const lookupPreviewCount = Number(preview?.previewDocumentationSuggestions || preview?.documentationSuggestions?.length || 0) || 0;
  const statusTone = docs.length || support.length ? 'success' : 'info';
  return `
    ${renderInlineFeedback(`Preview status: ${status}${docs.length || support.length ? ' with suggestions ready to apply.' : ' with no strong links yet.'}`, statusTone)}
    <div class="tiny">Context: ${buildAssetDraftContextDebug(context)}</div>
    <div class="tiny">Best match: ${preview?.normalizedName || 'n/a'} (${Math.round(Number(preview?.confidence || 0) * 100)}%)</div>
    <div class="tiny">Suggested manufacturer: ${preview?.likelyManufacturer || 'n/a'} | Category: ${preview?.likelyCategory || 'n/a'}</div>
    <div class="tiny">Normalized title: ${normalizedTitle || 'n/a'} | Normalized manufacturer: ${normalizedManufacturer || 'n/a'}</div>
    <div class="tiny">Title variants preview: ${titleVariantsPreview.join(' | ') || 'none'}</div>
    <div class="tiny">Manufacturer family / adapter path: ${adapterFamilyLabel}</div>
    <div class="tiny">Lookup quality preview: ${lookupPreviewCount} documentation suggestion${lookupPreviewCount === 1 ? '' : 's'} detected</div>
    ${(weakTitle || weakManufacturer) ? renderInlineFeedback('Title/manufacturer look weak or ambiguous. Add cabinet/model and manufacturer-family details before saving to improve lookup quality.', 'info') : ''}
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
  const status = getEffectiveEnrichmentStatus(asset);
  const stale = isEnrichmentStale(asset);
  const suggestionBuckets = getDocumentationSuggestionBuckets(asset);
  const suggestions = suggestionBuckets.reviewable;
  const followupCandidates = suggestionBuckets.followupCandidates;
  const strongReviewCandidates = suggestionBuckets.strongReviewCandidates;
  const weakLeads = suggestionBuckets.weakLeads;
  const supportLinks = filterDisplaySupportResources(Array.isArray(asset.supportResourcesSuggestion) ? asset.supportResourcesSuggestion : []);
  const strongSupportLinks = supportLinks.filter((entry) => `${entry?.candidateBucket || ''}` !== 'weak_lead');
  const hiddenDeadLinks = (Array.isArray(asset.documentationSuggestions) ? asset.documentationSuggestions : []).length - suggestionBuckets.allCandidates.length;
  const contacts = Array.isArray(asset.supportContactsSuggestion) ? asset.supportContactsSuggestion : [];
  const showFollowup = status === 'followup_needed' && asset.enrichmentFollowupQuestion;
  const manualState = getAuthoritativeManualState(asset);
  const linkedManuals = manualState.manualLinks;
  const linkedSupport = filterDisplaySupportResources(Array.isArray(asset.supportResourcesSuggestion) ? asset.supportResourcesSuggestion : []);
  const manualStatus = deriveAssetManualStatus(asset);
  const reviewEvidence = summarizeManualReviewEvidence(asset);
  const actionFeedback = state?.assetUi?.lastActionByAsset?.[asset.id] || null;
  const statusHelp = status === 'retry_needed'
    ? 'The last enrichment run appears stale. Attached manuals remain authoritative; otherwise retry or clear the stuck state.'
    : status === 'permission_blocked'
    ? 'Lookup could not verify docs because this role lacks access to the enrichment path.'
    : status === 'lookup_failed'
      ? (asset.enrichmentErrorMessage || 'Lookup failed before suggestions were returned.')
      : status === 'followup_needed'
        ? 'Lookup completed without an auto-linked manual. Review any follow-up question or support context below.'
      : status === 'no_match_yet'
        ? 'No reliable documentation match has been found yet.'
        : '';

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin:4px 0 8px;">
      ${renderStatusChip(status)}
      <span class="tiny">${status === 'retry_needed' ? 'Previous lookup appears stalled. Retry the run or repair the asset state.' : (stale ? 'Search is taking longer than expected.' : (status === 'in_progress' || status === 'searching_docs' ? 'Searching official/manual sources...' : ''))}</span>
    </div>
    ${actionFeedback?.message ? renderInlineFeedback(actionFeedback.message, actionFeedback.tone) : ''}
    ${statusHelp ? renderInlineFeedback(statusHelp, status === 'lookup_failed' ? 'error' : 'info') : ''}
    ${manualStatus === MANUAL_STATUS.ATTACHED
      ? renderInlineFeedback(`${linkedManuals.length || manualState.manualLibraryRef ? `${linkedManuals.length || 1} manual link${(linkedManuals.length || 1) === 1 ? '' : 's'}` : 'Shared manual'} attached${manualState.manualLibraryRef ? ` (library ref ${manualState.manualLibraryRef})` : ''}.`, 'success')
      : manualStatus === MANUAL_STATUS.QUEUED_FOR_REVIEW
        ? renderInlineFeedback('Manual evidence is queued for review before this asset can be treated as attached.', 'info')
        : manualStatus === MANUAL_STATUS.SUPPORT_CONTEXT_ONLY
          ? renderInlineFeedback('Only support/product context is linked right now. This asset does not have an attached manual yet.', 'info')
          : renderInlineFeedback('No public manual evidence is applied yet. Start with the best verified manual action below.', 'info')}
    <div class="tiny" style="margin:6px 0;"><b>Manual provenance:</b> ${reviewEvidence.hasManualLibraryEntry
      ? `library ref ${asset.manualLibraryRef || 'n/a'} | storage path ${asset.manualStoragePath || 'n/a'}`
      : 'No shared manual-library link yet.'}</div>
    ${reviewEvidence.selectedCandidateUrl ? `<div class="tiny"><b>Selected candidate:</b> <a href="${reviewEvidence.selectedCandidateUrl}" target="_blank" rel="noopener">${reviewEvidence.selectedCandidateTitle || reviewEvidence.selectedCandidateUrl}</a></div>` : '<div class="tiny"><b>Selected candidate:</b> n/a</div>'}
    ${reviewEvidence.evidenceRows.length ? `<div class="tiny" style="margin:4px 0;"><b>Top evidence:</b> ${reviewEvidence.evidenceRows.map((row) => `<a href="${row.url}" target="_blank" rel="noopener">${row.title}</a> (${row.provenance}${row.score ? ` | score ${Math.round(Number(row.score))}` : ''})`).join(' · ')}</div>` : ''}
    ${reviewEvidence.rejectionReasons.length ? `<div class="tiny" style="margin:4px 0;"><b>Candidate rejection reasons:</b> ${reviewEvidence.rejectionReasons.join(' · ')}</div>` : ''}
    <div class="tiny"><b>Model suggestion:</b> ${asset.normalizedName || 'n/a'}${asset.enrichmentConfidence ? ` (${Math.round(Number(asset.enrichmentConfidence) * 100)}% confidence)` : ''}</div>
    <div class="tiny" style="margin-bottom:8px;"><b>Inferred manufacturer:</b> ${normalizeManufacturerDisplayName(asset.manufacturerSuggestion || asset.manufacturer || '') || 'n/a'}${manager && asset.manufacturerSuggestion && normalizeManufacturerDisplayName(asset.manufacturerSuggestion) !== normalizeManufacturerDisplayName(asset.manufacturer) ? ` <button data-apply-enrichment="manufacturer" data-asset-id="${asset.id}" type="button">Apply manufacturer</button>` : ''}</div>

    <div style="margin-bottom:10px;">
      <div class="tiny" style="font-weight:700; margin-bottom:4px;">Suggested manuals to review</div>
      ${hiddenDeadLinks > 0 ? `<div class="tiny">Suppressed ${hiddenDeadLinks} unreachable/dead suggestion${hiddenDeadLinks === 1 ? '' : 's'}.</div>` : ''}
      ${suggestions.length ? suggestions.map((entry, index) => {
    const preferredLink = resolveStoragePreferredManualLink(asset, entry.url);
    if (preferredLink.manualSourceUrlSuppressedBecauseStorageExists) {
      console.debug('[manual_diagnostics]', {
        assetId: asset.id || '',
        openedFromStoragePreferred: preferredLink.openedFromStoragePreferred,
        storageMetadataPresentButExternalUsed: preferredLink.storageMetadataPresentButExternalUsed,
        manualSourceUrlSuppressedBecauseStorageExists: preferredLink.manualSourceUrlSuppressedBecauseStorageExists,
        manualStoragePath: preferredLink.dataStoragePath,
        suppressedSourceUrl: entry.url || '',
      });
    }
    const confidence = entry.confidence ? ` | ${Math.round(Number(entry.confidence) * 100)}%` : '';
    const score = Number.isFinite(Number(entry.matchScore)) ? ` | score ${Math.round(Number(entry.matchScore))}` : '';
    return `<div class="tiny" style="display:flex; justify-content:space-between; gap:8px; align-items:center; margin:2px 0;"><span><a href="${preferredLink.href || entry.url}" target="_blank" rel="noopener" ${preferredLink.dataStoragePath ? `data-manual-storage-path="${encodeURIComponent(preferredLink.dataStoragePath)}"` : ''}>${entry.title || entry.url}</a>${confidence}${score} | trust: ${renderSuggestionSource(entry)}${preferredLink.manualSourceUrlSuppressedBecauseStorageExists ? ' | storage-backed manual preferred' : ''}</span>${manager ? `<button data-apply-doc-item="${asset.id}" data-doc-index="${index}" type="button">Apply this manual</button>` : ''}</div>`;
  }).join('') : (strongReviewCandidates.length
    ? `<div class="tiny">No verified manual yet. ${strongReviewCandidates.length} strong review candidate${strongReviewCandidates.length === 1 ? '' : 's'} found.</div>
        ${strongReviewCandidates.slice(0, 3).map((entry) => `<div class="tiny" style="margin:2px 0;"><a href="${entry.url}" target="_blank" rel="noopener">${entry.title || entry.url}</a> | ${renderCandidateBucket(entry)} | trust: ${renderSuggestionSource(entry)} | score ${Math.round(Number(entry.matchScore || 0)) || 'n/a'}</div>`).join('')}
        ${weakLeads.length ? `<div class="tiny" style="margin-top:4px;">Suppressed ${weakLeads.length} weak lead${weakLeads.length === 1 ? '' : 's'} from manual auto-attach.</div>` : ''}`
    : (followupCandidates.length
      ? `<div class="tiny">No verified manual yet. ${followupCandidates.length} candidate link${followupCandidates.length === 1 ? '' : 's'} need follow-up or stronger evidence.</div>`
    : '<div class="tiny">No suggestion yet.</div>'))}
      ${manager && suggestions.length ? `<div style="margin-top:6px;"><button data-apply-enrichment="manuals" data-asset-id="${asset.id}" type="button" class="primary">Apply best verified manual</button> <button data-apply-docs="${asset.id}" type="button">Apply top trusted docs</button></div>` : ''}
    </div>

    <div style="margin-bottom:10px;">
      <div class="tiny" style="font-weight:700; margin-bottom:4px;">Support links and contacts</div>
      ${strongSupportLinks.length ? strongSupportLinks.map((entry, index) => `<div class="tiny" style="display:flex; justify-content:space-between; gap:8px; align-items:center; margin:2px 0;"><span><a href="${entry.url || entry}" target="_blank" rel="noopener">${entry.label || entry.title || entry.url || entry}</a> | ${renderCandidateBucket(entry)} | trust: ${renderSuggestionSource(entry)}</span>${manager ? `<button data-apply-support-item="${asset.id}" data-support-index="${index}" type="button">Apply this link</button>` : ''}</div>`).join('') : '<div class="tiny">No strong support suggestion yet.</div>'}
      ${supportLinks.length > strongSupportLinks.length ? `<div class="tiny">Hidden ${supportLinks.length - strongSupportLinks.length} weak support lead${supportLinks.length - strongSupportLinks.length === 1 ? '' : 's'}.</div>` : ''}
      ${manager && strongSupportLinks.length ? `<div style="margin-top:6px;"><button data-apply-enrichment="support" data-asset-id="${asset.id}" type="button">Apply support resources</button></div>` : ''}
    </div>

    <div style="margin-bottom:10px;">
      <div class="tiny" style="font-weight:700; margin-bottom:4px;">Contacts / notes</div>
      ${contacts.length ? `<div class="tiny">${contacts.map((contact) => `${contact.label || contact.contactType}: ${contact.value}`).join(' | ')}</div>` : '<div class="tiny">No contact suggestions yet.</div>'}
      ${manager && contacts.length ? `<div style="margin-top:6px;"><button data-apply-enrichment="contacts" data-asset-id="${asset.id}" type="button">Apply contacts and notes</button></div>` : ''}
    </div>

    ${showFollowup ? `<div style="border:1px solid #fbbf24; background:#fffbeb; border-radius:8px; padding:8px; margin-bottom:10px;"><div class="tiny" style="font-weight:700; margin-bottom:4px;">Need one detail to improve the match</div><div class="tiny" style="margin-bottom:6px;">${asset.enrichmentFollowupQuestion}</div><form data-enrichment-followup-form="${asset.id}" class="grid" style="gap:4px;"><textarea name="followupAnswer" rows="2" placeholder="Add answer to improve match...">${asset.enrichmentFollowupAnswer || ''}</textarea><div style="display:flex; gap:6px; flex-wrap:wrap;"><button type="submit">Submit answer and retry</button><button data-enrich="${asset.id}" type="button">Retry without answer</button></div></form></div>` : ''}

    <div style="display:flex; gap:6px; flex-wrap:wrap;">
      <button data-enrich="${asset.id}" type="button" class="primary">${linkedManuals.length || linkedSupport.length ? 'Refresh documentation suggestions' : 'Find documentation'}</button>
      ${manager ? `<button data-docs="${asset.id}" type="button">Mark docs reviewed</button>` : ''}
      ${manager && linkedManuals.length ? `<button data-remove-all-manuals="${asset.id}" type="button">Remove all linked manuals</button>` : ''}
      ${manager && supportLinks.length ? `<button data-remove-all-support="${asset.id}" type="button">Remove all support links</button>` : ''}
      ${manager && stale ? `<button data-clear-enrichment="${asset.id}" type="button">Clear stuck status</button>` : ''}
    </div>
  `;
}

export function renderAssets(el, state, actions) {
  const editable = canEditAssets(state.permissions);
  const draftContext = resolveAssetDraftContext(state, state.assetDraft || {});
  const previewContextMatches = !state.assetDraft?.preview || doesPreviewContextMatch(draftContext, state.assetDraft?.previewContext || {});
  const saveBlocked = !draftContext.ok || !previewContextMatches;
  const manager = isManager(state.permissions);
  const repeatPatterns = detectRepeatIssues(state.tasks || []);
  const locationOptions = buildLocationOptions(state);
  const scope = buildLocationSummary(state);
  state.assetUi = {
    searchQuery: '',
    statusFilter: 'all',
    reviewFilter: 'all',
    enrichmentFilter: 'all',
    ...(state.assetUi || {})
  };
  const assetFilter = state.route?.assetFilter || 'all';
  const scopedAssets = (scope.scopedAssets || []).filter((asset) => {
    if (assetFilter !== 'missing_docs' && state.assetUi.statusFilter === 'all') return true;
    const hasDocs = getAuthoritativeManualState(asset).hasAttachedManual;
    if (assetFilter === 'missing_docs' && hasDocs) return false;
    if (state.assetUi.statusFilter === 'missing_docs') return !hasDocs;
    if (state.assetUi.statusFilter === 'has_docs') return hasDocs;
    return true;
  }).filter((asset) => {
    const reviewState = `${asset.reviewState || ''}`.trim() || ((asset.documentationSuggestions || []).some((entry) => entry?.url) ? 'pending_review' : 'idle');
    if (state.assetUi.reviewFilter === 'all') return true;
    if (state.assetUi.reviewFilter === 'missing_docs') return !getAuthoritativeManualState(asset).hasAttachedManual;
    return reviewState === state.assetUi.reviewFilter;
  }).filter((asset) => {
    const enrichmentStatus = getEffectiveEnrichmentStatus(asset);
    if (state.assetUi.enrichmentFilter === 'all') return true;
    if (state.assetUi.enrichmentFilter === 'action_needed') return ['followup_needed', 'likely_manual_unreachable', 'no_match_yet', 'lookup_failed', 'permission_blocked', 'retry_needed'].includes(enrichmentStatus);
    if (state.assetUi.enrichmentFilter === 'in_progress') return ['queued', 'searching_docs', 'in_progress'].includes(enrichmentStatus);
    return enrichmentStatus === state.assetUi.enrichmentFilter;
  }).filter((asset) => {
    const query = normalizeQueryValue(state.assetUi.searchQuery || '');
    if (!query) return true;
    const haystack = [asset.id, asset.name, asset.manufacturer, asset.model, asset.serialNumber, asset.locationName, asset.location].map(normalizeQueryValue).join(' ');
    return haystack.includes(query);
  });
  const activeAssetFilters = [
    state.assetUi.searchQuery ? `search: "${state.assetUi.searchQuery}"` : '',
    state.assetUi.statusFilter !== 'all' ? `docs: ${state.assetUi.statusFilter.replace('_', ' ')}` : '',
    state.assetUi.reviewFilter !== 'all' ? `review: ${state.assetUi.reviewFilter.replace('_', ' ')}` : '',
    state.assetUi.enrichmentFilter !== 'all' ? `enrichment: ${state.assetUi.enrichmentFilter.replace('_', ' ')}` : ''
  ].filter(Boolean);
  const assetTasks = scope.scopedTasks;
  const docsReadyCount = (scope.scopedAssets || []).filter((asset) => getAuthoritativeManualState(asset).hasAttachedManual).length;
  const docsMissingCount = scope.assetsWithoutDocs.length;
  const bulkDocRerunRunning = state.assetUi?.bulkDocRerunStatus === 'running';
  const bulkDocRerunProgress = state.assetUi?.bulkDocRerunProgress || null;
  const bulkDocRerunCurrentLabel = `${bulkDocRerunProgress?.currentAssetName || bulkDocRerunProgress?.currentAssetId || ''}`.trim();
  const manualReviewQueue = buildManualReviewQueue(scope.scopedAssets || [], getEffectiveEnrichmentStatus);

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
      <div class="grid grid-2 mt">
        <label class="tiny">Asset search
          <input type="search" data-asset-search placeholder="Name, manufacturer, model, serial, location" value="${state.assetUi.searchQuery || ''}" />
        </label>
        <label class="tiny">Docs status
          <select data-asset-docs-filter>
            <option value="all" ${state.assetUi.statusFilter === 'all' ? 'selected' : ''}>All docs states</option>
            <option value="missing_docs" ${state.assetUi.statusFilter === 'missing_docs' ? 'selected' : ''}>Missing docs</option>
            <option value="has_docs" ${state.assetUi.statusFilter === 'has_docs' ? 'selected' : ''}>Has docs</option>
          </select>
        </label>
        <label class="tiny">Review state
          <select data-asset-review-filter>
            <option value="all" ${state.assetUi.reviewFilter === 'all' ? 'selected' : ''}>All review states</option>
            <option value="pending_review" ${state.assetUi.reviewFilter === 'pending_review' ? 'selected' : ''}>Pending review</option>
            <option value="approved" ${state.assetUi.reviewFilter === 'approved' ? 'selected' : ''}>Approved</option>
            <option value="rejected" ${state.assetUi.reviewFilter === 'rejected' ? 'selected' : ''}>Rejected</option>
            <option value="idle" ${state.assetUi.reviewFilter === 'idle' ? 'selected' : ''}>Idle</option>
            <option value="missing_docs" ${state.assetUi.reviewFilter === 'missing_docs' ? 'selected' : ''}>Missing docs</option>
          </select>
        </label>
        <label class="tiny">Enrichment state
          <select data-asset-enrichment-filter>
            <option value="all" ${state.assetUi.enrichmentFilter === 'all' ? 'selected' : ''}>All enrichment states</option>
            <option value="action_needed" ${state.assetUi.enrichmentFilter === 'action_needed' ? 'selected' : ''}>Action needed</option>
            <option value="in_progress" ${state.assetUi.enrichmentFilter === 'in_progress' ? 'selected' : ''}>In progress</option>
            <option value="verified_manual_found" ${state.assetUi.enrichmentFilter === 'verified_manual_found' ? 'selected' : ''}>Verified manual found</option>
            <option value="followup_needed" ${state.assetUi.enrichmentFilter === 'followup_needed' ? 'selected' : ''}>Follow-up needed</option>
          </select>
        </label>
      </div>
      <div class="row space mt">
        <div class="tiny">Showing ${scopedAssets.length} of ${(scope.scopedAssets || []).length} assets in this location scope.</div>
        <button type="button" data-clear-asset-filters ${activeAssetFilters.length ? '' : 'disabled'}>Clear filters</button>
      </div>
      <div class="tiny mt">Active filters: ${activeAssetFilters.length ? activeAssetFilters.join(' · ') : 'none'}</div>
      <div class="row mt" style="flex-wrap:wrap; align-items:center;">
        <button type="button" data-bulk-visible-enrich class="primary" ${bulkDocRerunRunning ? 'disabled' : ''}>Re-search docs for all visible assets</button>
        ${bulkDocRerunRunning && bulkDocRerunProgress ? `<span class="tiny">Re-searching docs: ${bulkDocRerunProgress.completed} / ${bulkDocRerunProgress.totalTargeted} complete${bulkDocRerunCurrentLabel ? ` · Current: ${bulkDocRerunCurrentLabel}` : ''}</span>` : ''}
      </div>
      ${bulkDocRerunProgress ? `<div class="tiny mt">Bulk docs progress · targeted ${bulkDocRerunProgress.totalTargeted} · completed ${bulkDocRerunProgress.completed} · succeeded ${bulkDocRerunProgress.succeeded} · failed ${bulkDocRerunProgress.failed} · skipped ${bulkDocRerunProgress.skipped}</div>` : ''}
      ${state.assetUi?.bulkDocRerunSummary ? `<div class="tiny mt">${state.assetUi.bulkDocRerunSummary}</div>` : ''}
    </div>
    ${assetFilter === 'missing_docs' ? '<div class="inline-state warn">Showing assets missing docs only.</div>' : ''}
    <div class="item" style="margin-bottom:12px; overflow:auto;">
      <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
        <div>
          <b>Manual review queue</b>
          <div class="tiny">Unresolved/manual-review-needed assets with candidate evidence, provenance, and next actions.</div>
        </div>
        <div class="tiny">Queue items: ${manualReviewQueue.length}</div>
      </div>
      ${manualReviewQueue.length ? `<table class="tiny" style="width:100%; border-collapse:collapse; margin-top:8px;"><thead><tr><th>Asset</th><th>Context</th><th>Status</th><th>Selected candidate</th><th>Top evidence + provenance</th><th>Rejected reasons</th><th>Manual-library</th><th>Case bucket</th><th>Actions</th></tr></thead><tbody>${manualReviewQueue.map((item) => {
        const asset = item.asset || {};
        const location = getAssetLocationRecord(state, asset);
        const evidenceSummary = item.evidenceRows.length
          ? item.evidenceRows.map((row) => `<div><a href="${row.url}" target="_blank" rel="noopener">${row.title}</a><div>${row.provenance}${row.score ? ` · score ${Math.round(Number(row.score))}` : ''}</div></div>`).join('')
          : 'No candidate evidence';
        const rejectionSummary = item.rejectionReasons.length ? item.rejectionReasons.join('<br/>') : 'No explicit rejection reasons recorded';
        const candidateLabel = item.selectedCandidateUrl
          ? `<a href="${item.selectedCandidateUrl}" target="_blank" rel="noopener">${item.selectedCandidateTitle || item.selectedCandidateUrl}</a>`
          : 'n/a';
        return `<tr>
          <td><b>${asset.name || asset.id}</b><div>${asset.manufacturer || 'n/a'}</div><div><a href="#asset-${asset.id}">Open details</a></div></td>
          <td>${location.label}<div>${asset.companyName || state.company?.name || 'company scope'}</div></td>
          <td>manual: ${formatManualReviewLabel(item.manualStatus)}<br/>review: ${formatManualReviewLabel(item.manualReviewState)}<br/>enrichment: ${formatManualReviewLabel(item.effectiveStatus)}<br/>terminal: ${formatManualReviewLabel(item.enrichmentTerminalReason)}</td>
          <td>${candidateLabel}</td>
          <td>${evidenceSummary}</td>
          <td>${rejectionSummary}</td>
          <td>${item.hasManualLibraryEntry ? 'linked' : 'none'}</td>
          <td>${formatManualReviewLabel(item.caseType)}</td>
          <td style="min-width:220px;">
            <div style="display:flex; gap:4px; flex-wrap:wrap;">
              <button type="button" data-enrich="${asset.id}" class="primary">Rerun lookup</button>
              <button type="button" data-queue-approve="${asset.id}" data-queue-candidate-url="${encodeURIComponent(item.selectedCandidateUrl || '')}" ${item.selectedCandidateUrl ? '' : 'disabled'}>Approve candidate</button>
              <button type="button" data-queue-reject="${asset.id}" data-queue-candidate-url="${encodeURIComponent(item.selectedCandidateUrl || '')}" ${item.selectedCandidateUrl ? '' : 'disabled'}>Reject candidate</button>
              <button type="button" data-queue-needs-title="${asset.id}">Needs title clarification</button>
              <button type="button" data-queue-flag-library="${asset.id}" ${item.hasManualLibraryEntry ? '' : 'disabled'}>Flag manual-library row</button>
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody></table>` : '<div class="tiny" style="margin-top:8px;">No unresolved manual review queue items in this scope.</div>'}
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
          <textarea name="imageRefsText" placeholder="Image references: URLs, filenames, shared-drive refs" ${editable ? '' : 'disabled'}>${state.assetDraft?.imageRefsText || ''}</textarea>
          <textarea name="videoRefsText" placeholder="Video references: URLs or filenames" ${editable ? '' : 'disabled'}>${state.assetDraft?.videoRefsText || ''}</textarea>
          <textarea name="evidenceRefsText" placeholder="Evidence refs: logs, measurements, ticket links" ${editable ? '' : 'disabled'}>${state.assetDraft?.evidenceRefsText || ''}</textarea>
        </div>
      </details>
      <details style="grid-column:1/-1;">
        <summary class="tiny">Preview before save (optional)</summary>
        <div class="grid" style="gap:6px; border:1px solid #ddd; padding:8px; border-radius:8px; margin-top:8px;">
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
            <button type="button" data-preview-lookup="1" ${(editable && draftContext.ok && !['searching', 'searching_refined'].includes(state.assetDraft?.previewStatus)) ? '' : 'disabled'}>${['searching', 'searching_refined'].includes(state.assetDraft?.previewStatus) ? 'Researching...' : 'Research this title'}</button>
            <span class="tiny">Uses the same shared research engine as bulk intake. Run this only after the company/location context is stable.</span>
          </div>
          ${renderPreviewPanel(state)}
        </div>
      </details>
      ${!draftContext.ok ? `<div class="tiny" style="grid-column:1/-1; color:#b91c1c;">${draftContext.message}</div>` : ''}
      ${draftContext.ok ? `<div class="tiny" style="grid-column:1/-1; color:#6b7280;">Active asset draft context: ${buildAssetDraftContextDebug(draftContext)}</div>` : ''}
      ${(draftContext.ok && !previewContextMatches) ? `<div class="tiny" style="grid-column:1/-1; color:#b91c1c;">Preview suggestions were generated under a different company or location. Re-run research before saving.</div>` : ''}
      ${state.assetDraft?.saveFeedback ? `<div class="tiny" style="grid-column:1/-1; color:${state.assetDraft?.saveFeedbackTone === 'error' ? '#b91c1c' : '#166534'};">${state.assetDraft.saveFeedback}</div>` : ''}
      ${state.assetDraft?.saveSecondaryFeedback ? `<div class="tiny" style="grid-column:1/-1; color:#4b5563;">${state.assetDraft.saveSecondaryFeedback}</div>` : ''}
      ${state.assetDraft?.saveDebugContext ? `<div class="tiny" style="grid-column:1/-1; color:#6b7280;">${state.assetDraft.saveDebugContext}</div>` : ''}
      <button type="submit" class="primary" ${editable && !state.assetDraft?.saving && !saveBlocked ? '' : 'disabled'}>${state.assetDraft?.saving ? 'Saving...' : 'Save asset'}</button>
      <datalist id="assetLocationNames">${locationOptions.filter((option) => option.name && option.id).map((option) => `<option value="${option.name}"></option>`).join('')}</datalist>
    </form>


    <div class="item" style="margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-start;">
        <div>
          <b>Research Titles</b>
          <div class="tiny">Paste comma-separated titles or one title per line, run research, then review manual-ready vs source/support-only rows before import.</div>
        </div>
        <div class="tiny">Status: ${state.assetUi?.bulkIntakeStatus || 'idle'}</div>
      </div>
      <textarea data-bulk-intake-text rows="4" placeholder="Quick Drop, Jurassic Park, Virtual Rabbids, Air FX">${state.assetUi?.bulkIntakeText || ''}</textarea>
      <div class="row mt" style="flex-wrap:wrap;">
        <button type="button" data-bulk-parse>Prepare rows</button>
        <button type="button" data-bulk-enrich ${state.assetUi?.bulkIntakeRows?.length ? '' : 'disabled'}>${state.assetUi?.bulkIntakeStatus === 'enriching' ? 'Researching...' : 'Research titles'}</button>
        <button type="button" data-bulk-export ${state.assetUi?.bulkIntakeRows?.length ? '' : 'disabled'}>Export reviewed CSV</button>
        <button type="button" class="primary" data-bulk-import ${state.assetUi?.bulkIntakeRows?.length ? '' : 'disabled'}>Create accepted assets</button>
      </div>
      ${(state.assetUi?.bulkIntakeErrors || []).length ? `<div class="inline-state error mt"><ul>${(state.assetUi.bulkIntakeErrors || []).map((error) => `<li>${error}</li>`).join('')}</ul></div>` : ''}
    </div>

    ${(state.assetUi?.onboardingValidationErrors || []).length ? `<div class="item" style="border:1px solid #fca5a5; background:#fef2f2;"><b>Import validation issues</b><ul>${(state.assetUi?.onboardingValidationErrors || []).slice(0, 8).map((error) => `<li class="tiny">${error}</li>`).join('')}</ul></div>` : ''}
    ${(state.assetUi?.bulkIntakeRows || []).length ? `<div class="item" style="margin-bottom:10px; overflow:auto;"><b>Research review grid</b><div class="tiny">Green = manual ready. Yellow = follow-up or family review. Red = unresolved. Only manual-ready rows should become docs found.</div><table class="tiny" style="width:100%; border-collapse:collapse; margin-top:8px;"><thead><tr><th>Original</th><th>Normalized</th><th>Manufacturer</th><th>Match type</th><th>Manual ready</th><th>Review required</th><th>Manual URL</th><th>Manual source URL</th><th>Support URL</th><th>Contact info</th><th>Confidence</th><th>Notes</th><th>Row status/action</th></tr></thead><tbody>${(state.assetUi.bulkIntakeRows || []).map((row, index) => { const tone = row.rowStatus === 'good_match' ? '#ecfdf5' : (row.rowStatus === 'needs_review' ? '#fffbeb' : '#fef2f2'); return `<tr data-bulk-row="${index}" style="background:${tone};"><td><input name="name" value="${row.name || ''}" /></td><td><input name="normalizedName" value="${row.normalizedTitle || row.normalizedName || ''}" /></td><td><input name="manufacturer" value="${row.manufacturer || row.manufacturerSuggestion || ''}" /></td><td><input name="matchType" value="${row.matchType || ''}" /></td><td><input name="manualReady" value="${typeof row.manualReady === 'boolean' ? String(row.manualReady) : (row.manualReady || '')}" /></td><td><input name="reviewRequired" value="${typeof row.reviewRequired === 'boolean' ? String(row.reviewRequired) : (row.reviewRequired || '')}" /></td><td><input name="manualUrl" value="${row.manualUrl || ''}" placeholder="https://..." /></td><td><input name="manualSourceUrl" value="${row.manualSourceUrl || ''}" placeholder="https://..." /></td><td><input name="supportUrl" value="${row.supportUrl || ''}" placeholder="https://support" /></td><td><input name="supportEmail" value="${row.supportEmail || ''}" placeholder="email" /><input name="supportPhone" value="${row.supportPhone || ''}" placeholder="phone" /></td><td><input name="matchConfidence" value="${row.matchConfidence || ''}" style="width:70px;" /></td><td><textarea name="matchNotes" rows="2">${row.matchNotes || ''}</textarea></td><td><select name="rowStatus"><option value="good_match" ${row.rowStatus === 'good_match' ? 'selected' : ''}>accepted-ready</option><option value="needs_review" ${row.rowStatus === 'needs_review' ? 'selected' : ''}>needs review</option><option value="unresolved" ${row.rowStatus === 'unresolved' ? 'selected' : ''}>unresolved</option><option value="skipped" ${row.rowStatus === 'skipped' ? 'selected' : ''}>skip</option></select><div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:4px;"><button type="button" data-bulk-accept="${index}">Accept</button><button type="button" data-bulk-skip="${index}">Skip</button></div></td></tr>`; }).join('')}</tbody></table></div>` : ''}

    <div class="list">${scopedAssets.map((asset) => {
      try {
        const openTasks = assetTasks.filter((task) => task.assetId === asset.id && task.status !== 'completed');
        const completedTasks = assetTasks.filter((task) => task.assetId === asset.id && task.status === 'completed').slice(0, 5);
        const aiRuns = state.taskAiRuns.filter((run) => run.assetId === asset.id || assetTasks.find((task) => task.id === run.taskId)?.assetId === asset.id).slice(0, 4);
        const docs = state.manuals.filter((manual) => manual.assetId === asset.id);
        const overduePm = state.pmSchedules.filter((schedule) => schedule.assetId === asset.id && schedule.status !== 'completed');
        const recurring = repeatPatterns.filter((pattern) => pattern.assetId === asset.id);
        const library = state.troubleshootingLibrary?.filter((row) => row.assetId === asset.id).slice(0, 5) || [];
        const manualState = getAuthoritativeManualState(asset);
        const docsStatus = docs.length || manualState.hasAttachedManual ? 'linked' : 'missing';
        const manualStatus = deriveAssetManualStatus(asset);
        const auditEntries = (state.auditLogs || []).filter((entry) => entry.entityType === 'assets' && entry.entityId === asset.id).slice(0, 6);
        const location = getAssetLocationRecord(state, asset);
        return `<details class="item" id="asset-${asset.id}" ${state.route?.assetId === asset.id ? 'open' : ''}>
          <summary><b>${asset.name || asset.id}</b> | ${asset.status || 'active'} | ${location.label} | ${renderStatusChip(asset.enrichmentStatus || 'idle')}</summary>
          <div style="display:grid; gap:6px; margin:8px 0;">
            <div class="tiny"><b>Header</b></div>
            <div class="tiny">Location: ${location.label} | Manufacturer: ${asset.manufacturer || 'n/a'} | Serial: ${asset.serialNumber || 'n/a'}</div>
            <div class="tiny">Owners: ${(asset.ownerWorkers || []).join(', ') || 'unassigned'} | Urgency flags: ${openTasks.filter((task) => ['high', 'critical'].includes(task.severity)).length}</div>
            <div class="tiny">Quick stats: open ${openTasks.length} | overdue PM ${overduePm.length} | repeat failures ${recurring.reduce((sum, row) => sum + row.count, 0)} | recent repairs ${completedTasks.length}</div>
            <div class="tiny">Manual outcome: ${manualStatus === MANUAL_STATUS.ATTACHED ? 'manual attached' : manualStatus === MANUAL_STATUS.SUPPORT_CONTEXT_ONLY ? 'support context only' : manualStatus === MANUAL_STATUS.QUEUED_FOR_REVIEW ? 'manual queued for review' : 'no public manual found'}</div>
            ${asset.enrichmentTerminalReason ? `<div class="tiny">Terminal reason: ${asset.enrichmentTerminalReason.replace(/_/g, ' ')}</div>` : ''}
            ${asset.manualReviewState ? `<div class="tiny">Manual review state: ${asset.manualReviewState.replace(/_/g, ' ')}</div>` : ''}
            ${renderAssetScanChips(asset, { docsStatus, openTasks, overduePm })}
            <div class="action-row">
              ${openTasks[0] ? `<a href="?tab=operations&taskId=${encodeURIComponent(openTasks[0].id)}&location=${encodeURIComponent(scope.selection?.key || '')}">Open active task</a>` : ''}
              ${completedTasks[0] ? `<a href="?tab=operations&taskId=${encodeURIComponent(completedTasks[0].id)}&location=${encodeURIComponent(scope.selection?.key || '')}">Open latest completed task</a>` : ''}
            </div>
          </div>

          <details><summary>Documentation / AI status (${docsStatus})</summary>
            <div class="tiny" style="margin:8px 0;"><b>Manual status:</b> ${deriveAssetManualStatus(asset).replace('_', ' ')}</div>
            <div class="tiny" style="margin:4px 0;">Attached manual:</div>
            <div style="margin:4px 0 8px;">${manualState.manualLinks.length ? manualState.manualLinks.map((url) => renderLinkChip(url, {
          linkUrl: buildStoredManualDownloadUrl(url),
          linkAttrs: isStoredManualUrl(url) ? `data-manual-storage-path="${encodeURIComponent(url)}"` : '',
          removable: manager,
          removeAttr: `data-remove-manual="${asset.id}" data-url="${encodeURIComponent(url)}"`
        })).join('') : (manualState.manualLibraryRef ? renderInlineFeedback(`Shared manual attached via library ref ${manualState.manualLibraryRef}.`, 'success') : renderInlineFeedback('No attached manual yet. Run lookup or approve a suggested manual below.', 'info'))}</div>
            <div class="tiny" style="margin:4px 0;">Linked support links:</div>
            <div style="margin:4px 0 8px;">${filterDisplaySupportResources(asset.supportResourcesSuggestion || []).length ? filterDisplaySupportResources(asset.supportResourcesSuggestion || []).map((entry) => {
          const url = entry?.url || entry;
          const label = entry?.label || entry?.title || url;
          if (!url) return '';
          return renderLinkChip(url, { label, removable: manager, removeAttr: `data-remove-support="${asset.id}" data-url="${encodeURIComponent(url)}"` });
        }).join('') : renderInlineFeedback('No support links linked.', 'info')}</div>
            <div class="tiny">Last reviewed: ${asset.docsLastReviewedAt || 'n/a'} | Last enrichment run: ${asset.enrichmentLastRunAt || asset.enrichmentUpdatedAt || 'n/a'}</div>
            <div style="margin-top:8px; border-top:1px solid #e5e7eb; padding-top:8px;">${renderEnrichmentDetails(asset, manager, state)}</div>
          </details>

          <details><summary>Open tasks (${openTasks.length})</summary>${openTasks.map((task) => `<div class="tiny"><a href="?tab=operations&taskId=${task.id}&location=${encodeURIComponent(scope.selection?.key || '')}">${task.title || task.id}</a> | ${task.severity || 'medium'} | ${task.location || location.label}</div>`).join('') || '<div class="tiny">None</div>'}</details>
          <details><summary>Recent completed tasks (${completedTasks.length})</summary>${completedTasks.map((task) => `<div class="tiny">${task.title || task.id} | ${task.closeout?.bestFixSummary || task.closeout?.fixPerformed || 'completed'}</div>`).join('') || '<div class="tiny">None</div>'}</details>
          <details><summary>AI runs (${aiRuns.length})</summary>${aiRuns.map((run) => `<div class="tiny">${run.status}: ${run.finalSummary || 'no summary'}</div>`).join('') || '<div class="tiny">None</div>'}</details>
          <details><summary>Service notes timeline (${(asset.history || []).length})</summary>${renderHistoryTimeline(asset.history || [])}</details>
          <details><summary>Audit history (${auditEntries.length})</summary>${auditEntries.map((entry) => `<div class="tiny">${entry.summary || entry.actionType || entry.action} · ${entry.actorName || entry.userIdentity || 'unknown'} · ${formatRelativeTime(entry.timestamp)}</div>`).join('') || '<div class="tiny">No audit history yet.</div>'}</details>
          <details><summary>Image / video / evidence refs</summary>${renderAttachmentGroups(getAttachmentGroups(asset), 'No asset-level references recorded yet.')}</details>
          ${recurring.length ? `<div class="tiny"><b>Recurring patterns:</b> ${recurring.map((entry) => `${entry.issueCategory || 'uncategorized'} (${entry.count})`).join(', ')}</div>` : ''}
          ${library.length ? `<div class="tiny"><b>Troubleshooting library:</b> ${library.map((row) => row.successfulFix || row.title).join(' | ')}</div>` : ''}

          ${isAdmin(state.permissions) ? `<details><summary>Edit core fields</summary><form data-edit="${asset.id}" class="grid grid-2"><input name="name" value="${asset.name || ''}" placeholder="Asset name" /><input name="id" value="${asset.id || ''}" placeholder="Asset ID" /><input name="locationName" value="${asset.locationName || ''}" list="assetLocationNames" placeholder="Location" /><input name="serialNumber" value="${asset.serialNumber || ''}" placeholder="Serial number" /><input name="manufacturer" value="${asset.manufacturer || ''}" placeholder="Manufacturer" /><input name="status" value="${asset.status || ''}" placeholder="Status" /><input name="manualLinks" value="${manualState.manualLinks.join(', ')}" placeholder="Manual links (comma-separated)" /><textarea name="notes" placeholder="Notes">${asset.notes || ''}</textarea><button>Save core fields</button></form></details>` : ''}
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
  const imageRefsInput = form?.querySelector('[name="imageRefsText"]');
  const videoRefsInput = form?.querySelector('[name="videoRefsText"]');
  const evidenceRefsInput = form?.querySelector('[name="evidenceRefsText"]');

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
      historyNote: `${state.assetDraft?.historyNote || ''}`,
      imageRefsText: `${state.assetDraft?.imageRefsText || ''}`,
      videoRefsText: `${state.assetDraft?.videoRefsText || ''}`,
      evidenceRefsText: `${state.assetDraft?.evidenceRefsText || ''}`,
      notes: `${state.assetDraft?.notes || ''}`
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
  imageRefsInput?.addEventListener('input', () => actions.updateAssetDraftField('imageRefsText', imageRefsInput?.value || ''));
  videoRefsInput?.addEventListener('input', () => actions.updateAssetDraftField('videoRefsText', videoRefsInput?.value || ''));
  evidenceRefsInput?.addEventListener('input', () => actions.updateAssetDraftField('evidenceRefsText', evidenceRefsInput?.value || ''));

  form?.querySelector('[data-preview-lookup]')?.addEventListener('click', requestPreview);
  form?.querySelectorAll('[data-apply-preview]').forEach((button) => button.addEventListener('click', () => {
    const preview = state.assetDraft?.preview || {};
    const docs = (preview.documentationSuggestions || []).map((entry) => entry.url).filter(Boolean);
    const support = (preview.supportResourcesSuggestion || []).map((entry) => entry.url).filter(Boolean);
    const contacts = (preview.supportContactsSuggestion || []).map((entry) => `${entry.label || entry.contactType}: ${entry.value}`).filter(Boolean);
    if (!draftContext.ok || !previewContextMatches) return;
    const mode = button.dataset.applyPreview;
    if (mode === 'support' || mode === 'all') actions.applyPreviewToDraft({ supportResources: support.slice(0, 3) });
    if (mode === 'contacts' || mode === 'all') actions.applyPreviewToDraft({ notes: contacts.join(' | '), supportContacts: preview.supportContactsSuggestion || [] });
    if (mode === 'manuals' || mode === 'all') actions.applyPreviewToDraft({ manualLinks: docs.slice(0, 2), manualLinksText: docs.slice(0, 2).join(', ') });
    if (mode === 'manufacturer' || mode === 'all') actions.applyPreviewToDraft({ manufacturer: preview.likelyManufacturer || '', triggerRefinedPreview: mode === 'manufacturer' });
  }));

  form?.querySelector('[data-clear-preview]')?.addEventListener('click', () => actions.clearPreview());

  const bulkTextArea = el.querySelector('[data-bulk-intake-text]');
  bulkTextArea?.addEventListener('input', () => { state.assetUi.bulkIntakeText = bulkTextArea.value; });
  el.querySelector('[data-bulk-parse]')?.addEventListener('click', () => actions.startBulkAssetIntake(`${bulkTextArea?.value || ''}`, { defaultLocationName: `${state.assetDraft?.locationName || ''}`.trim() }));
  el.querySelector('[data-bulk-enrich]')?.addEventListener('click', () => actions.enrichBulkIntakeRows({ defaultLocationName: `${state.assetDraft?.locationName || ''}`.trim() }));
  el.querySelector('[data-bulk-export]')?.addEventListener('click', () => { const csv = actions.exportBulkIntakeCsv(); const link = document.createElement('a'); link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`; link.download = 'asset-bulk-review.csv'; link.click(); });
  el.querySelector('[data-bulk-import]')?.addEventListener('click', () => actions.importBulkIntakeRows());
  el.querySelectorAll('[data-bulk-row]').forEach((rowEl) => {
    const index = Number(rowEl.dataset.bulkRow);
    rowEl.querySelectorAll('input, textarea, select').forEach((input) => input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
      actions.updateBulkIntakeRow(index, { [input.name]: input.value });
      if (input.name === 'rowStatus') renderAssets(el, state, actions);
    }));
  });
  el.querySelectorAll('[data-bulk-accept]').forEach((button) => button.addEventListener('click', () => actions.setBulkRowStatus(Number(button.dataset.bulkAccept), 'good_match')));
  el.querySelectorAll('[data-bulk-skip]').forEach((button) => button.addEventListener('click', () => actions.setBulkRowStatus(Number(button.dataset.bulkSkip), 'skipped')));
  el.querySelectorAll('[data-onboarding-review-row]').forEach((reviewForm) => reviewForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const fd = new FormData(reviewForm);
    actions.applyOnboardingReviewEdit(Number(reviewForm.dataset.onboardingReviewRow), Object.fromEntries(fd.entries()));
  }));
  el.querySelector('[data-location-filter]')?.addEventListener('change', (event) => actions.setLocationFilter(event.target.value));
  el.querySelector('[data-asset-search]')?.addEventListener('input', (event) => {
    state.assetUi.searchQuery = event.target.value;
    renderAssets(el, state, actions);
  });
  el.querySelector('[data-asset-docs-filter]')?.addEventListener('change', (event) => {
    state.assetUi.statusFilter = event.target.value || 'all';
    renderAssets(el, state, actions);
  });
  el.querySelector('[data-asset-review-filter]')?.addEventListener('change', (event) => {
    state.assetUi.reviewFilter = event.target.value || 'all';
    renderAssets(el, state, actions);
  });
  el.querySelector('[data-asset-enrichment-filter]')?.addEventListener('change', (event) => {
    state.assetUi.enrichmentFilter = event.target.value || 'all';
    renderAssets(el, state, actions);
  });
  el.querySelector('[data-clear-asset-filters]')?.addEventListener('click', () => {
    state.assetUi.searchQuery = '';
    state.assetUi.statusFilter = 'all';
    state.assetUi.reviewFilter = 'all';
    state.assetUi.enrichmentFilter = 'all';
    renderAssets(el, state, actions);
  });
  el.querySelector('[data-bulk-visible-enrich]')?.addEventListener('click', () => actions.runBulkAssetEnrichment(scopedAssets.map((asset) => asset.id), { confirmStart: true }));
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
  el.querySelectorAll('[data-queue-approve]').forEach((button) => button.addEventListener('click', () => {
    const assetId = button.dataset.queueApprove;
    const candidateUrl = decodeURIComponent(button.dataset.queueCandidateUrl || '');
    const asset = (state.assets || []).find((entry) => entry.id === assetId);
    const suggestions = Array.isArray(asset?.documentationSuggestions) ? asset.documentationSuggestions : [];
    const index = suggestions.findIndex((entry) => `${entry?.url || ''}`.trim() === candidateUrl);
    if (index < 0) return;
    actions.applySingleDocSuggestion(assetId, index);
  }));
  el.querySelectorAll('[data-queue-reject]').forEach((button) => button.addEventListener('click', () => {
    const assetId = button.dataset.queueReject;
    const candidateUrl = decodeURIComponent(button.dataset.queueCandidateUrl || '');
    const asset = (state.assets || []).find((entry) => entry.id === assetId);
    const suggestions = Array.isArray(asset?.documentationSuggestions) ? asset.documentationSuggestions : [];
    const index = suggestions.findIndex((entry) => `${entry?.url || ''}`.trim() === candidateUrl);
    if (index < 0) return;
    actions.rejectManualCandidate(assetId, index);
  }));
  el.querySelectorAll('[data-queue-needs-title]').forEach((button) => button.addEventListener('click', () => actions.setManualReviewState(button.dataset.queueNeedsTitle, 'needs_title_clarification', 'operator_marked_title_clarification_needed')));
  el.querySelectorAll('[data-queue-flag-library]').forEach((button) => button.addEventListener('click', () => actions.flagManualLibraryRow(button.dataset.queueFlagLibrary)));
  el.querySelectorAll('[data-apply-support-item]').forEach((button) => button.addEventListener('click', () => actions.applySingleSupportSuggestion(button.dataset.applySupportItem, Number(button.dataset.supportIndex))));
  el.querySelectorAll('[data-remove-manual]').forEach((button) => button.addEventListener('click', () => actions.removeManualLink(button.dataset.removeManual, decodeURIComponent(button.dataset.url || ''))));
  el.querySelectorAll('[data-manual-storage-path]').forEach((link) => link.addEventListener('click', async (event) => {
    event.preventDefault();
    await openStoredManualPath(link, state);
  }));
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

export {
  deriveAssetManualStatus,
  getAuthoritativeManualState,
  getEffectiveEnrichmentStatus,
  isEnrichmentStale,
  getDocumentationSuggestionBuckets,
  buildStoredManualDownloadUrl,
  resolveStoredManualDownloadUrl,
  openStoredManualPath,
  filterDisplaySupportResources,
  resolveStoragePreferredManualLink,
};
