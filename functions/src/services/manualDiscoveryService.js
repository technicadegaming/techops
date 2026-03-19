const SEARCH_USER_AGENT = 'techops-manual-discovery/1.0';
const MAX_SEARCH_RESULTS_PER_QUERY = 8;
const MAX_DISCOVERY_RESULTS = 10;
const MAX_FOLLOWUP_FETCHES = 4;
const MANUAL_KEYWORDS = ['manual', 'operator', 'service', 'parts', 'install', 'installation', 'schematic', 'instruction', 'owners'];
const DOWNLOAD_KEYWORDS = ['download', 'pdf', 'document', 'operators-manual', 'service-manual'];
const GENERIC_SUPPORT_PATHS = [
  /^\/$/,
  /^\/(home|index(\.html?)?)?$/,
  /^\/support\/?$/,
  /^\/products\/?$/,
  /^\/downloads?\/?$/,
  /^\/docs?\/?$/,
  /^\/manuals?\/?$/,
  /^\/manuals?\/(index|library|hub)?\/?$/,
  /^\/support\/(manuals?|downloads?|docs?|library|hub)?\/?$/
];

function normalizePhrase(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildExactTitleVariants(title, normalizedTitle) {
  return Array.from(new Set([normalizePhrase(title), normalizePhrase(normalizedTitle)])).filter((value) => value.length >= 3);
}

function escapeHtml(value) {
  return `${value || ''}`
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractHref(rawHref) {
  const href = escapeHtml(rawHref || '').trim();
  if (!href) return '';
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    if (parsed.hostname.includes('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    }
    if (/^https?:/i.test(parsed.protocol)) return parsed.toString();
  } catch {
    return '';
  }
  return '';
}

function buildManualSearchQueries({ manufacturer, title, manufacturerProfile }) {
  const cleanManufacturer = `${manufacturer || ''}`.trim();
  const cleanTitle = `${title || ''}`.trim();
  if (!cleanTitle) return { officialQueries: [], fallbackQueries: [] };
  const preferredDomains = manufacturerProfile?.preferredSourceTokens?.length
    ? manufacturerProfile.preferredSourceTokens
    : (manufacturerProfile?.sourceTokens || []).slice(0, 2);

  const fallbackQueries = [
    `"${cleanManufacturer}" "${cleanTitle}" "service manual" pdf`,
    `"${cleanManufacturer}" "${cleanTitle}" "operator manual" pdf`,
    `"${cleanManufacturer}" "${cleanTitle}" "parts manual" pdf`,
    `"${cleanManufacturer}" "${cleanTitle}" manual pdf`,
    `"${cleanManufacturer}" "${cleanTitle}" download manual`
  ].filter(Boolean);

  const officialQueries = preferredDomains.flatMap((domain) => ([
    `site:${domain} "${cleanTitle}" ("service manual" OR "operator manual" OR manual) (pdf OR download)`,
    `site:${domain} "${cleanTitle}" ("parts manual" OR "install manual" OR support) (pdf OR download)`
  ]));

  return { officialQueries, fallbackQueries };
}

async function searchDuckDuckGoHtml(query, fetchImpl = fetch) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchImpl(url, { headers: { 'user-agent': SEARCH_USER_AGENT } });
  if (!response.ok) throw new Error(`Search request failed with status ${response.status}`);
  const html = await response.text();
  const matches = Array.from(html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi));
  return matches.slice(0, MAX_SEARCH_RESULTS_PER_QUERY).map((match) => ({
    title: escapeHtml(match[2]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    url: extractHref(match[1])
  })).filter((row) => row.url);
}

function detectSourceType(url, manufacturerProfile) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if ((manufacturerProfile?.preferredSourceTokens || []).some((token) => host.includes(token))) return host.includes('parts.') ? 'parts' : 'support';
  if ((manufacturerProfile?.sourceTokens || []).some((token) => host.includes(token))) return 'manufacturer';
  if (/betson|moss|distribut/i.test(host)) return 'distributor';
  if (/archive\.org|ipdb|arcade-museum|arcade-history|manual/.test(host)) return 'manual_library';
  return 'other';
}

function detectResourceType(url, manufacturerProfile) {
  const sourceType = detectSourceType(url, manufacturerProfile);
  if (sourceType === 'parts') return 'parts';
  if (sourceType === 'support') return 'support';
  if (sourceType === 'manufacturer') return 'official_site';
  if (sourceType === 'distributor') return 'distributor';
  if (sourceType === 'manual_library') return 'manual_library';
  return 'other';
}

function isGenericSupportPath(pathname, titleVariants) {
  const lowerPath = `${pathname || ''}`.toLowerCase();
  const generic = GENERIC_SUPPORT_PATHS.some((pattern) => pattern.test(lowerPath));
  if (!generic) return false;
  const normalizedPath = normalizePhrase(lowerPath.replace(/\//g, ' '));
  return !titleVariants.some((variant) => normalizedPath.includes(variant));
}

function hasExactOrStrongTitle(text, titleVariants) {
  const normalized = normalizePhrase(text);
  if (titleVariants.some((variant) => normalized.includes(variant))) return true;
  return titleVariants.some((variant) => {
    const words = variant.split(' ').filter(Boolean);
    return words.length >= 2 && words.filter((word) => normalized.includes(word)).length >= Math.max(2, words.length - 1);
  });
}

function hasManufacturerEvidence(text, manufacturer, manufacturerProfile) {
  const normalized = normalizePhrase(text);
  const candidates = [
    normalizePhrase(manufacturer),
    normalizePhrase(manufacturerProfile?.key),
    ...((manufacturerProfile?.aliases || []).map((alias) => normalizePhrase(alias)))
  ].filter(Boolean);
  return candidates.some((candidate) => normalized.includes(candidate))
    || (manufacturerProfile?.sourceTokens || []).some((token) => normalized.includes(normalizePhrase(token)));
}

function classifyManualCandidate({ title, url, manufacturer, titleVariants, manufacturerProfile }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { includeManual: false, includeSupport: false };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { includeManual: false, includeSupport: false };
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const combined = `${title || ''} ${host} ${path}`;
  const titleMatch = hasExactOrStrongTitle(combined, titleVariants);
  const manufacturerMatch = hasManufacturerEvidence(`${manufacturer || ''} ${host} ${title || ''}`, manufacturer, manufacturerProfile);
  const directPdf = /\.pdf($|[?#])/.test(path) || /\bpdf\b/.test(normalizePhrase(title));
  const manualIntent = MANUAL_KEYWORDS.some((token) => normalizePhrase(combined).includes(token));
  const downloadIntent = DOWNLOAD_KEYWORDS.some((token) => normalizePhrase(combined).includes(token));
  const exactMachineManual = titleMatch && manufacturerMatch && (directPdf || manualIntent || downloadIntent);
  const titleSpecificSupport = titleMatch && manufacturerMatch && /support|product|parts|downloads?|manual|service|install/.test(path);
  const genericSupport = isGenericSupportPath(path, titleVariants);
  const sourceType = detectSourceType(url, manufacturerProfile);
  const resourceType = detectResourceType(url, manufacturerProfile);

  return {
    includeManual: exactMachineManual && !genericSupport,
    includeSupport: titleSpecificSupport || sourceType === 'manufacturer' || sourceType === 'support' || sourceType === 'parts',
    sourceType,
    resourceType,
    exactMachineManual,
    titleSpecificSupport,
    titleMatch,
    manufacturerMatch,
    directPdf,
    genericSupport
  };
}

function extractAnchorCandidates(html, pageUrl) {
  const base = new URL(pageUrl);
  const matches = Array.from(html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi));
  return matches.map((match) => {
    const href = escapeHtml(match[1]);
    const label = escapeHtml(match[2]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    try {
      return { url: new URL(href, base).toString(), title: label || href };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function extractManualLinksFromHtmlPage({ pageUrl, pageTitle, manufacturer, titleVariants, manufacturerProfile, fetchImpl = fetch }) {
  const response = await fetchImpl(pageUrl, { headers: { 'user-agent': SEARCH_USER_AGENT } });
  if (!response.ok) return [];
  const contentType = `${response.headers?.get?.('content-type') || ''}`.toLowerCase();
  if (!/text\/html|application\/xhtml\+xml/.test(contentType)) return [];
  const html = await response.text();
  const anchorCandidates = extractAnchorCandidates(html, pageUrl);
  return anchorCandidates
    .map((row) => ({
      ...row,
      classification: classifyManualCandidate({
        title: `${pageTitle || ''} ${row.title || ''}`,
        url: row.url,
        manufacturer,
        titleVariants,
        manufacturerProfile
      })
    }))
    .filter((row) => row.classification.includeManual)
    .slice(0, 3)
    .map((row) => ({
      title: row.title,
      url: row.url,
      sourceType: row.classification.sourceType,
      discoverySource: 'html_followup'
    }));
}

function dedupeByUrl(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row?.url || ''}`.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function discoverManualDocumentation({ assetName, normalizedName, manufacturer, manufacturerProfile, searchHints = [], searchProvider = searchDuckDuckGoHtml, fetchImpl = fetch }) {
  const title = normalizedName || assetName;
  const titleVariants = buildExactTitleVariants(assetName, normalizedName);
  const { officialQueries, fallbackQueries } = buildManualSearchQueries({ manufacturer, title, manufacturerProfile });
  const queries = [
    ...officialQueries.map((query) => ({ query, mode: 'official' })),
    ...fallbackQueries.map((query) => ({ query, mode: 'fallback' })),
    ...searchHints.slice(0, 3).map((query) => ({ query, mode: 'hint' }))
  ];

  const manualRows = [];
  const supportRows = [];
  const followupPages = [];

  for (const { query, mode } of queries) {
    const results = await searchProvider(query, fetchImpl).catch(() => []);
    for (const result of results) {
      const classification = classifyManualCandidate({
        title: result.title,
        url: result.url,
        manufacturer,
        titleVariants,
        manufacturerProfile
      });
      if (classification.includeManual) {
        manualRows.push({
          title: result.title,
          url: result.url,
          sourceType: classification.sourceType,
          discoverySource: mode
        });
        continue;
      }
      if (classification.titleSpecificSupport && !classification.genericSupport) {
        followupPages.push({ title: result.title, url: result.url });
      }
      if (classification.includeSupport) {
        supportRows.push({
          label: result.title,
          url: result.url,
          resourceType: classification.resourceType,
          discoverySource: mode
        });
      }
    }
    if (manualRows.length >= 2 && mode === 'official') break;
  }

  const followedRows = [];
  for (const page of dedupeByUrl(followupPages).slice(0, MAX_FOLLOWUP_FETCHES)) {
    const extracted = await extractManualLinksFromHtmlPage({
      pageUrl: page.url,
      pageTitle: page.title,
      manufacturer,
      titleVariants,
      manufacturerProfile,
      fetchImpl
    }).catch(() => []);
    followedRows.push(...extracted);
  }

  return {
    documentationLinks: dedupeByUrl([...manualRows, ...followedRows]).slice(0, MAX_DISCOVERY_RESULTS),
    supportResources: dedupeByUrl(supportRows).slice(0, MAX_DISCOVERY_RESULTS),
    queriesTried: queries.map((entry) => entry.query)
  };
}

module.exports = {
  buildManualSearchQueries,
  searchDuckDuckGoHtml,
  classifyManualCandidate,
  extractManualLinksFromHtmlPage,
  discoverManualDocumentation
};
