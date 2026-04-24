import { sortDocumentationSuggestions } from './documentationSuggestions.js';

export function deriveManualStatus(asset = {}) {
  const explicitStatusRaw = `${asset?.manualStatus || ''}`.trim();
  const explicitStatus = ({
    attached: 'manual_attached',
    review_needed: 'queued_for_review',
    support_only: 'support_context_only',
    no_manual: 'no_public_manual',
  })[explicitStatusRaw] || explicitStatusRaw;
  if (['manual_attached', 'support_context_only', 'queued_for_review', 'no_public_manual'].includes(explicitStatus)) return explicitStatus;
  const manualLibraryRef = `${asset?.manualLibraryRef || ''}`.trim();
  const manualStoragePath = `${asset?.manualStoragePath || ''}`.trim();
  const manualLinks = Array.isArray(asset?.manualLinks)
    ? asset.manualLinks
      .map((entry) => `${entry || ''}`.trim())
      .filter((entry) => entry.startsWith('manual-library/') || entry.startsWith('companies/'))
    : [];
  if (manualLibraryRef || manualStoragePath || manualLinks.length) return 'manual_attached';
  const reviewableSuggestions = getReviewableDocumentationSuggestions(asset);
  if (reviewableSuggestions.length) return 'queued_for_review';
  const supportLinks = (Array.isArray(asset?.supportResourcesSuggestion) ? asset.supportResourcesSuggestion : []).filter((entry) => !entry?.deadPage && !entry?.unreachable && `${entry?.url || entry || ''}`.trim());
  if (supportLinks.length) return 'support_context_only';
  return 'no_public_manual';
}

export function isManualReadyMatch(entry = {}) {
  const url = `${entry?.url || ''}`.trim();
  if (!url || entry?.deadPage || entry?.unreachable) return false;
  if (!entry?.exactTitleMatch) return false;
  const verificationKind = `${entry?.verificationKind || ''}`.trim().toLowerCase();
  const matchType = `${entry?.matchType || ''}`.trim().toLowerCase();
  const sourceType = `${entry?.sourceType || entry?.resourceType || ''}`.trim().toLowerCase();
  const verified = entry?.verified === true || `${entry?.verificationStatus || ''}`.trim().toLowerCase() === 'seed_verified';
  const exactManualMatch = !!entry?.exactManualMatch;
  const trustedSource = !!entry?.trustedSource || !!entry?.isOfficial;
  const directManualUrl = /\.pdf($|\?|#)|manual|operator|service|install|parts/.test(url.toLowerCase());
  const manualBearingHtml = verificationKind === 'manual_html' && trustedSource;
  if (!verified) return false;
  if (matchType && !['exact_manual', 'manual_page_with_download'].includes(matchType)) return false;
  if (manualBearingHtml) return true;
  if (exactManualMatch) return true;
  if (trustedSource && directManualUrl && !['support', 'official_site', 'contact', 'parts'].includes(sourceType)) return true;
  return false;
}

export function isReviewableDocumentationSuggestion(entry = {}) {
  return isManualReadyMatch(entry);
}

export function getReviewableDocumentationSuggestions(asset = {}) {
  const entries = Array.isArray(asset?.documentationSuggestions) ? asset.documentationSuggestions : [];
  return sortDocumentationSuggestions(entries).filter((entry) => isReviewableDocumentationSuggestion(entry));
}

export function buildDocumentationApprovalSelection(asset = {}, { mode = 'best', selectedUrls = [] } = {}) {
  const reviewable = getReviewableDocumentationSuggestions(asset);
  const urlSet = new Set((selectedUrls || []).map((url) => `${url || ''}`.trim()).filter(Boolean));
  if (mode === 'selected') {
    return reviewable.filter((entry) => urlSet.has(`${entry?.url || ''}`.trim()));
  }
  if (mode === 'single') {
    const [firstUrl] = Array.from(urlSet);
    return firstUrl ? reviewable.filter((entry) => `${entry?.url || ''}`.trim() === firstUrl).slice(0, 1) : [];
  }
  return reviewable.slice(0, mode === 'top_trusted' ? 2 : 1);
}

export function buildDocumentationApprovalPatch(asset = {}, approvedEntries = [], { reviewAction = 'approve' } = {}) {
  const approvedUrls = (approvedEntries || []).filter((entry) => isReviewableDocumentationSuggestion(entry)).map((entry) => `${entry?.url || ''}`.trim()).filter(Boolean);
  if (!approvedUrls.length) return null;
  const dedupe = (values = []) => Array.from(new Set(values.map((value) => `${value || ''}`.trim()).filter(Boolean)));
  return {
    reviewSelectedSuggestionUrls: dedupe([...(asset.reviewSelectedSuggestionUrls || []), ...approvedUrls]),
    reviewApprovedSuggestionUrls: dedupe([...(asset.reviewApprovedSuggestionUrls || []), ...approvedUrls]),
    reviewRejectedSuggestionUrls: (asset.reviewRejectedSuggestionUrls || []).filter((url) => !approvedUrls.includes(`${url || ''}`.trim())),
    reviewState: 'approved',
    reviewLastAction: reviewAction
  };
}
