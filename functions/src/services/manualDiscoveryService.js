const SEARCH_USER_AGENT = 'techops-manual-discovery/1.0';
const { normalizePhrase, expandArcadeTitleAliases, resolveArcadeTitleFamily } = require('./arcadeTitleAliasService');
const MAX_SEARCH_RESULTS_PER_QUERY = 8;
const MAX_DISCOVERY_RESULTS = 10;
const MAX_FOLLOWUP_FETCHES = 4;
const MAX_ADAPTER_FETCHES = 8;
const MAX_SEED_FETCHES = 6;
const MAX_SEARCH_QUERIES = 12;
const FETCH_TIMEOUT_MS = 3500;
const SEARCH_PROVIDER_TIMEOUT_MS = 4500;
const SEARCH_FOLLOWUP_PRIORITY = 0;
const ADAPTER_FOLLOWUP_PRIORITY = 1;
const KNOWN_DISTRIBUTOR_DOMAINS = [
  'betson.com',
  'mossdistributing.com',
  'primetimeamusements.com',
  'appleindustries.com',
  'sureshotredemption.com',
];
const HARD_NEGATIVE_DOMAINS = [
  'virtualdj.com',
  'zhihu.com',
];
const SEARCH_WRAPPER_OR_JUNK_DOMAINS = [
  'bing.com',
  'r.bing.com',
  'go.microsoft.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'pinterest.com',
  'youtube.com',
  'tiktok.com',
  'reddit.com',
  'wikipedia.org',
];
const JUNK_PATH_PATTERNS = [
  /\/consultative-services(\/|$)/,
  /\/financial-services(\/|$)/,
  /\/installations?(\/|$)/,
  /\/office-coffee(?:-machines)?(\/|$)/,
  /\/newsletter(\/|$)/,
  /\/careers?(\/|$)/,
  /\/contact(?:-us)?(\/|$)/,
  /\/about(?:-us)?(\/|$)/,
  /\/company(\/|$)/,
  /\/cart(\/|$)/,
  /\/checkout(\/|$)/,
  /\/login(\/|$)/,
  /\/account(\/|$)/,
  /\/my-account(\/|$)/,
  /\/portal(\/|$)/,
  /\/search(\/|$)/,
  /[?&](?:s|search|query)=/,
  /\/category(\/|$)/,
  /\/product-category(\/|$)/,
  /\/collections?(\/|$)/,
  /\/blog(\/|$)/,
  /\/news(\/|$)/,
  /\/feed(\/|$)/,
  /\/(?:services?|service-support|parts-service)(\/|$)/,
  /\/(?:press|media|stories|story)(\/|$)/,
  /\/(?:investor|investor-relations)(\/|$)/,
];
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
const GENERIC_DEAD_LINK_BASENAMES = new Set([
  'details',
  'detail',
  'index',
  'download',
  'downloads',
  'app',
  'apps',
  'manual',
  'manuals',
  'support',
  'service',
  'default',
  'file',
  'view',
]);
const MANUAL_FILENAME_TOKENS = /(manual|operator|service|install(?:ation)?|owners?|operations?)/i;
const MANUAL_PART_NUMBER_PATTERN = /\b\d{2,4}-\d{4,6}(?:-\d{2,4})?\b/i;
const MANUAL_REVISION_PATTERN = /\b(?:rev(?:ision)?)[\s._-]*\d+[a-z]?\b/i;
const DEAD_LINK_HTTP_STATUSES = new Set([404, 410]);

function buildExactTitleVariants(title, normalizedTitle) {
  return expandArcadeTitleAliases([title, normalizedTitle])
    .map((value) => normalizePhrase(value))
    .filter((value) => value.length >= 3);
}

const MANUFACTURER_VARIANT_EXPANSIONS = {
  'bay tek': ['bay tek', 'baytek', 'bay tek games'],
  'lai games': ['lai games', 'lai'],
  'raw thrills': ['raw thrills', 'rawthrills'],
};

