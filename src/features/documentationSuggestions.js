export function getDocumentationSuggestionRank(entry = {}) {
  const sourceType = `${entry?.sourceType || entry?.resourceType || 'other'}`.trim().toLowerCase();
  const url = `${entry?.url || ''}`.toLowerCase();
  const verified = !!entry?.verified;
  const exactTitleMatch = !!entry?.exactTitleMatch;
  const exactManualMatch = !!entry?.exactManualMatch;
  const isDirectFile = /\.pdf($|\?|#)|\/wp-content\/uploads\/|\/manuals?\/[^/]+\.(pdf|docx?)($|\?|#)/.test(url);
  const isManualLibrary = sourceType === 'manual_library';
  const isSupportResource = ['support', 'official_site', 'contact'].includes(sourceType) && !exactManualMatch;
  const isMirror = ['distributor', 'other'].includes(sourceType);
  const isTitleSpecificPage = exactTitleMatch && /support|parts|downloads?|manual|service|install|product/.test(url);

  if (verified && isDirectFile) return 0;
  if (verified && exactTitleMatch && exactManualMatch) return 1;
  if (verified && isTitleSpecificPage) return 2;
  if (verified && isManualLibrary) return 3;
  if (verified && isMirror) return 4;
  if (isSupportResource) return 6;
  return 5;
}

export function compareDocumentationSuggestions(a = {}, b = {}) {
  const rankDiff = Number(a?.rankTier ?? getDocumentationSuggestionRank(a)) - Number(b?.rankTier ?? getDocumentationSuggestionRank(b));
  if (rankDiff !== 0) return rankDiff;
  if (!!a?.verified !== !!b?.verified) return a?.verified ? -1 : 1;
  if (!!a?.exactManualMatch !== !!b?.exactManualMatch) return a?.exactManualMatch ? -1 : 1;
  if (!!a?.exactTitleMatch !== !!b?.exactTitleMatch) return a?.exactTitleMatch ? -1 : 1;
  if (Number(b?.matchScore || 0) !== Number(a?.matchScore || 0)) return Number(b?.matchScore || 0) - Number(a?.matchScore || 0);
  return `${a?.url || ''}`.localeCompare(`${b?.url || ''}`);
}

export function sortDocumentationSuggestions(entries = []) {
  return [...entries].sort(compareDocumentationSuggestions);
}
