const SEARCH_USER_AGENT = 'techops-manual-discovery/1.0';
const MAX_SEARCH_RESULTS_PER_QUERY = 8;
const MAX_DISCOVERY_RESULTS = 10;
const MAX_FOLLOWUP_FETCHES = 4;
const MAX_ADAPTER_FETCHES = 8;
const MAX_SEED_FETCHES = 6;
const SEARCH_FOLLOWUP_PRIORITY = 0;
const ADAPTER_FOLLOWUP_PRIORITY = 1;
const MANUAL_KEYWORDS = ['manual', 'operator', 'service', 'parts', 'install', 'installation', 'schematic', 'instruction', 'owners'];
const DOWNLOAD_KEYWORDS = ['download', 'pdf', 'document', 'operators-manual', 'service-manual'];
const GENERIC_ANCHOR_TITLES = new Set([
  'toggle menu',
  'skip to main content',
  'skip to content',
  'read more',
  'learn more',
  'view more',
  'click here',
  'menu'
]);
const GENERIC_ANCHOR_HASHES = new Set([
  'main-content',
  'content',
  'main',
  'primary-navigation',
  'navigation',
  'nav',
  'menu'
]);
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
const BAY_TEK_UTILITY_PATHS = [
  /^\/$/,
  /^\/cart(?:\.php)?\/?$/,
  /^\/login(?:\.php)?\/?$/,
  /^\/checkout(?:\.php)?\/?$/,
  /^\/my-account\/?$/,
  /^\/account\/?$/,
  /^\/register(?:\.php)?\/?$/,
  /^\/wishlist\/?$/,
  /^\/support\/?$/,
  /^\/products?\/?$/,
  /^\/parts\/?$/,
  /^\/parts-service\/?$/,
  /^\/blog\/?$/,
  /^\/news\/?$/,
  /^\/terms(?:-conditions)?\/?$/,
  /^\/privacy(?:-policy)?\/?$/,
  /^\/contact(?:-us)?\/?$/,
  /^\/product-category\/?$/,
  /^\/shop\/?$/
];
const BETSON_UTILITY_PATHS = [
  /^\/$/,
  /^\/(home|index(\.html?)?)?$/,
  /^\/about(?:-us)?\/?$/,
  /^\/contact(?:-us)?\/?$/,
  /^\/blog\/?$/,
  /^\/news\/?$/,
  /^\/privacy(?:-policy)?\/?$/,
  /^\/terms(?:-conditions)?\/?$/,
  /^\/brands\/?$/,
  /^\/manufacturers\/?$/,
  /^\/amusement-products\/?$/,
  /^\/parts\/?$/,
  /^\/services\/?$/,
  /^\/support\/?$/
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

function slugifyTitle(title) {
  return normalizePhrase(title).replace(/\s+/g, '-');
}

function escapeHtml(value) {
  return `${value || ''}`
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseAnchorAttributes(rawAttributes) {
  const attributes = {};
  for (const match of `${rawAttributes || ''}`.matchAll(/([:@a-z0-9_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const key = `${match[1] || ''}`.toLowerCase();
    attributes[key] = escapeHtml(match[3] || match[4] || match[5] || '').trim();
  }
  return attributes;
}

function sanitizeDiagnosticValue(value, maxLength = 220) {
  const text = `${value || ''}`.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function buildDiagnosticLogger({ logger = console, traceId = '' } = {}) {
  return (event, payload = {}) => {
    const logPayload = { traceId, ...payload };
    try {
      logger.log(`manualDiscovery:${event}`, logPayload);
    } catch {
      // swallow logging failures so discovery remains safe at runtime
    }
  };
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

function buildManufacturerQueryTerms(manufacturer, manufacturerProfile) {
  return Array.from(new Set([
    `${manufacturer || ''}`.trim(),
    `${manufacturerProfile?.key || ''}`.trim(),
    ...((manufacturerProfile?.aliases || []).map((alias) => `${alias || ''}`.trim()))
  ].filter(Boolean)));
}

function buildManualSearchQueries({ manufacturer, title, manufacturerProfile }) {
  const cleanTitle = `${title || ''}`.trim();
  if (!cleanTitle) return { officialQueries: [], exactTitleQueries: [], fallbackQueries: [] };
  const preferredDomains = manufacturerProfile?.preferredSourceTokens?.length
    ? manufacturerProfile.preferredSourceTokens
    : (manufacturerProfile?.sourceTokens || []).slice(0, 2);
  const manufacturerTerms = buildManufacturerQueryTerms(manufacturer, manufacturerProfile).slice(0, 7);
  const manufacturerOrClause = manufacturerTerms.length
    ? `(${manufacturerTerms.map((term) => `"${term}"`).join(' OR ')})`
    : '';

  const exactTitleQueries = manufacturerTerms.flatMap((term) => ([
    `"${term}" "${cleanTitle}" "service manual" pdf`,
    `"${term}" "${cleanTitle}" "operator manual" pdf`,
    `"${term}" "${cleanTitle}" "parts manual" pdf`,
    `"${term}" "${cleanTitle}" "installation manual" pdf`,
    `"${term}" "${cleanTitle}" manual pdf`,
    `"${term}" "${cleanTitle}" exact title pdf`
  ]));

  const fallbackQueries = manufacturerProfile?.lowTrustSourceTokens?.flatMap((domain) => ([
    `site:${domain} "${cleanTitle}" ${manufacturerOrClause} (manual OR "service manual" OR "operator manual") (pdf OR download)`,
    `site:${domain} "${cleanTitle}" ${manufacturerOrClause} (support OR product OR manual)`
  ].map((query) => query.replace(/\s+/g, ' ').trim()))) || [];

  const officialQueries = preferredDomains.flatMap((domain) => ([
    `site:${domain} "${cleanTitle}" ("service manual" OR "operator manual" OR manual) (pdf OR download)`,
    `site:${domain} ${manufacturerOrClause} "${cleanTitle}" ("service manual" OR "operator manual" OR manual) (pdf OR download)`,
    `site:${domain} ${manufacturerOrClause} "${cleanTitle}" ("parts manual" OR "install manual" OR support) (pdf OR download)`
  ].map((query) => query.replace(/\s+/g, ' ').trim())));

  return {
    officialQueries: Array.from(new Set(officialQueries)).filter(Boolean),
    exactTitleQueries: Array.from(new Set(exactTitleQueries)).filter(Boolean),
    fallbackQueries: Array.from(new Set(fallbackQueries)).filter(Boolean)
  };
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

function isBayTekProfile(manufacturerProfile) {
  return manufacturerProfile?.key === 'bay tek';
}

function isBayTekDomain(host) {
  return /(^|\.)baytekent\.com$/.test(`${host || ''}`.toLowerCase());
}

function isBayTekUtilityPath(pathname) {
  const lowerPath = `${pathname || ''}`.toLowerCase();
  return BAY_TEK_UTILITY_PATHS.some((pattern) => pattern.test(lowerPath));
}

function hasBayTekTitleSpecificPath(pathname, titleVariants) {
  const lowerPath = `${pathname || ''}`.toLowerCase();
  if (/\.(pdf|docx?)($|[?#])/.test(lowerPath)) return true;
  if (/\/(product|products|support|manuals?|downloads?)\//.test(lowerPath)) {
    return hasExactOrStrongTitle(lowerPath, titleVariants);
  }
  return false;
}

function isBetsonDomain(host) {
  return /(^|\.)betson\.com$/.test(`${host || ''}`.toLowerCase());
}

function isBetsonUtilityPath(pathname) {
  const lowerPath = `${pathname || ''}`.toLowerCase();
  return BETSON_UTILITY_PATHS.some((pattern) => pattern.test(lowerPath));
}

function hasBetsonTitleSpecificPath(pathname, titleVariants) {
  const lowerPath = `${pathname || ''}`.toLowerCase();
  if (/\/wp-content\/uploads\/.+\.(pdf|docx?)($|[?#])/.test(lowerPath)) return true;
  if (/\.(pdf|docx?)($|[?#])/.test(lowerPath)) return true;
  if (/\/(product|products|amusement-products|support|manuals?|downloads?)\//.test(lowerPath)) {
    return hasExactOrStrongTitle(lowerPath, titleVariants);
  }
  return false;
}

function classifyManualCandidate({ title, url, manufacturer, titleVariants, manufacturerProfile }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {
      includeManual: false,
      includeSupport: false,
      rejectionReasons: ['invalid_url'],
      sourceType: 'other',
      resourceType: 'other'
    };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return {
      includeManual: false,
      includeSupport: false,
      rejectionReasons: ['unsupported_protocol'],
      sourceType: 'other',
      resourceType: 'other'
    };
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const combined = `${title || ''} ${host} ${path}`;
  const titleAndPath = normalizePhrase(`${title || ''} ${path}`);
  const titleMatch = hasExactOrStrongTitle(combined, titleVariants);
  const manufacturerMatch = hasManufacturerEvidence(`${manufacturer || ''} ${host} ${title || ''}`, manufacturer, manufacturerProfile);
  const directPdf = /\.pdf($|[?#])/.test(path) || /\bpdf\b/.test(titleAndPath);
  const manualIntent = MANUAL_KEYWORDS.some((token) => titleAndPath.includes(token));
  const downloadIntent = DOWNLOAD_KEYWORDS.some((token) => titleAndPath.includes(token));
  const sourceType = detectSourceType(url, manufacturerProfile);
  const resourceType = detectResourceType(url, manufacturerProfile);
  const bayTekDomain = isBayTekDomain(host);
  const bayTekUtility = isBayTekProfile(manufacturerProfile) && bayTekDomain && isBayTekUtilityPath(path);
  const bayTekTitleSpecificPath = isBayTekProfile(manufacturerProfile) && bayTekDomain && hasBayTekTitleSpecificPath(path, titleVariants);
  const betsonDomain = isBetsonDomain(host);
  const betsonUtility = betsonDomain && isBetsonUtilityPath(path);
  const betsonTitleSpecificPath = betsonDomain && hasBetsonTitleSpecificPath(path, titleVariants);
  const hostManualIntent = sourceType === 'manual_library' && /manual/.test(normalizePhrase(host));
  const exactMachineManual = titleMatch && manufacturerMatch && (directPdf || manualIntent || downloadIntent || hostManualIntent);
  const titleSpecificOfficialPage = titleMatch
    && manufacturerMatch
    && !bayTekUtility
    && !betsonUtility
    && !isGenericSupportPath(path, titleVariants)
    && /manufacturer|support|parts|distributor/.test(sourceType)
    && path.split('/').filter(Boolean).length >= 1;
  const titleSpecificSupport = titleMatch
    && manufacturerMatch
    && !bayTekUtility
    && !betsonUtility
    && (
      /support|product|parts|downloads?|manual|service|install/.test(path)
      || titleSpecificOfficialPage
      || bayTekTitleSpecificPath
      || betsonTitleSpecificPath
    );
  const genericSupport = isGenericSupportPath(path, titleVariants) || bayTekUtility || betsonUtility;
  const includeManual = titleMatch
    && manufacturerMatch
    && !genericSupport
    && !bayTekUtility
    && !betsonUtility
    && (directPdf || manualIntent || downloadIntent || hostManualIntent || (betsonDomain && /\/wp-content\/uploads\//.test(path)));
  const includeSupport = !bayTekUtility && !betsonUtility && titleSpecificSupport;
  const rejectionReasons = [];

  if (!titleMatch) rejectionReasons.push('missing_title_match');
  if (!manufacturerMatch) rejectionReasons.push('missing_manufacturer_match');
  if (!directPdf && !manualIntent && !downloadIntent && !hostManualIntent) rejectionReasons.push('missing_manual_signal');
  if (genericSupport) rejectionReasons.push('generic_support_page');
  if (bayTekUtility) rejectionReasons.push('bay_tek_utility_link');
  if (betsonUtility) rejectionReasons.push('betson_utility_link');
  if (!includeSupport && !includeManual) rejectionReasons.push('not_support_or_manual');

  return {
    includeManual,
    includeSupport,
    sourceType,
    resourceType,
    exactMachineManual,
    titleSpecificSupport,
    titleMatch,
    manufacturerMatch,
    directPdf,
    genericSupport,
    rejectionReasons
  };
}

function isGenericAnchorTitle(title) {
  const normalized = normalizePhrase(title);
  return !normalized || GENERIC_ANCHOR_TITLES.has(normalized);
}

function isJunkAnchorCandidate({ href, title, url, attributes, pageUrl, mode = 'default' }) {
  const normalizedTitle = normalizePhrase(title);
  const parsedBase = new URL(pageUrl);
  const parsedUrl = new URL(url);
  const normalizedHash = `${parsedUrl.hash || ''}`.replace(/^#/, '').trim().toLowerCase();
  const attributeText = normalizePhrase(Object.values(attributes || {}).join(' '));
  const rel = `${attributes?.rel || ''}`.toLowerCase();
  const target = `${attributes?.target || ''}`.toLowerCase();

  if (!href || href === '#' || /^#/.test(href.trim())) return true;
  if (parsedUrl.pathname === parsedBase.pathname && parsedUrl.search === parsedBase.search && parsedUrl.hash) return true;
  if (GENERIC_ANCHOR_HASHES.has(normalizedHash)) return true;
  if (isGenericAnchorTitle(title)) return true;
  if (/^(javascript:|mailto:|tel:)/i.test(href)) return true;
  if (rel.includes('nofollow') && target !== '_blank' && !/pdf/i.test(url)) return true;

  if (mode === 'seed') {
    if (/(^|\s)(nav|menu|header|footer|skip|breadcrumb|logo|mobile-menu)(\s|$)/.test(attributeText)) return true;
    if (/\/(contact|contact-us|about|about-us|privacy-policy|privacy|terms-and-conditions|terms|faq|blog|news)(\/|$)/.test(parsedUrl.pathname.toLowerCase())) return true;
    if (/\/(cart|checkout|my-account|account|login|register|wishlist)(\/|$)/.test(parsedUrl.pathname.toLowerCase())) return true;
    if (normalizedTitle.length <= 3 && !/pdf|manual|guide|download/.test(normalizedTitle)) return true;
  }

  if (isBayTekDomain(parsedUrl.hostname)) {
    const lowerPath = parsedUrl.pathname.toLowerCase();
    if (isBayTekUtilityPath(lowerPath)) return true;
    if (mode !== 'default' && !/\.(pdf|docx?)$/i.test(lowerPath) && /\/(contact|about|privacy|terms|faq)(\/|$)/.test(lowerPath)) return true;
  }

  if (isBetsonDomain(parsedUrl.hostname)) {
    const lowerPath = parsedUrl.pathname.toLowerCase();
    if (isBetsonUtilityPath(lowerPath)) return true;
    if (mode !== 'default' && !hasBetsonTitleSpecificPath(lowerPath, [normalizedTitle].filter(Boolean))
      && /\/(contact|about|privacy|terms|faq|blog|news)(\/|$)/.test(lowerPath)) return true;
  }

  return false;
}

function extractAnchorCandidates(html, pageUrl, { mode = 'default' } = {}) {
  const base = new URL(pageUrl);
  const matches = Array.from(html.matchAll(/<a\b([^>]*)href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi));
  return matches.map((match) => {
    const rawAttributes = `${match[1] || ''} ${match[6] || ''}`.trim();
    const href = escapeHtml(match[3] || match[4] || match[5] || '');
    const label = escapeHtml(match[7]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const attributes = parseAnchorAttributes(rawAttributes);
    try {
      const url = new URL(href, base).toString();
      if (isJunkAnchorCandidate({ href, title: label, url, attributes, pageUrl, mode })) return null;
      return { url, title: label || href, href, attributes };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function extractManualLinksFromHtmlPage({ pageUrl, pageTitle, manufacturer, titleVariants, manufacturerProfile, fetchImpl = fetch, logEvent = () => {} }) {
  const response = await fetchImpl(pageUrl, { headers: { 'user-agent': SEARCH_USER_AGENT } });
  if (!response.ok) {
    logEvent('html_followup_error', { pageUrl, status: response.status });
    return [];
  }
  const contentType = `${response.headers?.get?.('content-type') || ''}`.toLowerCase();
  if (!/text\/html|application\/xhtml\+xml/.test(contentType)) {
    logEvent('html_followup_skipped_non_html', { pageUrl, contentType: sanitizeDiagnosticValue(contentType, 80) });
    return [];
  }
  const html = await response.text();
  const anchorCandidates = extractAnchorCandidates(html, pageUrl, { mode: 'followup' });
  const classified = anchorCandidates
    .map((row) => ({
      ...row,
      classification: classifyManualCandidate({
        title: `${pageTitle || ''} ${row.title || ''}`,
        url: row.url,
        manufacturer,
        titleVariants,
        manufacturerProfile
      })
    }));

  const accepted = classified
    .filter((row) => row.classification.includeManual)
    .slice(0, 3)
    .map((row) => ({
      title: row.title,
      url: row.url,
      sourceType: row.classification.sourceType,
      discoverySource: 'html_followup'
    }));

  logEvent('html_followup_extracted', {
    pageUrl,
    anchorsScanned: anchorCandidates.length,
    acceptedManuals: accepted.map((row) => row.url),
    rejected: classified
      .filter((row) => !row.classification.includeManual)
      .slice(0, 5)
      .map((row) => ({
        url: row.url,
        rejectionReasons: row.classification.rejectionReasons
      }))
  });

  return accepted;
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

function buildFollowupExecutionPlan(followupPages) {
  const deduped = dedupeByUrl(followupPages);
  const searchPages = deduped.filter((page) => Number(page.priority) === SEARCH_FOLLOWUP_PRIORITY);
  const adapterPages = deduped.filter((page) => Number(page.priority) !== SEARCH_FOLLOWUP_PRIORITY);
  return [...searchPages, ...adapterPages].slice(0, MAX_FOLLOWUP_FETCHES);
}


function buildManufacturerDiscoverySeedPages({ title, manufacturerProfile }) {
  const cleanTitle = `${title || ''}`.trim();
  if (!cleanTitle || !manufacturerProfile?.key) return [];
  const encodedTitle = encodeURIComponent(cleanTitle);
  const adapters = {
    'bay tek': [
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${cleanTitle} Bay Tek parts search`, url: `https://parts.baytekent.com/?s=${encodedTitle}` },
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${cleanTitle} Bay Tek support search`, url: `https://baytekent.com/?s=${encodedTitle}` },
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${cleanTitle} Betson search`, url: `https://www.betson.com/?s=${encodeURIComponent(`${cleanTitle} Bay Tek`)}` },
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${cleanTitle} Betson product search`, url: `https://www.betson.com/amusement-products/?s=${encodeURIComponent(cleanTitle)}` }
    ],
    'raw thrills': [
      { adapter: 'raw_thrills_seed', type: 'search_page', label: `${cleanTitle} Raw Thrills search`, url: `https://rawthrills.com/?s=${encodedTitle}` },
      { adapter: 'raw_thrills_seed', type: 'search_page', label: `${cleanTitle} Raw Thrills games`, url: `https://rawthrills.com/games/?s=${encodedTitle}` }
    ],
    'ice': [
      { adapter: 'ice_seed', type: 'search_page', label: `${cleanTitle} ICE support search`, url: `https://support.icegame.com/portal/en/kb/search/${encodedTitle}` },
      { adapter: 'ice_seed', type: 'search_page', label: `${cleanTitle} ICE site search`, url: `https://www.icegame.com/?s=${encodedTitle}` }
    ],
    'unis': [
      { adapter: 'unis_seed', type: 'search_page', label: `${cleanTitle} UNIS search`, url: `https://www.unistechnology.com/?s=${encodedTitle}` }
    ],
    'coastal amusements': [
      { adapter: 'coastal_seed', type: 'search_page', label: `${cleanTitle} Coastal search`, url: `https://coastalamusements.com/?s=${encodedTitle}` }
    ],
    'lai games': [
      { adapter: 'lai_seed', type: 'search_page', label: `${cleanTitle} LAI Games search`, url: `https://laigames.com/?s=${encodedTitle}` }
    ],
    'adrenaline amusements': [
      { adapter: 'adrenaline_seed', type: 'search_page', label: `${cleanTitle} Adrenaline search`, url: `https://adrenalineamusements.com/?s=${encodedTitle}` }
    ]
  };

  return adapters[manufacturerProfile.key] || [];
}

async function crawlManufacturerSeedPages({ candidates, manufacturer, titleVariants, manufacturerProfile, fetchImpl, manualRows, supportRows, followupPages, logEvent }) {
  for (const candidate of dedupeByUrl(candidates).slice(0, MAX_SEED_FETCHES)) {
    try {
      const response = await fetchImpl(candidate.url, { headers: { 'user-agent': SEARCH_USER_AGENT } });
      if (!response.ok) {
        logEvent('seed_probe_rejected', { adapter: candidate.adapter, url: candidate.url, status: response.status, reason: 'http_error' });
        continue;
      }
      const contentType = `${response.headers?.get?.('content-type') || ''}`.toLowerCase();
      if (!/text\/html|application\/xhtml\+xml/.test(contentType)) {
        logEvent('seed_probe_skipped_non_html', { adapter: candidate.adapter, url: candidate.url, contentType: sanitizeDiagnosticValue(contentType, 80) });
        continue;
      }
      const html = await response.text();
      const anchorCandidates = extractAnchorCandidates(html, candidate.url, { mode: 'seed' });
      const classified = anchorCandidates.map((row) => ({
        ...row,
        classification: classifyManualCandidate({
          title: row.title,
          url: row.url,
          manufacturer,
          titleVariants,
          manufacturerProfile
        })
      }));

      for (const row of classified) {
        if (row.classification.includeManual) {
          manualRows.push({
            title: row.title,
            url: row.url,
            sourceType: row.classification.sourceType,
            discoverySource: `seed:${candidate.adapter}`
          });
          continue;
        }
        if (row.classification.titleSpecificSupport && !row.classification.genericSupport) {
          followupPages.push({ title: row.title, url: row.url, adapter: candidate.adapter, priority: SEARCH_FOLLOWUP_PRIORITY });
        }
        if (row.classification.includeSupport) {
          supportRows.push({
            label: row.title,
            url: row.url,
            resourceType: row.classification.resourceType,
            discoverySource: `seed:${candidate.adapter}`
          });
        }
      }

      logEvent('seed_probe_result', {
        adapter: candidate.adapter,
        url: candidate.url,
        anchorsScanned: anchorCandidates.length,
        acceptedManuals: classified.filter((row) => row.classification.includeManual).map((row) => row.url).slice(0, 5),
        queuedFollowups: classified.filter((row) => row.classification.titleSpecificSupport && !row.classification.genericSupport).map((row) => row.url).slice(0, 5)
      });
    } catch (error) {
      logEvent('seed_probe_error', {
        adapter: candidate.adapter,
        url: candidate.url,
        reason: sanitizeDiagnosticValue(error?.message || String(error), 120)
      });
    }
  }
}

function buildManufacturerDiscoveryAdapters({ title, manufacturerProfile }) {
  const slug = slugifyTitle(title);
  if (!slug || !manufacturerProfile?.key) return [];

  const adapters = {
    'bay tek': [
      {
        adapter: 'bay_tek',
        type: 'direct_pdf',
        label: `${title} service manual`,
        url: `https://parts.baytekent.com/manuals/${slug}-service-manual.pdf`
      },
      {
        adapter: 'bay_tek',
        type: 'direct_pdf',
        label: `${title} operator manual`,
        url: `https://parts.baytekent.com/manuals/${slug}-operator-manual.pdf`
      },
      {
        adapter: 'bay_tek',
        type: 'support_page',
        label: `${title} support`,
        url: `https://parts.baytekent.com/support/${slug}`
      },
      {
        adapter: 'bay_tek',
        type: 'support_page',
        label: `${title} support`,
        url: `https://baytekent.com/support/${slug}`
      },
      {
        adapter: 'betson',
        type: 'search_page',
        label: `${title} Betson search`,
        url: `https://www.betson.com/?s=${encodeURIComponent(`${title} Bay Tek`)}`
      },
      {
        adapter: 'betson',
        type: 'support_page',
        label: `${title} Betson product`,
        url: `https://www.betson.com/amusement-products/${slug}/`
      }
    ],
    ice: [
      {
        adapter: 'ice',
        type: 'direct_pdf',
        label: `${title} service manual`,
        url: `https://support.icegame.com/manuals/${slug}-service-manual.pdf`
      },
      {
        adapter: 'ice',
        type: 'direct_pdf',
        label: `${title} operator manual`,
        url: `https://support.icegame.com/manuals/${slug}-operator-manual.pdf`
      },
      {
        adapter: 'ice',
        type: 'support_page',
        label: `${title} support`,
        url: `https://support.icegame.com/support/${slug}`
      },
      {
        adapter: 'ice',
        type: 'support_page',
        label: `${title} support`,
        url: `https://icegame.com/games/${slug}`
      }
    ],
    'raw thrills': [
      {
        adapter: 'raw_thrills',
        type: 'support_page',
        label: `${title} support`,
        url: `https://rawthrills.com/games/${slug}-support`
      },
      {
        adapter: 'raw_thrills',
        type: 'direct_pdf',
        label: `${title} operator manual`,
        url: `https://rawthrills.com/wp-content/uploads/${slug}-operator-manual.pdf`
      },
      {
        adapter: 'raw_thrills',
        type: 'direct_pdf',
        label: `${title} service manual`,
        url: `https://rawthrills.com/wp-content/uploads/${slug}-service-manual.pdf`
      }
    ]
  };

  return adapters[manufacturerProfile.key] || [];
}

async function probeAdapterCandidates({ candidates, manufacturer, titleVariants, manufacturerProfile, fetchImpl, manualRows, supportRows, followupPages, logEvent }) {
  for (const candidate of dedupeByUrl(candidates).slice(0, MAX_ADAPTER_FETCHES)) {
    try {
      const response = await fetchImpl(candidate.url, { headers: { 'user-agent': SEARCH_USER_AGENT } });
      const contentType = `${response.headers?.get?.('content-type') || ''}`.toLowerCase();
      if (!response.ok) {
        logEvent('adapter_probe_rejected', {
          adapter: candidate.adapter,
          url: candidate.url,
          status: response.status,
          reason: 'http_error'
        });
        continue;
      }
      const classification = classifyManualCandidate({
        title: candidate.label,
        url: candidate.url,
        manufacturer,
        titleVariants,
        manufacturerProfile
      });
      logEvent('adapter_probe_result', {
        adapter: candidate.adapter,
        url: candidate.url,
        type: candidate.type,
        contentType: sanitizeDiagnosticValue(contentType, 80),
        includeManual: classification.includeManual,
        includeSupport: classification.includeSupport,
        rejectionReasons: classification.rejectionReasons
      });

      if (classification.includeManual) {
        manualRows.push({
          title: candidate.label,
          url: candidate.url,
          sourceType: classification.sourceType,
          discoverySource: `adapter:${candidate.adapter}`
        });
        continue;
      }

      if (classification.includeSupport) {
        supportRows.push({
          label: candidate.label,
          url: candidate.url,
          resourceType: classification.resourceType,
          discoverySource: `adapter:${candidate.adapter}`
        });
      }

      if (/text\/html|application\/xhtml\+xml/.test(contentType) && (classification.titleSpecificSupport || candidate.type === 'support_page')) {
        followupPages.push({ title: candidate.label, url: candidate.url, adapter: candidate.adapter, priority: ADAPTER_FOLLOWUP_PRIORITY });
      }
    } catch (error) {
      logEvent('adapter_probe_error', {
        adapter: candidate.adapter,
        url: candidate.url,
        reason: sanitizeDiagnosticValue(error?.message || String(error), 120)
      });
    }
  }
}

async function discoverManualDocumentation({ assetName, normalizedName, manufacturer, manufacturerProfile, searchHints = [], searchProvider = searchDuckDuckGoHtml, fetchImpl = fetch, logger = console, traceId = '' }) {
  const title = normalizedName || assetName;
  const titleVariants = buildExactTitleVariants(assetName, normalizedName);
  const logEvent = buildDiagnosticLogger({ logger, traceId });
  const { officialQueries, exactTitleQueries, fallbackQueries } = buildManualSearchQueries({ manufacturer, title, manufacturerProfile });
  const queries = [
    ...officialQueries.map((query) => ({ query, mode: 'official' })),
    ...exactTitleQueries.map((query) => ({ query, mode: 'exact_pdf' })),
    ...fallbackQueries.map((query) => ({ query, mode: 'fallback' })),
    ...searchHints.slice(0, 3).map((query) => ({ query, mode: 'hint' }))
  ];

  const manualRows = [];
  const supportRows = [];
  const followupPages = [];
  const adapterCandidates = buildManufacturerDiscoveryAdapters({ title, manufacturerProfile });
  const seedPages = buildManufacturerDiscoverySeedPages({ title, manufacturerProfile });

  logEvent('start', {
    assetName: sanitizeDiagnosticValue(assetName, 120),
    normalizedName: sanitizeDiagnosticValue(normalizedName, 120),
    manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
    provider: searchProvider?.name || 'anonymous_search_provider',
    adapterCount: adapterCandidates.length,
    seedPageCount: seedPages.length,
    queriesTried: queries.map((entry) => ({ mode: entry.mode, query: sanitizeDiagnosticValue(entry.query, 160) }))
  });

  if (seedPages.length) {
    logEvent('seed_pages', {
      pages: seedPages.map((candidate) => ({ adapter: candidate.adapter, type: candidate.type, url: candidate.url }))
    });
    await crawlManufacturerSeedPages({
      candidates: seedPages,
      manufacturer,
      titleVariants,
      manufacturerProfile,
      fetchImpl,
      manualRows,
      supportRows,
      followupPages,
      logEvent
    });
  }

  if (adapterCandidates.length) {
    logEvent('adapter_candidates', {
      adapters: adapterCandidates.map((candidate) => ({
        adapter: candidate.adapter,
        type: candidate.type,
        url: candidate.url
      }))
    });
    await probeAdapterCandidates({
      candidates: adapterCandidates,
      manufacturer,
      titleVariants,
      manufacturerProfile,
      fetchImpl,
      manualRows,
      supportRows,
      followupPages,
      logEvent
    });
  }

  for (const { query, mode } of queries) {
    const results = await searchProvider(query, fetchImpl).catch((error) => {
      logEvent('search_error', {
        provider: searchProvider?.name || 'anonymous_search_provider',
        mode,
        query: sanitizeDiagnosticValue(query, 160),
        reason: sanitizeDiagnosticValue(error?.message || String(error), 120)
      });
      return [];
    });

    logEvent('search_results', {
      provider: searchProvider?.name || 'anonymous_search_provider',
      mode,
      query: sanitizeDiagnosticValue(query, 160),
      topResults: results.slice(0, 5).map((result) => ({
        title: sanitizeDiagnosticValue(result.title, 120),
        url: result.url
      }))
    });

    for (const result of results) {
      const classification = classifyManualCandidate({
        title: result.title,
        url: result.url,
        manufacturer,
        titleVariants,
        manufacturerProfile
      });
      logEvent('result_classification', {
        mode,
        title: sanitizeDiagnosticValue(result.title, 120),
        url: result.url,
        includeManual: classification.includeManual,
        includeSupport: classification.includeSupport,
        exactMachineManual: classification.exactMachineManual,
        titleSpecificSupport: classification.titleSpecificSupport,
        rejectionReasons: classification.rejectionReasons
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
        followupPages.push({ title: result.title, url: result.url, discoveredBy: mode, priority: SEARCH_FOLLOWUP_PRIORITY });
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

  const followupPlan = buildFollowupExecutionPlan(followupPages);
  logEvent('followup_plan', {
    selectedPages: followupPlan.map((page) => ({
      url: page.url,
      priority: page.priority,
      discoveredBy: page.discoveredBy || page.adapter || 'unknown'
    })),
    queuedPages: dedupeByUrl(followupPages).map((page) => ({
      url: page.url,
      priority: page.priority,
      discoveredBy: page.discoveredBy || page.adapter || 'unknown'
    }))
  });

  const followedRows = [];
  for (const page of followupPlan) {
    const extracted = await extractManualLinksFromHtmlPage({
      pageUrl: page.url,
      pageTitle: page.title,
      manufacturer,
      titleVariants,
      manufacturerProfile,
      fetchImpl,
      logEvent
    }).catch((error) => {
      logEvent('html_followup_error', {
        pageUrl: page.url,
        reason: sanitizeDiagnosticValue(error?.message || String(error), 120)
      });
      return [];
    });
    followedRows.push(...extracted);
  }

  const documentationLinks = dedupeByUrl([...manualRows, ...followedRows]).slice(0, MAX_DISCOVERY_RESULTS);
  const supportResources = dedupeByUrl(supportRows).slice(0, MAX_DISCOVERY_RESULTS);

  logEvent('complete', {
    documentationLinks: documentationLinks.map((row) => row.url),
    supportResources: supportResources.map((row) => row.url),
    htmlFollowups: dedupeByUrl(followupPages).map((row) => row.url)
  });

  return {
    documentationLinks,
    supportResources,
    queriesTried: queries.map((entry) => entry.query)
  };
}

module.exports = {
  buildManufacturerQueryTerms,
  buildManualSearchQueries,
  buildManufacturerDiscoverySeedPages,
  buildManufacturerDiscoveryAdapters,
  searchDuckDuckGoHtml,
  classifyManualCandidate,
  extractAnchorCandidates,
  extractManualLinksFromHtmlPage,
  discoverManualDocumentation
};