function buildManufacturerAwareTitleVariants({
  title = '',
  normalizedTitle = '',
  manufacturer = '',
  titleFamily = null,
  manufacturerProfile = null,
  logEvent = () => {},
} = {}) {
  const typedTitle = `${title || ''}`.trim();
  const normalizedInput = `${normalizedTitle || ''}`.trim();
  const family = titleFamily || resolveArcadeTitleFamily({ title: normalizedInput || typedTitle, manufacturer });
  const normalizedManufacturer = normalizePhrase(manufacturerProfile?.key || family.manufacturer || manufacturer);
  const manufacturerAliases = MANUFACTURER_VARIANT_EXPANSIONS[normalizedManufacturer] || [];
  const generated = [];
  const seen = new Set();
  const pushVariant = (value = '', reason = '') => {
    const cleaned = `${value || ''}`.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    const key = normalizePhrase(cleaned);
    if (!key || seen.has(key)) return;
    seen.add(key);
    generated.push(cleaned);
    logEvent('title_variant_generated', {
      variant: sanitizeDiagnosticValue(cleaned, 120),
      reason: sanitizeDiagnosticValue(reason, 80),
    });
  };
  const addSplitJoinPermutations = (value = '', reason = '') => {
    const clean = `${value || ''}`.trim();
    if (!clean) return;
    pushVariant(clean, reason);
    pushVariant(clean.replace(/[-_/]+/g, ' '), `${reason}:depunctuated`);
    pushVariant(clean.replace(/\s+/g, '-'), `${reason}:hyphenated`);
    pushVariant(clean.replace(/['’]/g, ''), `${reason}:deapostrophe`);
    pushVariant(clean.replace(/\s+/g, ''), `${reason}:joined`);
    if (/\bs\b/i.test(clean)) pushVariant(clean.replace(/\bs\b/gi, ''), `${reason}:singularized`);
  };

  addSplitJoinPermutations(typedTitle, 'typed_title');
  addSplitJoinPermutations(normalizedInput, 'normalized_title');
  addSplitJoinPermutations(family.canonicalTitle || '', 'family_canonical');
  addSplitJoinPermutations(family.familyDisplayTitle || family.familyTitle || '', 'family_display');
  (family.alternateTitles || []).forEach((value) => addSplitJoinPermutations(value, 'family_alias'));
  expandArcadeTitleAliases([typedTitle, normalizedInput, family.canonicalTitle, ...(family.alternateTitles || [])])
    .forEach((value) => addSplitJoinPermutations(value, 'known_alias'));

  const tokenized = normalizePhrase(normalizedInput || typedTitle).split(' ').filter(Boolean);
  if (tokenized.length > 1) {
    pushVariant(tokenized.slice().reverse().join(' '), 'token_reordered');
    pushVariant(tokenized.sort().join(' '), 'token_sorted');
  }
  if (normalizedManufacturer) {
    const aliases = Array.from(new Set([
      manufacturerProfile?.key || '',
      manufacturer,
      family.manufacturer || '',
      ...manufacturerAliases,
    ].map((value) => `${value || ''}`.trim()).filter(Boolean))).slice(0, 3);
    aliases.forEach((alias) => {
      pushVariant(`${alias} ${typedTitle || normalizedInput}`.trim(), 'manufacturer_prefixed_title');
      pushVariant(`${typedTitle || normalizedInput} ${alias}`.trim(), 'manufacturer_suffixed_title');
    });
  }

  return generated.slice(0, 20);
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
    if (parsed.hostname.includes('duckduckgo.com')) {
      const redirectedUrl = parsed.searchParams.get('uddg')
        || parsed.searchParams.get('rut')
        || parsed.searchParams.get('u');
      if (redirectedUrl) return decodeURIComponent(redirectedUrl);
    }
    if (/^https?:/i.test(parsed.protocol)) return parsed.toString();
  } catch {
    return '';
  }
  return '';
}

function isHardNegativeDomain(host = '') {
  const lowerHost = `${host || ''}`.toLowerCase();
  return HARD_NEGATIVE_DOMAINS.some((domain) => lowerHost === domain || lowerHost.endsWith(`.${domain}`));
}

function isSearchWrapperOrJunkDomain(host = '') {
  const lowerHost = `${host || ''}`.toLowerCase();
  return SEARCH_WRAPPER_OR_JUNK_DOMAINS.some((domain) => lowerHost === domain || lowerHost.endsWith(`.${domain}`));
}

function normalizeSearchResultUrl(url = '') {
  const unwrapped = unwrapSearchProviderRedirect(url);
  if (!unwrapped) return '';
  try {
    const parsed = new URL(unwrapped);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (isHardNegativeDomain(host)) return '';
    if (isSearchWrapperOrJunkDomain(host)) {
      if (/(^|\.)bing\.com$/.test(host) && !/^\/(search|images|videos|news|maps|travel|shop)\b/.test(path)) {
        return parsed.toString();
      }
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function unwrapSearchProviderRedirect(url = '') {
  let current = `${url || ''}`.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      const parsed = new URL(current);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      if (!/(^|\.)bing\.com$/.test(host)) return current;
      if (!/^\/(ck\/a|aclick|link|fwlink|redirect)/.test(path)) return current;
      const redirected = parsed.searchParams.get('url')
        || parsed.searchParams.get('u')
        || parsed.searchParams.get('target')
        || parsed.searchParams.get('r');
      if (!redirected) return current;
      current = decodeURIComponent(redirected);
    } catch {
      return '';
    }
  }
  return current;
}

function extractDuckDuckGoAnchors(html) {
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const rows = [];
  const seen = new Set();
  for (const match of html.matchAll(anchorPattern)) {
    const attributes = parseAnchorAttributes(match[1] || '');
    const className = `${attributes.class || ''}`.toLowerCase();
    const rel = `${attributes.rel || ''}`.toLowerCase();
    const href = attributes.href || '';
    const title = escapeHtml(match[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const looksLikeResultAnchor = /result__a|result-link|result__url|result-title-a/.test(className)
      || rel.includes('nofollow');
    if (!looksLikeResultAnchor || !href || !title) continue;
    const url = normalizeSearchResultUrl(extractHref(href));
    if (!url) continue;
    const key = `${url}::${title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ title, url });
    if (rows.length >= MAX_SEARCH_RESULTS_PER_QUERY) break;
  }
  return rows;
}

async function fetchDuckDuckGoSearchPage(query, searchBaseUrl, fetchImpl) {
  const url = `${searchBaseUrl}${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url, { headers: { 'user-agent': SEARCH_USER_AGENT } }, fetchImpl);
  if (!response.ok) throw new Error(`Search request failed with status ${response.status}`);
  return response.text();
}

function isAbortLikeError(error) {
  const code = `${error?.code || ''}`.toLowerCase();
  const name = `${error?.name || ''}`.toLowerCase();
  return code === 'abort_err' || code === 'aborted' || name === 'aborterror';
}

async function fetchWithTimeout(url, options = {}, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function buildManufacturerQueryTerms(manufacturer, manufacturerProfile) {
  return Array.from(new Set([
    `${manufacturer || ''}`.trim(),
    `${manufacturerProfile?.key || ''}`.trim(),
    ...((manufacturerProfile?.aliases || []).map((alias) => `${alias || ''}`.trim()))
  ].filter(Boolean)));
}

function buildManualSearchQueries({
  manufacturer,
  title,
  manufacturerProfile,
  titleVariants = [],
  titleFamily = null,
}) {
  const resolvedTitleFamily = titleFamily || resolveArcadeTitleFamily({ title, manufacturer });
  const typedTitle = `${title || ''}`.trim();
  const cleanTitle = `${resolvedTitleFamily.canonicalTitle || typedTitle}`.trim();
  if (!cleanTitle) return { officialQueries: [], exactTitleQueries: [], fallbackQueries: [] };
  const titleQueryVariants = expandArcadeTitleAliases([
    ...titleVariants,
    typedTitle,
    cleanTitle,
    resolvedTitleFamily.familyTitle || '',
    ...(resolvedTitleFamily.alternateTitles || []),
  ]).slice(0, 10);
  const preferredDomains = manufacturerProfile?.preferredSourceTokens?.length
    ? manufacturerProfile.preferredSourceTokens
    : (manufacturerProfile?.sourceTokens || []).slice(0, 2);
  const manufacturerTerms = buildManufacturerQueryTerms(resolvedTitleFamily.manufacturer || manufacturer, manufacturerProfile).slice(0, 7);
  const manufacturerOrClause = manufacturerTerms.length
    ? `(${manufacturerTerms.map((term) => `"${term}"`).join(' OR ')})`
    : '';

  const primaryTitleVariant = titleQueryVariants[0] || cleanTitle;
  const primaryManufacturerTerm = manufacturerTerms[0] || `${manufacturer || ''}`.trim();
  const deterministicBaselineQueries = titleQueryVariants.flatMap((titleVariant) => ([
    `"${titleVariant}" arcade manual`,
    primaryManufacturerTerm ? `"${primaryManufacturerTerm}" "${titleVariant}" arcade manual` : '',
    `"${titleVariant}" operator manual`,
    primaryManufacturerTerm ? `"${primaryManufacturerTerm}" "${titleVariant}" operator manual` : '',
    `"${titleVariant}" service manual`,
    primaryManufacturerTerm ? `"${primaryManufacturerTerm}" "${titleVariant}" service manual` : '',
    `"${titleVariant}" install guide`,
    primaryManufacturerTerm ? `"${primaryManufacturerTerm}" "${titleVariant}" install guide` : '',
    `"${titleVariant}" pdf`,
    primaryManufacturerTerm ? `"${primaryManufacturerTerm}" "${titleVariant}" pdf` : '',
  ]));
  const broadFirstQueries = Array.from(new Set([
    ...deterministicBaselineQueries,
    `"${primaryTitleVariant}" arcade manual pdf`,
    primaryManufacturerTerm ? `"${primaryTitleVariant}" "${primaryManufacturerTerm}" manual pdf` : '',
    primaryManufacturerTerm ? `filetype:pdf ${primaryTitleVariant} ${primaryManufacturerTerm}`.replace(/\s+/g, ' ').trim() : '',
    `"${primaryTitleVariant}" operator manual`,
    `"${primaryTitleVariant}" service manual pdf`,
  ].filter(Boolean)));

  const exactTitleQueries = titleQueryVariants.flatMap((titleVariant) => {
    const withManufacturer = manufacturerTerms.flatMap((term) => ([
      `"${term}" "${titleVariant}" "service manual" pdf`,
      `"${term}" "${titleVariant}" "operator manual" pdf`,
      `"${term}" "${titleVariant}" "parts manual" pdf`,
      `"${term}" "${titleVariant}" "installation manual" pdf`,
      `"${term}" "${titleVariant}" manual pdf`,
      `"${term}" "${titleVariant}" "install guide" pdf`
    ]));
    const titleOnly = [
      `"${titleVariant}" manual pdf`,
      `"${titleVariant}" "operator manual"`,
      `"${titleVariant}" "service manual"`,
      `"${titleVariant}" "installation manual"`,
      `"${titleVariant}" support downloads`,
      `"${titleVariant}" product page manual`
    ];
    return [...withManufacturer, ...titleOnly];
  });

  const dealerQueries = titleQueryVariants.flatMap((titleVariant) => ([
    `"${titleVariant}" distributor manual`,
    `"${titleVariant}" dealer manual`,
    `"${titleVariant}" distributor support`,
    `"${titleVariant}" dealer support`,
    ...KNOWN_DISTRIBUTOR_DOMAINS.map((domain) => `site:${domain} "${titleVariant}" (manual OR "service manual" OR "operator manual" OR download)`),
  ]));

  const globalQueries = titleQueryVariants.flatMap((titleVariant) => ([
    `"${titleVariant}" operator manual pdf`,
    `"${titleVariant}" service manual`,
    `"${titleVariant}" manufacturer manual`,
    `filetype:pdf "${titleVariant}"`,
  ]));
  const broadQueries = titleQueryVariants.flatMap((titleVariant) => {
    const lowerManufacturer = `${manufacturerProfile?.key || manufacturer || ''}`.trim().toLowerCase();
    return [
      `${titleVariant} manual pdf`,
      `${titleVariant} operator manual pdf`,
      `${titleVariant} service manual pdf`,
      `${titleVariant} ${manufacturer || ''} manual`.trim(),
      `${titleVariant} ${manufacturer || ''} pdf`.trim(),
      `filetype:pdf ${titleVariant} ${manufacturer || ''}`.trim(),
      ...(lowerManufacturer === 'raw thrills'
        ? [
            `raw thrills ${titleVariant} pdf`,
            `${titleVariant} raw thrills manual`,
            `filetype:pdf ${titleVariant} raw thrills`,
          ]
        : [])
    ].map((query) => query.replace(/\s+/g, ' ').trim()).filter(Boolean);
  });

  const fallbackQueries = manufacturerProfile?.lowTrustSourceTokens?.flatMap((domain) => titleQueryVariants.flatMap((titleVariant) => ([
    `site:${domain} "${titleVariant}" ${manufacturerOrClause} (manual OR "service manual" OR "operator manual") (pdf OR download)`,
    `site:${domain} "${titleVariant}" ${manufacturerOrClause} (support OR product OR manual)`
  ].map((query) => query.replace(/\s+/g, ' ').trim())))) || [];

  const officialQueries = preferredDomains.flatMap((domain) => titleQueryVariants.flatMap((titleVariant) => ([
    `site:${domain} "${titleVariant}" ("service manual" OR "operator manual" OR manual) (pdf OR download)`,
    `site:${domain} ${manufacturerOrClause} "${titleVariant}" ("service manual" OR "operator manual" OR manual) (pdf OR download)`,
    `site:${domain} ${manufacturerOrClause} "${titleVariant}" ("parts manual" OR "install manual" OR support) (pdf OR download)`
  ].map((query) => query.replace(/\s+/g, ' ').trim()))));

  return {
    broadFirstQueries: Array.from(new Set(broadFirstQueries)).filter(Boolean),
    officialQueries: Array.from(new Set(officialQueries)).filter(Boolean),
    exactTitleQueries: Array.from(new Set([...exactTitleQueries, ...globalQueries, ...broadQueries])).filter(Boolean),
    fallbackQueries: Array.from(new Set([...fallbackQueries, ...dealerQueries])).filter(Boolean)
  };
}

function buildDeterministicSearchPlan({
  assetName,
  normalizedName,
  manufacturer,
  manufacturerProfile,
  searchHints = [],
  logEvent = () => {},
}) {
  const rawTitle = `${assetName || ''}`.trim();
  const normalizedTitle = `${normalizedName || assetName || ''}`.trim();
  const titleFamily = resolveArcadeTitleFamily({
    title: normalizedTitle,
    manufacturer: manufacturer || '',
  });
  const manufacturerAwareVariants = buildManufacturerAwareTitleVariants({
    title: rawTitle,
    normalizedTitle,
    manufacturer,
    titleFamily,
    manufacturerProfile,
    logEvent,
  });
  const baseTitleVariants = expandArcadeTitleAliases([
    ...manufacturerAwareVariants,
    ...buildExactTitleVariants(rawTitle, normalizedTitle),
    `${titleFamily.canonicalTitle || ''}`.trim(),
    `${titleFamily.familyTitle || ''}`.trim(),
    ...((titleFamily.alternateTitles || []).map((value) => `${value || ''}`.trim())),
  ])
    .flatMap((value) => [`${value || ''}`.trim(), normalizePhrase(value)])
    .map((value) => `${value || ''}`.trim())
    .filter(Boolean)
    .slice(0, 12);
  const queries = buildManualSearchQueries({
    manufacturer,
    title: normalizedTitle,
    manufacturerProfile,
    titleVariants: baseTitleVariants,
    titleFamily,
  });
  const titleOnlyCount = queries.broadFirstQueries.filter((query) => !/"[^"]+"\s+"[^"]+"/.test(query)).length;
  const manufacturerAndTitleCount = queries.broadFirstQueries.length - titleOnlyCount;
  logEvent('manufacturer_aware_normalization_applied', {
    rawTitle: sanitizeDiagnosticValue(rawTitle, 120),
    normalizedTitle: sanitizeDiagnosticValue(normalizedTitle, 120),
    manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
    manufacturerAwareNormalizationApplied: !!(manufacturer && rawTitle),
    manufacturerAwareVariantCount: manufacturerAwareVariants.length,
  });
  logEvent('title_variant_generation_summary', {
    rawTitle: sanitizeDiagnosticValue(rawTitle, 120),
    normalizedTitle: sanitizeDiagnosticValue(normalizedTitle, 120),
    manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
    titleVariantsUsed: baseTitleVariants.slice(0, 12),
    titleVariantCount: baseTitleVariants.length,
  });
  return {
    titleFamily,
    titleVariants: baseTitleVariants,
    rawTitle,
    normalizedTitle,
    manufacturerAwareNormalizationApplied: !!(manufacturer && rawTitle),
    broadFirstQueries: queries.broadFirstQueries,
    officialQueries: queries.officialQueries,
    exactTitleQueries: queries.exactTitleQueries,
    fallbackQueries: queries.fallbackQueries,
    searchHints: (Array.isArray(searchHints) ? searchHints : []).slice(0, 3),
    titleOnlyQueryCount: titleOnlyCount,
    titleManufacturerQueryCount: manufacturerAndTitleCount,
  };
}

function hasUsableSearchResults(results = []) {
  return (Array.isArray(results) ? results : []).some((row = {}) => {
    const url = normalizeSearchResultUrl(row.url || '');
    if (!url) return false;
    try {
      const parsed = new URL(url);
      if (isHardNegativeDomain(parsed.hostname)) return false;
      if (isSearchWrapperOrJunkDomain(parsed.hostname)) return false;
      return true;
    } catch {
      return false;
    }
  });
}

function tokenizeForMatch(value = '') {
  return normalizePhrase(value).split(' ').filter((token) => token.length >= 3);
}

function scoreManualCandidate(candidate = {}, { titleVariants = [], manufacturerTerms = [], manufacturerProfile = null } = {}) {
  const url = `${candidate.url || ''}`.trim();
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const lowerUrl = url.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const fileName = extractFileNameFromUrl(url).toLowerCase();
  const normalizedFileName = normalizePhrase(fileName.replace(/\.[a-z0-9]+$/i, ''));
  const sourceType = `${candidate.sourceType || ''}`.toLowerCase();
  const discoverySource = `${candidate.discoverySource || ''}`.trim();
  const isAdapterGuess = discoverySource.startsWith('adapter:');
  const isDiscovered = !isAdapterGuess;
  const isDirectPdf = /\.pdf($|[?#])/.test(lowerUrl);
  const fileNameHasManualIntent = MANUAL_FILENAME_TOKENS.test(fileName);
  const fileNameHasPartNumber = MANUAL_PART_NUMBER_PATTERN.test(fileName);
  const fileNameHasRevision = MANUAL_REVISION_PATTERN.test(fileName);
  const manufacturerAligned = manufacturerTerms.some((term) => term && normalizePhrase(`${host} ${path}`).includes(normalizePhrase(term)));
  const hasStrongTitleFamilyMatch = titleVariants.some((variant) => variant && normalizePhrase(`${candidate.title || ''} ${normalizedFileName} ${path}`).includes(variant));
  const titleTokens = new Set(titleVariants.flatMap((variant) => tokenizeForMatch(variant)));
  const matchTokenCount = Array.from(titleTokens).filter((token) => normalizePhrase(`${candidate.title || ''} ${normalizedFileName} ${path}`).includes(token)).length;
  const hasPartialTitleFamilyMatch = !hasStrongTitleFamilyMatch && matchTokenCount >= 2;
  const adapterSlugGuessLike = isAdapterGuess
    && /\/wp-content\/uploads\//.test(path)
    && !fileNameHasPartNumber
    && !fileNameHasRevision;
  const likelyInstallGuideGuess = isAdapterGuess
    && /(install(?:ation)?[-_ ]?guide|install[-_ ]?manual)/.test(lowerUrl)
    && !fileNameHasPartNumber
    && !fileNameHasRevision;
  const preferredSourceAligned = (manufacturerProfile?.preferredSourceTokens || [])
    .some((token) => token && host.includes(`${token}`.toLowerCase().replace(/^www\./, '')));
  const hardNegativeDomain = isHardNegativeDomain(host);
  const wrapperOrJunkDomain = isSearchWrapperOrJunkDomain(host);

  if (hardNegativeDomain || wrapperOrJunkDomain) return null;

  let score = 0;
  const contributions = [];
  const add = (reason, points) => {
    score += points;
    contributions.push({ reason, points });
  };

  if (isDiscovered) add('discovered_source_bonus', 28);
  if (isAdapterGuess) add('generated_adapter_guess_penalty', -24);
  if (isDirectPdf) add('direct_pdf_bonus', 26);
  if (!isDirectPdf) add('non_pdf_penalty', -20);
  if (isDirectPdf && /\/(?:uploads?|wp-content)\//.test(path)) add('direct_pdf_upload_path_bonus', 18);
  if (manufacturerAligned) add('manufacturer_alignment_bonus', 14);
  if (preferredSourceAligned) add('preferred_source_alignment_bonus', 26);
  if (hasStrongTitleFamilyMatch) add('title_family_exact_bonus', 20);
  if (hasPartialTitleFamilyMatch) add('title_family_partial_bonus', 10);
  if (fileNameHasManualIntent) add('manual_filename_bonus', 10);
  if (fileNameHasPartNumber) add('manual_part_number_bonus', 22);
  if (fileNameHasRevision) add('manual_revision_bonus', 18);
  if (adapterSlugGuessLike) add('adapter_slug_guess_penalty', -26);
  if (likelyInstallGuideGuess) add('adapter_install_guide_guess_penalty', -45);
  if (/support|service-support|downloads?\/?$/.test(path) && !isDirectPdf) add('support_page_penalty', -26);
  if (/brochure|spec|sell[-_ ]?sheet|catalog|install(?:ation)?-?sheet/.test(lowerUrl)) add('brochure_penalty', -26);
  if (sourceType === 'support') add('support_source_penalty', -10);
  if (hardNegativeDomain) add('hard_negative_domain_penalty', -400);

  return {
    ...candidate,
    discoverySource,
    candidateScore: score,
    candidateScoreContributions: contributions,
    candidateScoringFlags: {
      isDiscovered,
      isAdapterGuess,
      isDirectPdf,
      manufacturerAligned,
      hasStrongTitleFamilyMatch,
      hasPartialTitleFamilyMatch,
      fileNameHasManualIntent,
      fileNameHasPartNumber,
      fileNameHasRevision,
      adapterSlugGuessLike,
      preferredSourceAligned,
      hardNegativeDomain,
    }
  };
}

function extractFileNameFromUrl(url = '') {
  try {
    const parsed = new URL(url);
    const fileName = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(fileName).trim();
  } catch {
    return '';
  }
}

function normalizeDeadLinkBasename(fileName = '') {
  const decoded = `${fileName || ''}`.trim().toLowerCase();
  if (!decoded) return '';
  return decoded
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

function isGenericDeadLinkBasename(fileName = '') {
  const normalized = normalizeDeadLinkBasename(fileName);
  if (!normalized) return true;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  if (tokens.length <= 2 && tokens.every((token) => GENERIC_DEAD_LINK_BASENAMES.has(token))) return true;
  return GENERIC_DEAD_LINK_BASENAMES.has(normalized);
}

function isQueryDrivenStoreAppUrl(url = '') {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (/(^|\.)play\.google\.com$/.test(host) && /^\/store\/apps\/details\/?$/.test(path) && parsed.searchParams.has('id')) return true;
    if (/(^|\.)apps\.apple\.com$/.test(host) && /\/app\//.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function buildDeadLinkQueries({ title = '', manufacturer = '', failedUrl = '' }) {
  const fileName = extractFileNameFromUrl(failedUrl);
  const skipFileNameRecovery = isGenericDeadLinkBasename(fileName) || isQueryDrivenStoreAppUrl(failedUrl);
  const cleanTitle = `${title || ''}`.trim();
  const cleanManufacturer = `${manufacturer || ''}`.trim();
  return Array.from(new Set([
    !skipFileNameRecovery && fileName ? `"${fileName}"` : '',
    !skipFileNameRecovery && fileName ? `"${fileName}" pdf` : '',
    !skipFileNameRecovery && fileName ? `filetype:pdf "${fileName}"` : '',
    cleanTitle ? `"${cleanTitle}" manual pdf` : '',
    cleanTitle && cleanManufacturer ? `"${cleanTitle}" "${cleanManufacturer}" pdf` : '',
    cleanTitle ? `filetype:pdf "${cleanTitle}"` : '',
  ].filter(Boolean)));
}

async function searchDuckDuckGoHtml(query, fetchImpl = fetch) {
  const html = await fetchDuckDuckGoSearchPage(query, 'https://duckduckgo.com/html/?q=', fetchImpl);
  const parsedHtmlResults = extractDuckDuckGoAnchors(html);
  if (parsedHtmlResults.length) return parsedHtmlResults;

  const liteHtml = await fetchDuckDuckGoSearchPage(query, 'https://lite.duckduckgo.com/lite/?q=', fetchImpl);
  return extractDuckDuckGoAnchors(liteHtml);
}

function extractBingAnchors(html = '') {
  const anchors = Array.from(`${html || ''}`.matchAll(/<li[^>]*\bclass\s*=\s*["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi));
  const rows = [];
  const seen = new Set();
  for (const match of anchors) {
    const block = match[1] || '';
    const anchorMatch = block.match(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchorMatch) continue;
    const href = escapeHtml(anchorMatch[2] || anchorMatch[3] || anchorMatch[4] || '').trim();
    const title = escapeHtml(anchorMatch[5] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const url = normalizeSearchResultUrl(extractHref(href));
    if (!url || !title) continue;
    const key = `${url}::${title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ title, url });
    if (rows.length >= MAX_SEARCH_RESULTS_PER_QUERY) break;
  }
  return rows;
}

async function searchBingHtml(query, fetchImpl = fetch) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${MAX_SEARCH_RESULTS_PER_QUERY}`;
  const response = await fetchWithTimeout(url, { headers: { 'user-agent': SEARCH_USER_AGENT } }, fetchImpl, SEARCH_PROVIDER_TIMEOUT_MS);
  if (!response.ok) throw new Error(`Bing search failed with status ${response.status}`);
  const html = await response.text();
  return extractBingAnchors(html);
}

async function searchSerpApi(query, fetchImpl = fetch, options = {}) {
  const apiKey = `${options.serpApiKey || process.env.SERPAPI_API_KEY || ''}`.trim();
  if (!apiKey) throw new Error('SERPAPI_API_KEY missing');
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${MAX_SEARCH_RESULTS_PER_QUERY}&api_key=${encodeURIComponent(apiKey)}`;
  const response = await fetchWithTimeout(url, { headers: { 'user-agent': SEARCH_USER_AGENT } }, fetchImpl, SEARCH_PROVIDER_TIMEOUT_MS);
  if (!response.ok) throw new Error(`SerpAPI search failed with status ${response.status}`);
  const payload = await response.json().catch(() => ({}));
  const organic = Array.isArray(payload?.organic_results) ? payload.organic_results : [];
  return organic
    .map((item) => ({
      title: `${item?.title || ''}`.trim(),
      url: normalizeSearchResultUrl(`${item?.link || ''}`.trim()),
    }))
    .filter((item) => item.title && item.url)
    .slice(0, MAX_SEARCH_RESULTS_PER_QUERY);
}

async function searchBingApi(query, fetchImpl = fetch, options = {}) {
  const apiKey = `${options.bingApiKey || process.env.BING_SEARCH_API_KEY || ''}`.trim();
  if (!apiKey) throw new Error('BING_SEARCH_API_KEY missing');
  const endpoint = `${options.bingEndpoint || process.env.BING_SEARCH_ENDPOINT || 'https://api.bing.microsoft.com/v7.0/search'}`.trim();
  const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${MAX_SEARCH_RESULTS_PER_QUERY}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      'user-agent': SEARCH_USER_AGENT,
      'Ocp-Apim-Subscription-Key': apiKey,
    }
  }, fetchImpl, SEARCH_PROVIDER_TIMEOUT_MS);
  if (!response.ok) throw new Error(`Bing API search failed with status ${response.status}`);
  const payload = await response.json().catch(() => ({}));
  const values = Array.isArray(payload?.webPages?.value) ? payload.webPages.value : [];
  return values
    .map((item) => ({
      title: `${item?.name || ''}`.trim(),
      url: normalizeSearchResultUrl(`${item?.url || ''}`.trim()),
    }))
    .filter((item) => item.title && item.url)
    .slice(0, MAX_SEARCH_RESULTS_PER_QUERY);
}

function buildSearchProviderPlan(options = {}) {
  const primary = `${options.primarySearchProvider || ''}`.trim().toLowerCase();
  const providers = [];
  if (primary === 'serpapi') providers.push({ name: 'serpapi', fn: searchSerpApi });
  if (primary === 'bing_api') providers.push({ name: 'bing_api', fn: searchBingApi });
  if (primary === 'bing_html') providers.push({ name: 'bing_html', fn: searchBingHtml });
  if (primary === 'duckduckgo_html') providers.push({ name: 'duckduckgo_html', fn: searchDuckDuckGoHtml });

  if (!providers.some((entry) => entry.name === 'serpapi') && (`${options.serpApiKey || process.env.SERPAPI_API_KEY || ''}`.trim())) {
    providers.push({ name: 'serpapi', fn: searchSerpApi });
  }
  if (!providers.some((entry) => entry.name === 'bing_api') && (`${options.bingApiKey || process.env.BING_SEARCH_API_KEY || ''}`.trim())) {
    providers.push({ name: 'bing_api', fn: searchBingApi });
  }
  if (!providers.some((entry) => entry.name === 'bing_html')) providers.push({ name: 'bing_html', fn: searchBingHtml });
  if (!providers.some((entry) => entry.name === 'duckduckgo_html')) providers.push({ name: 'duckduckgo_html', fn: searchDuckDuckGoHtml });
  return providers;
}

function detectSourceType(url, manufacturerProfile) {
  let host = '';
  let path = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch {
    return 'other';
  }
  if ((manufacturerProfile?.preferredSourceTokens || []).some((token) => host.includes(token))) {
    if (/\.(pdf|docx?)($|[?#])/.test(path) || /\/(manuals?|downloads?)\//.test(path)) return 'manufacturer';
    return host.includes('parts.') ? 'parts' : 'support';
  }
  if ((manufacturerProfile?.sourceTokens || []).some((token) => host.includes(token))) return 'manufacturer';
  if (KNOWN_DISTRIBUTOR_DOMAINS.some((domain) => host.includes(domain.replace(/^www\./, ''))) || /betson|moss|distribut/i.test(host)) return 'distributor';
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

function hasJunkManualCandidateUrl(url = '') {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const combinedPath = `${path}${parsed.search || ''}`.toLowerCase();
    if (isHardNegativeDomain(host)) return true;
    if (/(^|\.)play\.google\.com$/.test(host) || /(^|\.)apps\.apple\.com$/.test(host)) return true;
    if (/\/(app|apps)\//.test(path) || /\/details\/?$/.test(path)) return true;
    if (/\/(install|installation|service-hub|servicehub|download-center|app-detail)\b/.test(path)) return true;
    return JUNK_PATH_PATTERNS.some((pattern) => pattern.test(combinedPath));
  } catch {
    return true;
  }
}

function classifyNonManualUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const combined = `${path}${parsed.search || ''}`.toLowerCase();

  if (isHardNegativeDomain(host)) {
    return { reason: 'hard_negative_domain', allowSupport: false };
  }
  if (/(^|\.)play\.google\.com$/.test(host) || /(^|\.)apps\.apple\.com$/.test(host)) {
    return { reason: 'non_manual_app_store_url', allowSupport: false };
  }
  if (/\/store\/apps\/details\/?/.test(path) || /\/(app|apps)\//.test(path) || /\/app-detail/.test(path)) {
    return { reason: 'non_manual_app_detail_page', allowSupport: false };
  }
  if (/\/(install|installation|installations|service-hub|servicehub|service-center|downloads?-center)\b/.test(path)) {
    return { reason: 'non_manual_install_or_service_hub', allowSupport: true };
  }
  if (/\/(catalog|brochure|brochures|products?|amusement-products|showroom|collections?)\b/.test(combined)) {
    return { reason: 'non_manual_marketing_or_catalog', allowSupport: true };
  }
  return null;
}

function hasStrongManualIntentSignal(text = '') {
  const normalized = normalizePhrase(text);
  if (!normalized) return false;
  return [
    /\bmanual\b/,
    /\boperator\b/,
    /\bservice manual\b/,
    /\binstall(?:ation)?(?: guide| manual)?\b/,
    /\bparts\b/,
    /\bdownload\b/,
    /\bpdf\b/,
    /\.pdf\b/,
    /\.docx?\b/,
  ].some((pattern) => pattern.test(normalized));
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
  const titleAndPathAndQuery = normalizePhrase(`${title || ''} ${path} ${parsed.search || ''}`);
  const titlePathQuery = normalizePhrase(`${title || ''} ${path} ${parsed.search || ''}`);
  const titleMatch = hasExactOrStrongTitle(combined, titleVariants);
  const manufacturerMatch = hasManufacturerEvidence(`${manufacturer || ''} ${host} ${title || ''}`, manufacturer, manufacturerProfile);
  const directFile = /\.(pdf|docx?)($|[?#])/.test(path);
  const directPdf = directFile || /\bpdf\b/.test(titleAndPath);
  const strongManualIntent = directFile || hasStrongManualIntentSignal(titlePathQuery);
  const junkPath = JUNK_PATH_PATTERNS.some((pattern) => pattern.test(`${path}${parsed.search || ''}`.toLowerCase()));
  const likelyChromeLink = /(?:nav|menu|footer|header|breadcrumb|search|category)/.test(titleAndPathAndQuery);
  const sourceType = detectSourceType(url, manufacturerProfile);
  const resourceType = detectResourceType(url, manufacturerProfile);
  const nonManualUrlClass = classifyNonManualUrl(parsed);
  const hardNegativeDomain = isHardNegativeDomain(host);
  const bayTekDomain = isBayTekDomain(host);
  const bayTekUtility = isBayTekProfile(manufacturerProfile) && bayTekDomain && isBayTekUtilityPath(path);
  const bayTekTitleSpecificPath = isBayTekProfile(manufacturerProfile) && bayTekDomain && hasBayTekTitleSpecificPath(path, titleVariants);
  const betsonDomain = isBetsonDomain(host);
  const betsonUtility = betsonDomain && isBetsonUtilityPath(path);
  const betsonTitleSpecificPath = betsonDomain && hasBetsonTitleSpecificPath(path, titleVariants);
  const hostManualIntent = sourceType === 'manual_library' && /manual/.test(normalizePhrase(host));
  const exactMachineManual = titleMatch && manufacturerMatch && (directFile || strongManualIntent || hostManualIntent);
  const titleSpecificOfficialPage = titleMatch
    && manufacturerMatch
    && !bayTekUtility
    && !betsonUtility
    && !isGenericSupportPath(path, titleVariants)
    && /manufacturer|support|parts|distributor/.test(sourceType)
    && path.split('/').filter(Boolean).length >= 1;
  const explicitManualBearingHtml = !directFile
    && titleSpecificOfficialPage
    && strongManualIntent;
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
    && !hardNegativeDomain
    && !nonManualUrlClass
    && !junkPath
    && !likelyChromeLink
    && !genericSupport
    && !bayTekUtility
    && !betsonUtility
    && (directFile || strongManualIntent || explicitManualBearingHtml || hostManualIntent || (betsonDomain && /\/wp-content\/uploads\//.test(path)));
  const includeSupport = !junkPath
    && !hardNegativeDomain
    && !likelyChromeLink
    && !bayTekUtility
    && !betsonUtility
    && (!nonManualUrlClass || nonManualUrlClass.allowSupport)
    && titleSpecificSupport;
  const rejectionReasons = [];

  if (!titleMatch) rejectionReasons.push('missing_title_match');
  if (!manufacturerMatch) rejectionReasons.push('missing_manufacturer_match');
  if (!directFile && !strongManualIntent && !hostManualIntent) rejectionReasons.push('missing_manual_signal');
  if (nonManualUrlClass?.reason) rejectionReasons.push(nonManualUrlClass.reason);
  if (genericSupport) rejectionReasons.push('generic_support_page');
  if (junkPath) rejectionReasons.push('junk_path');
  if (hardNegativeDomain) rejectionReasons.push('hard_negative_domain');
  if (likelyChromeLink) rejectionReasons.push('chrome_or_nav_link');
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
    strongManualIntent,
    genericSupport,
    hardNegativeDomain,
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
  const lowerPath = parsedUrl.pathname.toLowerCase();
  const combinedPath = `${lowerPath}${parsedUrl.search || ''}`;

  if (!href || href === '#' || /^#/.test(href.trim())) return true;
  if (parsedUrl.pathname === parsedBase.pathname && parsedUrl.search === parsedBase.search && parsedUrl.hash) return true;
  if (GENERIC_ANCHOR_HASHES.has(normalizedHash)) return true;
  if (isGenericAnchorTitle(title)) return true;
  if (/^(javascript:|mailto:|tel:)/i.test(href)) return true;
  if (rel.includes('nofollow') && target !== '_blank' && !/pdf/i.test(url)) return true;
  if (JUNK_PATH_PATTERNS.some((pattern) => pattern.test(combinedPath))) return true;
  if (/(^|\s)(nav|menu|header|footer|breadcrumb|search|category|service-menu)(\s|$)/.test(attributeText)) return true;

  if (mode === 'seed') {
    if (/(^|\s)(nav|menu|header|footer|skip|breadcrumb|logo|mobile-menu)(\s|$)/.test(attributeText)) return true;
    if (/\/(contact|contact-us|about|about-us|privacy-policy|privacy|terms-and-conditions|terms|faq|blog|news)(\/|$)/.test(lowerPath)) return true;
    if (/\/(cart|checkout|my-account|account|login|register|wishlist)(\/|$)/.test(lowerPath)) return true;
    if (normalizedTitle.length <= 3 && !/pdf|manual|guide|download/.test(normalizedTitle)) return true;
  }

  if (isBayTekDomain(parsedUrl.hostname)) {
    if (isBayTekUtilityPath(lowerPath)) return true;
    if (mode !== 'default' && !/\.(pdf|docx?)$/i.test(lowerPath) && /\/(contact|about|privacy|terms|faq)(\/|$)/.test(lowerPath)) return true;
  }

  if (isBetsonDomain(parsedUrl.hostname)) {
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
  let response;
  try {
    response = await fetchWithTimeout(pageUrl, { headers: { 'user-agent': SEARCH_USER_AGENT } }, fetchImpl);
  } catch (error) {
    logEvent('html_followup_error', {
      pageUrl,
      reason: isAbortLikeError(error) ? 'timeout' : sanitizeDiagnosticValue(error?.message || String(error), 120)
    });
    return [];
  }
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
      title: [pageTitle, row.title].filter(Boolean).join(' - '),
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

function getDiscoverySourcePriority(source = '') {
  const normalized = `${source || ''}`.trim().toLowerCase();
  if (normalized === 'official') return 5;
  if (normalized === 'exact_pdf') return 4;
  if (normalized === 'broad_first') return 3;
  if (normalized === 'fallback') return 2;
  if (normalized.startsWith('seed:') || normalized === 'html_followup') return 1;
  if (normalized.startsWith('adapter:')) return 0;
  return 1;
}

function consolidateByUrlWithSourcePreference(rows = []) {
  const byUrl = new Map();
  for (const row of rows) {
    const key = `${row?.url || ''}`.trim().toLowerCase();
    if (!key) continue;
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, row);
      continue;
    }
    if (getDiscoverySourcePriority(row.discoverySource) > getDiscoverySourcePriority(existing.discoverySource)) {
      byUrl.set(key, { ...existing, ...row });
    }
  }
  return Array.from(byUrl.values());
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
  const titleVariants = expandArcadeTitleAliases(cleanTitle).slice(0, 2);
  const adapters = {
    'bay tek': titleVariants.flatMap((titleVariant) => [
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${titleVariant} Bay Tek parts search`, url: `https://parts.baytekent.com/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${titleVariant} Bay Tek support search`, url: `https://baytekent.com/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${titleVariant} Betson search`, url: `https://www.betson.com/?s=${encodeURIComponent(`${titleVariant} Bay Tek`)}` },
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${titleVariant} Betson product search`, url: `https://www.betson.com/amusement-products/?s=${encodeURIComponent(titleVariant)}` }
    ]),
    'raw thrills': titleVariants.flatMap((titleVariant) => [
      { adapter: 'raw_thrills_seed', type: 'search_page', label: `${titleVariant} Raw Thrills search`, url: `https://rawthrills.com/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'raw_thrills_seed', type: 'search_page', label: `${titleVariant} Raw Thrills games`, url: `https://rawthrills.com/games/?s=${encodeURIComponent(titleVariant)}` }
    ]),
    'ice': titleVariants.flatMap((titleVariant) => [
      { adapter: 'ice_seed', type: 'search_page', label: `${titleVariant} ICE support search`, url: `https://support.icegame.com/portal/en/kb/search/${encodeURIComponent(titleVariant)}` },
      { adapter: 'ice_seed', type: 'search_page', label: `${titleVariant} ICE site search`, url: `https://www.icegame.com/?s=${encodeURIComponent(titleVariant)}` }
    ]),
    'unis': titleVariants.map((titleVariant) => (
      { adapter: 'unis_seed', type: 'search_page', label: `${titleVariant} UNIS search`, url: `https://www.unistechnology.com/?s=${encodeURIComponent(titleVariant)}` }
    )),
    'coastal amusements': titleVariants.map((titleVariant) => (
      { adapter: 'coastal_seed', type: 'search_page', label: `${titleVariant} Coastal search`, url: `https://coastalamusements.com/?s=${encodeURIComponent(titleVariant)}` }
    )),
    'lai games': titleVariants.map((titleVariant) => (
      { adapter: 'lai_seed', type: 'search_page', label: `${titleVariant} LAI Games search`, url: `https://laigames.com/?s=${encodeURIComponent(titleVariant)}` }
    )),
    'adrenaline amusements': titleVariants.map((titleVariant) => (
      { adapter: 'adrenaline_seed', type: 'search_page', label: `${titleVariant} Adrenaline search`, url: `https://adrenalineamusements.com/?s=${encodeURIComponent(titleVariant)}` }
    ))
  };

  return adapters[manufacturerProfile.key] || [];
}

async function crawlManufacturerSeedPages({ candidates, manufacturer, titleVariants, manufacturerProfile, fetchImpl, manualRows, supportRows, followupPages, logEvent }) {
  for (const candidate of dedupeByUrl(candidates).slice(0, MAX_SEED_FETCHES)) {
    try {
      const response = await fetchWithTimeout(candidate.url, { headers: { 'user-agent': SEARCH_USER_AGENT } }, fetchImpl);
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
        reason: isAbortLikeError(error) ? 'timeout' : sanitizeDiagnosticValue(error?.message || String(error), 120)
      });
    }
  }
}

function buildManufacturerDiscoveryAdapters({ title, manufacturerProfile }) {
  const titleVariants = expandArcadeTitleAliases(title).slice(0, 2);
  if (!titleVariants.length || !manufacturerProfile?.key) return [];

  const adapters = {
    'bay tek': titleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'bay_tek',
          type: 'direct_pdf',
          label: `${titleVariant} service manual`,
          url: `https://parts.baytekent.com/manuals/${slug}-service-manual.pdf`
        },
        {
          adapter: 'bay_tek',
          type: 'direct_pdf',
          label: `${titleVariant} operator manual`,
          url: `https://parts.baytekent.com/manuals/${slug}-operator-manual.pdf`
        },
        {
          adapter: 'bay_tek',
          type: 'support_page',
          label: `${titleVariant} support`,
          url: `https://parts.baytekent.com/support/${slug}`
        },
        {
          adapter: 'bay_tek',
          type: 'support_page',
          label: `${titleVariant} support`,
          url: `https://baytekent.com/support/${slug}`
        },
        {
          adapter: 'betson',
          type: 'search_page',
          label: `${titleVariant} Betson search`,
          url: `https://www.betson.com/?s=${encodeURIComponent(`${titleVariant} Bay Tek`)}`
        },
        {
          adapter: 'betson',
          type: 'support_page',
          label: `${titleVariant} Betson product`,
          url: `https://www.betson.com/amusement-products/${slug}/`
        }
      ];
    }),
    ice: titleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'ice',
          type: 'direct_pdf',
          label: `${titleVariant} service manual`,
          url: `https://support.icegame.com/manuals/${slug}-service-manual.pdf`
        },
        {
          adapter: 'ice',
          type: 'direct_pdf',
          label: `${titleVariant} operator manual`,
          url: `https://support.icegame.com/manuals/${slug}-operator-manual.pdf`
        },
        {
          adapter: 'ice',
          type: 'support_page',
          label: `${titleVariant} support`,
          url: `https://support.icegame.com/support/${slug}`
        },
        {
          adapter: 'ice',
          type: 'support_page',
          label: `${titleVariant} support`,
          url: `https://icegame.com/games/${slug}`
        }
      ];
    }),
    'raw thrills': titleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'raw_thrills',
          type: 'support_page',
          label: `${titleVariant} support`,
          url: `https://rawthrills.com/games/${slug}-support`
        },
        {
          adapter: 'raw_thrills',
          type: 'direct_pdf',
          label: `${titleVariant} operator manual`,
          url: `https://rawthrills.com/wp-content/uploads/${slug}-operator-manual.pdf`
        },
        {
          adapter: 'raw_thrills',
          type: 'direct_pdf',
          label: `${titleVariant} service manual`,
          url: `https://rawthrills.com/wp-content/uploads/${slug}-service-manual.pdf`
        }
      ];
    })
  };

  return dedupeByUrl(adapters[manufacturerProfile.key] || []);
}

