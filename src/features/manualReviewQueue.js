import { sortDocumentationSuggestions } from './documentationSuggestions.js';
import { deriveManualStatus } from './documentationReview.js';

function normalizeText(value = '') {
  return `${value || ''}`.trim();
}

function toLabel(value = '') {
  const normalized = normalizeText(value);
  return normalized ? normalized.replace(/_/g, ' ') : 'n/a';
}

function buildCandidateProvenance(entry = {}) {
  const parts = [];
  if (entry?.verified) parts.push('verified');
  if (entry?.isOfficial) parts.push('official');
  if (entry?.sourceType) parts.push(entry.sourceType);
  if (entry?.verificationKind) parts.push(entry.verificationKind);
  if (!parts.length) parts.push('unclassified');
  return parts.join(' | ');
}

function buildRejectionReasons(asset = {}, manualReadyUrls = new Set()) {
  const rows = [];
  const docs = Array.isArray(asset.documentationSuggestions) ? asset.documentationSuggestions : [];
  docs.forEach((entry) => {
    const url = normalizeText(entry?.url);
    if (!url || manualReadyUrls.has(url)) return;
    if (entry?.deadPage || entry?.unreachable) {
      rows.push(`dead/unreachable candidate: ${url}`);
      return;
    }
    const bucket = normalizeText(entry?.candidateBucket);
    if (bucket === 'weak_lead') rows.push(`weak lead score: ${entry?.title || url}`);
    else if (bucket === 'support_product_page') rows.push(`support page only: ${entry?.title || url}`);
    else if (bucket) rows.push(`non-approved bucket (${bucket}): ${entry?.title || url}`);
  });
  const terminalReason = normalizeText(asset.enrichmentTerminalReason);
  if (terminalReason) rows.push(`terminal reason: ${terminalReason.replace(/_/g, ' ')}`);
  return Array.from(new Set(rows)).slice(0, 4);
}

export function summarizeManualReviewEvidence(asset = {}) {
  const suggestions = sortDocumentationSuggestions(Array.isArray(asset.documentationSuggestions) ? asset.documentationSuggestions : [])
    .filter((entry) => normalizeText(entry?.url));
  const manualReady = suggestions.filter((entry) => entry?.verified && entry?.exactTitleMatch && !entry?.deadPage && !entry?.unreachable);
  const bestSuggestion = manualReady[0] || suggestions[0] || null;
  const summary = asset.manualMatchSummary || {};
  const selectedCandidateUrl = normalizeText(summary?.pipelineMeta?.selectedCandidateUrl || summary?.selectedCandidateUrl || bestSuggestion?.url || summary?.manualUrl || '');
  const selectedCandidateTitle = normalizeText(bestSuggestion?.title || summary?.canonicalTitle || summary?.assetNameNormalized || summary?.assetNameOriginal || '');
  const evidenceRows = (manualReady.length ? manualReady : suggestions)
    .slice(0, 3)
    .map((entry) => ({
      title: normalizeText(entry?.title || entry?.url),
      url: normalizeText(entry?.url),
      provenance: buildCandidateProvenance(entry),
      score: Number(entry?.matchScore || entry?.discoveryCandidateScore || 0) || null,
    }));
  const rejectionReasons = buildRejectionReasons(asset, new Set(manualReady.map((entry) => normalizeText(entry?.url))));
  return {
    selectedCandidateTitle,
    selectedCandidateUrl,
    evidenceRows,
    rejectionReasons,
    hasManualLibraryEntry: !!(normalizeText(asset.manualLibraryRef) || normalizeText(asset.manualStoragePath)),
    manualStatus: deriveManualStatus(asset),
    manualReviewState: normalizeText(asset.manualReviewState),
    enrichmentTerminalReason: normalizeText(asset.enrichmentTerminalReason),
  };
}

export function classifyManualReviewCase(asset = {}, effectiveStatus = '') {
  const reviewState = normalizeText(asset.manualReviewState);
  if (reviewState) return reviewState;
  const terminalReason = normalizeText(asset.enrichmentTerminalReason);
  if (terminalReason.includes('brochure')) return 'brochure_only_evidence';
  if (terminalReason.includes('hint')) return 'hint_hydration_issue';
  if (terminalReason.includes('dead') || terminalReason.includes('404')) return 'dead_seeded_pdf_needs_source_followup';
  if (terminalReason.includes('clarification') || terminalReason.includes('ambiguous')) return 'needs_title_clarification';
  const manualStatus = deriveManualStatus(asset);
  if (manualStatus === 'support_context_only') return 'support_context_only';
  if (manualStatus === 'queued_for_review') return 'queued_for_review';
  if (['followup_needed', 'no_match_yet', 'retry_needed', 'lookup_failed'].includes(effectiveStatus)) return 'queued_for_review';
  return '';
}

export function buildManualReviewQueue(assets = [], getEffectiveEnrichmentStatus = () => 'idle') {
  return (Array.isArray(assets) ? assets : []).map((asset) => {
    const effectiveStatus = getEffectiveEnrichmentStatus(asset);
    const evidence = summarizeManualReviewEvidence(asset);
    const caseType = classifyManualReviewCase(asset, effectiveStatus);
    return {
      asset,
      effectiveStatus,
      caseType,
      ...evidence,
    };
  }).filter((entry) => {
    if (!entry.caseType) return false;
    if (entry.manualStatus === 'manual_attached' && !entry.asset.manualReviewState) return false;
    return true;
  }).sort((a, b) => `${a.asset?.name || a.asset?.id || ''}`.localeCompare(`${b.asset?.name || b.asset?.id || ''}`));
}

export function formatManualReviewLabel(value = '') {
  return toLabel(value);
}