async function probeAdapterCandidates({ candidates, manufacturer, titleVariants, manufacturerProfile, fetchImpl, manualRows, supportRows, followupPages, logEvent }) {
  for (const candidate of dedupeByUrl(candidates).slice(0, MAX_ADAPTER_FETCHES)) {
    try {
      const response = await fetchWithTimeout(candidate.url, { headers: { 'user-agent': SEARCH_USER_AGENT } }, fetchImpl);
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
        reason: isAbortLikeError(error) ? 'timeout' : sanitizeDiagnosticValue(error?.message || String(error), 120)
      });
    }
  }
}

async function discoverManualDocumentation({
  assetName,
  normalizedName,
  manufacturer,
  manufacturerProfile,
  searchHints = [],
  searchProvider = null,
  searchProviderOptions = {},
  fetchImpl = fetch,
  logger = console,
  traceId = ''
}) {
  const title = normalizedName || assetName;
  const manufacturerTerms = buildManufacturerQueryTerms(manufacturer, manufacturerProfile)
    .map((value) => normalizePhrase(value))
    .filter(Boolean);
  const logEvent = buildDiagnosticLogger({ logger, traceId });
  const searchPlan = buildDeterministicSearchPlan({
    assetName,
    normalizedName,
    manufacturer,
    manufacturerProfile,
    searchHints,
    logEvent,
  });
  const titleVariants = searchPlan.titleVariants;
  const { broadFirstQueries, officialQueries, exactTitleQueries, fallbackQueries } = searchPlan;
  const queries = [
    ...broadFirstQueries.map((query) => ({ query, mode: 'broad_first' })),
    ...officialQueries.map((query) => ({ query, mode: 'official' })),
    ...exactTitleQueries.map((query) => ({ query, mode: 'exact_pdf' })),
    ...fallbackQueries.map((query) => ({ query, mode: 'fallback' })),
    ...searchPlan.searchHints.map((query) => ({ query, mode: 'hint' }))
  ].slice(0, MAX_SEARCH_QUERIES);

  const manualRows = [];
  const supportRows = [];
  const followupPages = [];
  const queryExecutionOrder = [];
  const evidenceRows = [];
  let searchTimeoutCount = 0;
  let searchNoResultsCount = 0;
  const providerAttemptCounts = {};
  const providerZeroResultCounts = {};
  const providerSequenceTried = [];
  let providerFallbackInvoked = false;
  const recordEvidence = (entry = {}) => {
    if (evidenceRows.length >= 60) return;
    const url = `${entry.url || ''}`.trim();
    if (!url) return;
    evidenceRows.push({
      queryMode: `${entry.queryMode || ''}`.slice(0, 40),
      query: sanitizeDiagnosticValue(entry.query, 180),
      title: sanitizeDiagnosticValue(entry.title, 140),
      url,
      classification: `${entry.classification || ''}`.slice(0, 60),
      acceptedAs: `${entry.acceptedAs || ''}`.slice(0, 40),
      rejectionReasons: Array.isArray(entry.rejectionReasons) ? entry.rejectionReasons.slice(0, 6) : [],
    });
  };
  const adapterCandidates = buildManufacturerDiscoveryAdapters({ title, manufacturerProfile });
  const seedPages = buildManufacturerDiscoverySeedPages({ title, manufacturerProfile });
  const providerPlan = searchProvider
    ? [{ name: searchProvider?.name || 'custom_search_provider', fn: searchProvider }]
    : buildSearchProviderPlan(searchProviderOptions);

  logEvent('start', {
    assetName: sanitizeDiagnosticValue(assetName, 120),
    normalizedName: sanitizeDiagnosticValue(normalizedName, 120),
    manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
    providers: providerPlan.map((provider) => provider.name),
    adapterCount: adapterCandidates.length,
    seedPageCount: seedPages.length,
    queriesTried: queries.map((entry) => ({ mode: entry.mode, query: sanitizeDiagnosticValue(entry.query, 160) }))
  });
  logEvent('deterministic_search_plan_built', {
    title: sanitizeDiagnosticValue(title, 140),
    manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
    queryCount: queries.length,
    broadFirstCount: broadFirstQueries.length,
    officialCount: officialQueries.length,
    exactCount: exactTitleQueries.length,
    fallbackCount: fallbackQueries.length,
    titleOnlyQueryCount: searchPlan.titleOnlyQueryCount || 0,
    titleManufacturerQueryCount: searchPlan.titleManufacturerQueryCount || 0,
  });
  logEvent('title_variants_used', {
    variants: titleVariants.slice(0, 10),
  });
  logEvent('official_queries_queued', {
    queries: officialQueries.slice(0, 8).map((query) => sanitizeDiagnosticValue(query, 160)),
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
    let providerUsed = 'none';
    let results = [];
    for (let attempt = 0; attempt < providerPlan.length; attempt += 1) {
      const provider = providerPlan[attempt];
      providerSequenceTried.push(provider.name);
      providerAttemptCounts[provider.name] = Number(providerAttemptCounts[provider.name] || 0) + 1;
      logEvent('provider_batch_started', {
        mode,
        query: sanitizeDiagnosticValue(query, 160),
        provider: provider.name,
        attempt: attempt + 1,
      });
      logEvent('search_provider_attempt', {
        mode,
        query: sanitizeDiagnosticValue(query, 160),
        provider: provider.name,
        attempt: attempt + 1,
      });
      const providerResults = await provider.fn(query, fetchImpl, searchProviderOptions).catch((error) => {
        if (isAbortLikeError(error)) searchTimeoutCount += 1;
        logEvent('search_retry', {
          provider: provider.name,
          mode,
          query: sanitizeDiagnosticValue(query, 160),
          attempt: attempt + 1,
          reason: isAbortLikeError(error) ? 'timeout' : sanitizeDiagnosticValue(error?.message || String(error), 120),
        });
        return null;
      });
      if (Array.isArray(providerResults)) {
        const usable = hasUsableSearchResults(providerResults);
        queryExecutionOrder.push({
          mode,
          provider: provider.name,
          query: sanitizeDiagnosticValue(query, 160),
          resultCount: providerResults.length,
          usableResultCount: usable ? providerResults.length : 0,
        });
        if (providerResults.length <= 0 || !usable) {
          providerZeroResultCounts[provider.name] = Number(providerZeroResultCounts[provider.name] || 0) + 1;
          logEvent('provider_zero_results', {
            mode,
            query: sanitizeDiagnosticValue(query, 160),
            provider: provider.name,
            attempt: attempt + 1,
            resultCount: providerResults.length,
            unusable: !usable,
          });
          if (attempt + 1 < providerPlan.length) {
            providerFallbackInvoked = true;
            logEvent('provider_fallback_invoked', {
              mode,
              query: sanitizeDiagnosticValue(query, 160),
              fromProvider: provider.name,
              toProvider: providerPlan[attempt + 1].name,
            });
            continue;
          }
        } else {
          results = providerResults;
          providerUsed = provider.name;
          if (attempt > 0) {
            logEvent('provider_fallback_completed', {
              mode,
              query: sanitizeDiagnosticValue(query, 160),
              provider: provider.name,
              resultCount: providerResults.length,
            });
          }
          break;
        }
      }
    }

    logEvent('search_results', {
      provider: providerUsed,
      mode,
      query: sanitizeDiagnosticValue(query, 160),
      topResults: results.slice(0, 5).map((result) => ({
        title: sanitizeDiagnosticValue(result.title, 120),
        url: result.url
      }))
    });
    if (!results.length) {
      searchNoResultsCount += 1;
      logEvent('result_classification', {
        mode,
        title: '',
        url: '',
        includeManual: false,
        includeSupport: false,
        exactMachineManual: false,
        titleSpecificSupport: false,
        rejectionReasons: ['no_results']
      });
    }

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
        recordEvidence({
          queryMode: mode,
          query,
          title: result.title,
          url: result.url,
          classification: 'manual_candidate',
          acceptedAs: 'verified_manual_candidate',
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
        recordEvidence({
          queryMode: mode,
          query,
          title: result.title,
          url: result.url,
          classification: 'support_candidate',
          acceptedAs: 'support_or_product_page',
        });
      } else {
        recordEvidence({
          queryMode: mode,
          query,
          title: result.title,
          url: result.url,
          classification: 'weak_lead',
          rejectionReasons: classification.rejectionReasons,
        });
      }
    }
    if (manualRows.length >= 2 && mode === 'official') break;
  }
  logEvent('query_execution_order', { order: queryExecutionOrder });

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
        reason: isAbortLikeError(error) ? 'timeout' : sanitizeDiagnosticValue(error?.message || String(error), 120)
      });
      return [];
    });
    followedRows.push(...extracted);
  }

  const validatedManualRows = [];
  const recoveryRows = [];
  const deadManualUrls = new Set();
  const rankedManualRows = consolidateByUrlWithSourcePreference([...manualRows, ...followedRows])
    .map((candidate) => scoreManualCandidate(candidate, { titleVariants, manufacturerTerms, manufacturerProfile }))
    .filter(Boolean)
    .sort((a, b) => {
      const aDiscoveredDirectPdf = !`${a.discoverySource || ''}`.startsWith('adapter:') && a.candidateScoringFlags?.isDirectPdf;
      const bDiscoveredDirectPdf = !`${b.discoverySource || ''}`.startsWith('adapter:') && b.candidateScoringFlags?.isDirectPdf;
      if (aDiscoveredDirectPdf !== bDiscoveredDirectPdf) return aDiscoveredDirectPdf ? -1 : 1;
      return b.candidateScore - a.candidateScore || `${a.url || ''}`.localeCompare(`${b.url || ''}`);
    });
  const candidateManualRows = rankedManualRows.slice(0, MAX_DISCOVERY_RESULTS * 2);
  if (candidateManualRows.length > 1) {
    const best = candidateManualRows[0];
    const bestAdapter = candidateManualRows.find((row) => row.discoverySource.startsWith('adapter:'));
    if (bestAdapter && best.url !== bestAdapter.url && !best.discoverySource.startsWith('adapter:')) {
      logEvent('candidate_preference', {
        chosenUrl: best.url,
        chosenSource: best.discoverySource,
        chosenScore: best.candidateScore,
        adapterUrl: bestAdapter.url,
        adapterSource: bestAdapter.discoverySource,
        adapterScore: bestAdapter.candidateScore,
        reason: 'discovered_candidate_outranked_adapter_guess',
        chosenContributions: best.candidateScoreContributions,
        adapterContributions: bestAdapter.candidateScoreContributions,
      });
    }
  }
  logEvent('candidate_scoring', {
    candidates: candidateManualRows.slice(0, 6).map((entry) => ({
      url: entry.url,
      discoverySource: entry.discoverySource,
      score: entry.candidateScore,
      flags: entry.candidateScoringFlags,
      contributions: entry.candidateScoreContributions,
    }))
  });
  for (const candidate of candidateManualRows) {
    logEvent('CANDIDATE_RETRY', {
      candidateUrl: candidate.url,
      discoverySource: candidate.discoverySource,
      candidateScore: candidate.candidateScore,
      attempt: validatedManualRows.length + deadManualUrls.size + 1,
    });
    try {
      const response = await fetchWithTimeout(candidate.url, { method: 'HEAD', headers: { 'user-agent': SEARCH_USER_AGENT } }, fetchImpl);
      if (response.ok) {
        validatedManualRows.push(candidate);
        logEvent('FINAL_CANDIDATE_SUCCESS', {
          candidateUrl: candidate.url,
          discoverySource: candidate.discoverySource,
          candidateScore: candidate.candidateScore,
        });
        continue;
      }
      if (!DEAD_LINK_HTTP_STATUSES.has(Number(response.status || 0))) continue;
      deadManualUrls.add(candidate.url.toLowerCase());
      const deadLinkQueries = buildDeadLinkQueries({ title, manufacturer, failedUrl: candidate.url });
      logEvent('RECOVERY_SEARCH_STARTED', { url: candidate.url, status: response.status, fileName: extractFileNameFromUrl(candidate.url), queries: deadLinkQueries });
      logEvent('dead_link_recovery_start', { url: candidate.url, status: response.status, fileName: extractFileNameFromUrl(candidate.url), queries: deadLinkQueries });
      for (const query of deadLinkQueries) {
        for (let attempt = 0; attempt < providerPlan.length; attempt += 1) {
          const provider = providerPlan[attempt];
          const results = await provider.fn(query, fetchImpl, searchProviderOptions).catch(() => null);
          if (!Array.isArray(results)) continue;
          logEvent('RECOVERY_RESULTS', { failedUrl: candidate.url, provider: provider.name, attempt: attempt + 1, query: sanitizeDiagnosticValue(query, 160), results: results.length });
          for (const result of results.slice(0, MAX_SEARCH_RESULTS_PER_QUERY)) {
            const classification = classifyManualCandidate({
              title: result.title,
              url: result.url,
              manufacturer,
              titleVariants,
              manufacturerProfile
            });
            if (!classification.includeManual) continue;
            if (deadManualUrls.has(`${result.url || ''}`.toLowerCase())) continue;
            recoveryRows.push({
              title: result.title,
              url: result.url,
              sourceType: classification.sourceType,
              discoverySource: 'dead_link_recovery'
            });
          }
          if (recoveryRows.length >= MAX_SEARCH_RESULTS_PER_QUERY) break;
        }
        if (recoveryRows.length >= MAX_SEARCH_RESULTS_PER_QUERY) break;
      }
    } catch {
      // ignore fetch errors for validation
    }
  }
  const documentationLinks = dedupeByUrl([
    ...validatedManualRows,
    ...recoveryRows,
    ...candidateManualRows.filter((row) => !deadManualUrls.has(`${row.url || ''}`.toLowerCase()))
  ])
    .map((candidate) => scoreManualCandidate(candidate, { titleVariants, manufacturerTerms, manufacturerProfile }))
    .filter(Boolean)
    .sort((a, b) => b.candidateScore - a.candidateScore || `${a.url || ''}`.localeCompare(`${b.url || ''}`))
    .slice(0, MAX_DISCOVERY_RESULTS);
  const supportResources = dedupeByUrl(supportRows).slice(0, MAX_DISCOVERY_RESULTS);

  logEvent('complete', {
    documentationLinks: documentationLinks.map((row) => row.url),
    supportResources: supportResources.map((row) => row.url),
    htmlFollowups: dedupeByUrl(followupPages).map((row) => row.url)
  });
  logEvent('run_summary', {
    rawTitle: sanitizeDiagnosticValue(assetName, 140),
    normalizedTitle: sanitizeDiagnosticValue(normalizedName || assetName, 140),
    title: sanitizeDiagnosticValue(title, 140),
    manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
    titleVariantsUsed: titleVariants.slice(0, 10),
    manufacturerAwareNormalizationApplied: searchPlan.manufacturerAwareNormalizationApplied === true,
    titleOnlyQueryCount: searchPlan.titleOnlyQueryCount || 0,
    titleManufacturerQueryCount: searchPlan.titleManufacturerQueryCount || 0,
    providerSequenceTried: Array.from(new Set(providerSequenceTried)),
    providerAttempts: providerAttemptCounts,
    providerZeroResults: providerZeroResultCounts,
    fallbackInvoked: providerFallbackInvoked,
    selectedCandidateUrl: documentationLinks[0]?.url || '',
    selectedCandidateTier: documentationLinks[0]?.candidateScoringFlags?.isAdapterGuess ? 'D_generated_vendor_guess' : 'B_or_C_discovered_candidate',
    deadCandidatesSuppressedCount: deadManualUrls.size,
    acquisitionState: documentationLinks.length ? 'candidate_validated' : 'no_candidate_validated',
    terminalReason: documentationLinks.length ? 'docs_discovered' : 'deterministic-search-no-results',
    searchTimeoutCount,
    searchNoResultsCount,
  });

  return {
    documentationLinks,
    supportResources,
    queriesTried: queries.map((entry) => entry.query),
    evidence: evidenceRows,
    diagnostics: {
      rawTitle: sanitizeDiagnosticValue(assetName, 140),
      normalizedTitle: sanitizeDiagnosticValue(normalizedName || assetName, 140),
      manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
      titleVariantsUsed: titleVariants.slice(0, 10),
      manufacturerAwareNormalizationApplied: searchPlan.manufacturerAwareNormalizationApplied === true,
      titleOnlyQueryCount: searchPlan.titleOnlyQueryCount || 0,
      titleManufacturerQueryCount: searchPlan.titleManufacturerQueryCount || 0,
      searchTimeoutCount,
      searchNoResultsCount,
      providerAttempts: providerAttemptCounts,
      providerZeroResultCounts: providerZeroResultCounts,
      providerFallbackInvoked,
      providerSequenceTried: Array.from(new Set(providerSequenceTried)),
      selectedCandidateUrl: documentationLinks[0]?.url || '',
      deadCandidatesSuppressedCount: deadManualUrls.size,
    },
  };
}

module.exports = {
  hasJunkManualCandidateUrl,
  buildManufacturerQueryTerms,
  buildManualSearchQueries,
  buildDeterministicSearchPlan,
  buildManufacturerDiscoverySeedPages,
  buildManufacturerDiscoveryAdapters,
  searchDuckDuckGoHtml,
  extractBingAnchors,
  classifyManualCandidate,
  extractAnchorCandidates,
  extractManualLinksFromHtmlPage,
  discoverManualDocumentation
};
