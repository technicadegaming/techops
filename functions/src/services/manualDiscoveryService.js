const SEARCH_USER_AGENT = 'techops-manual-discovery/1.0';
const { normalizePhrase, expandArcadeTitleAliases, resolveArcadeTitleFamily } = require('./arcadeTitleAliasService');
const {
  classifyCandidateTier,
  buildRankedCandidate,
  compareRankedCandidates,
  TIER: CANDIDATE_TIER,
} = require('./manualCandidateRankingService');
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
const LAI_GENERIC_PARTS_PATH_PATTERNS = [
  /\/(?:cart|login|register|create_account|account)\.php(?:$|[?#])/,
  /\/shop-all-parts(?:\/|$)/,
  /\/(?:balls|cable|cabinet-components|consumables|merchandise)(?:\/|$)/,
  /\/category\//,
  /\/product-category\//,
  /\/product\/[^/]+\/?$/,
];

function buildExactTitleVariants(title, normalizedTitle) {
  return expandArcadeTitleAliases([title, normalizedTitle])
    .map((value) => normalizePhrase(value))
    .filter((value) => value.length >= 3);
}

const MANUFACTURER_VARIANT_EXPANSIONS = {
  'bay tek': ['bay tek', 'baytek', 'bay tek games', 'skee ball', 'skee-ball', 'skeeball'],
  'lai games': ['lai games', 'lai', 'lai parts', 'hyper shoot', 'hypershoot'],
  'raw thrills': ['raw thrills', 'rawthrills', 'king kong', 'skull island'],
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
  logEvent('manufacturer_aware_title_family_generated', {
    titleFamily: sanitizeDiagnosticValue(family.familyDisplayTitle || family.familyTitle || family.canonicalTitle || '', 120),
    manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
    manufacturerAliases: manufacturerAliases.slice(0, 8),
  });
  const generated = [];
  const seen = new Set();
  const rejectVariant = (value = '', reason = '') => {
    const cleaned = `${value || ''}`.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    logEvent('title_variant_rejected', {
      variant: sanitizeDiagnosticValue(cleaned, 120),
      reason: sanitizeDiagnosticValue(reason, 80),
    });
    logEvent('title_variant_rejected_reason', {
      variant: sanitizeDiagnosticValue(cleaned, 120),
      reason: sanitizeDiagnosticValue(reason, 80),
    });
  };
  const pushVariant = (value = '', reason = '') => {
    const cleaned = `${value || ''}`.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    const key = normalizePhrase(cleaned);
    if (!key || seen.has(key)) return;
    seen.add(key);
    generated.push(cleaned);
    logEvent('canonical_title_candidate', {
      canonicalTitleCandidate: sanitizeDiagnosticValue(cleaned, 120),
      normalizedCanonicalTitleCandidate: sanitizeDiagnosticValue(key, 120),
    });
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
  if (tokenized.length > 1 && tokenized.length <= 3) {
    const reordered = tokenized.slice().reverse().join(' ');
    const sorted = tokenized.slice().sort().join(' ');
    const hasStopword = tokenized.some((token) => ['the', 'of', 'and', 'for', 'in', 'on', 'at'].includes(token));
    if (hasStopword) {
      rejectVariant(reordered, 'token_reordered_plausibility_filter');
      rejectVariant(sorted, 'token_sorted_plausibility_filter');
    } else if (tokenized.length === 2 && tokenized[0].length <= 3 && tokenized[1].length >= 4) {
      pushVariant(reordered, 'token_reordered_short_lead_token');
    } else {
      rejectVariant(reordered, 'token_reordered_weak_signal');
      rejectVariant(sorted, 'token_sorted_weak_signal');
    }
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
      rejectVariant(`${typedTitle || normalizedInput} ${alias}`.trim(), 'manufacturer_suffixed_title_noise');
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
    `"${titleVariant} manual"`,
    `"${titleVariant}" arcade manual`,
    primaryManufacturerTerm ? `"${primaryManufacturerTerm}" "${titleVariant}" arcade manual` : '',
    primaryManufacturerTerm ? `${titleVariant} ${primaryManufacturerTerm} manual` : '',
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
  referenceHints = null,
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
  const referenceVariants = Array.from(new Set([
    ...(Array.isArray(referenceHints?.canonicalTitleHints) ? referenceHints.canonicalTitleHints : []),
    ...(Array.isArray(referenceHints?.aliases) ? referenceHints.aliases : []),
    ...(Array.isArray(referenceHints?.familyTitles) ? referenceHints.familyTitles : []),
  ].map((value) => `${value || ''}`.trim()).filter(Boolean))).slice(0, 10);
  const combinedTitleVariants = Array.from(new Set([...baseTitleVariants, ...referenceVariants])).slice(0, 20);
  if (referenceVariants.length) {
    logEvent('reference_variants_added', {
      referenceVariantCount: referenceVariants.length,
      referenceVariants: referenceVariants.slice(0, 8),
    });
  }
  const queries = buildManualSearchQueries({
    manufacturer,
    title: normalizedTitle,
    manufacturerProfile,
    titleVariants: combinedTitleVariants,
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
    titleVariantsUsed: combinedTitleVariants.slice(0, 12),
    titleVariantCount: combinedTitleVariants.length,
  });
  return {
    titleFamily,
    titleVariants: combinedTitleVariants,
    rawTitle,
    normalizedTitle,
    manufacturerAwareNormalizationApplied: !!(manufacturer && rawTitle),
    broadFirstQueries: queries.broadFirstQueries,
    officialQueries: queries.officialQueries,
    exactTitleQueries: queries.exactTitleQueries,
    fallbackQueries: queries.fallbackQueries,
    searchHints: Array.from(new Set([
      ...(Array.isArray(searchHints) ? searchHints : []),
      ...(Array.isArray(referenceHints?.preferredManufacturerDomains) ? referenceHints.preferredManufacturerDomains.map((domain) => `site:${domain}`) : []),
      ...(Array.isArray(referenceHints?.likelyManualFilenamePatterns) ? referenceHints.likelyManualFilenamePatterns : []),
    ])).filter(Boolean).slice(0, 6),
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
    || KNOWN_DISTRIBUTOR_DOMAINS.some((domain) => normalized.includes(normalizePhrase(domain)))
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
  const laiGenericPartsPage = /(^|\.)parts\.laigames\.com$/.test(host)
    && LAI_GENERIC_PARTS_PATH_PATTERNS.some((pattern) => pattern.test(`${path}${parsed.search || ''}`));
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
    && !laiGenericPartsPage
    && !junkPath
    && !likelyChromeLink
    && !genericSupport
    && !bayTekUtility
    && !betsonUtility
    && (directFile || strongManualIntent || explicitManualBearingHtml || hostManualIntent || (betsonDomain && /\/wp-content\/uploads\//.test(path)));
  const includeSupport = !junkPath
    && !hardNegativeDomain
    && !laiGenericPartsPage
    && !likelyChromeLink
    && !bayTekUtility
    && !betsonUtility
    && (!nonManualUrlClass || nonManualUrlClass.allowSupport)
    && titleSpecificSupport;
  const probeEligible = !includeManual
    && !includeSupport
    && titleMatch
    && manufacturerMatch
    && strongManualIntent
    && !hardNegativeDomain
    && !likelyChromeLink
    && !junkPath
    && !genericSupport
    && !bayTekUtility
    && !betsonUtility
    && (!nonManualUrlClass || nonManualUrlClass.allowSupport);
  const rejectionReasons = [];

  if (!titleMatch) rejectionReasons.push('missing_title_match');
  if (!manufacturerMatch) rejectionReasons.push('missing_manufacturer_match');
  if (!directFile && !strongManualIntent && !hostManualIntent) rejectionReasons.push('missing_manual_signal');
  if (nonManualUrlClass?.reason) rejectionReasons.push(nonManualUrlClass.reason);
  if (laiGenericPartsPage) rejectionReasons.push('lai_generic_parts_page');
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
    probeEligible,
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

function classifyCommerceNavigationUrl(url = '') {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const combined = `${path}${parsed.search || ''}`.toLowerCase();
    if (/\/(?:cart|checkout|login|register|create_account|account)\.php(?:$|[?#])/.test(combined)) return 'junk_support_page';
    if (/(^|\.)parts\.laigames\.com$/.test(host) && LAI_GENERIC_PARTS_PATH_PATTERNS.some((pattern) => pattern.test(combined))) {
      if (/\/shop-all-parts(?:\/|$)/.test(combined)) return 'lai_generic_parts_page';
      return 'commerce_navigation_link';
    }
    return '';
  } catch {
    return '';
  }
}

async function extractManualLinksFromHtmlPage({
  pageUrl,
  pageTitle,
  manufacturer,
  titleVariants,
  manufacturerProfile,
  fetchImpl = fetch,
  logEvent = () => {},
  probeSource = 'html_followup',
}) {
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
  const trustedPageHost = (() => {
    try {
      return new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const trustedDomains = new Set([
    ...KNOWN_DISTRIBUTOR_DOMAINS,
    ...(Array.isArray(manufacturerProfile?.preferredSourceTokens) ? manufacturerProfile.preferredSourceTokens : []),
    ...(Array.isArray(manufacturerProfile?.sourceTokens) ? manufacturerProfile.sourceTokens : []),
    trustedPageHost,
  ].map((value) => `${value || ''}`.toLowerCase().replace(/^www\./, '')).filter(Boolean));
  const trustedFollowupManual = (row = {}) => {
    const url = `${row?.url || ''}`.trim();
    if (!url || hasJunkManualCandidateUrl(url)) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const hostTrusted = Array.from(trustedDomains).some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!hostTrusted) return false;
    const normalized = normalizePhrase(`${row?.title || ''} ${url}`);
    if (classifyCommerceNavigationUrl(url)) return false;
    return /\.(pdf|docx?)($|[?#])/i.test(url)
      || /manual|operator|service-manual|download/.test(normalized)
      || /\/(?:manuals?|downloads?|documents?|support)\/[^?#]*$/.test(url.toLowerCase());
  };
  classified.forEach((row) => {
    const rejection = classifyCommerceNavigationUrl(row.url);
    if (rejection === 'junk_support_page') {
      logEvent('junk_support_page_rejected', { pageUrl, rejectedUrl: row.url });
    } else if (rejection === 'commerce_navigation_link') {
      logEvent('commerce_navigation_link_rejected', { pageUrl, rejectedUrl: row.url });
    } else if (rejection === 'lai_generic_parts_page') {
      logEvent('lai_generic_parts_page_rejected', { pageUrl, rejectedUrl: row.url });
    }
  });

  const accepted = classified
    .filter((row) => (row.classification.includeManual || trustedFollowupManual(row)) && !classifyCommerceNavigationUrl(row.url))
    .slice(0, 8)
    .map((row) => ({
      title: [pageTitle, row.title].filter(Boolean).join(' - '),
      url: row.url,
      sourceType: trustedFollowupManual(row)
        ? (row.classification.sourceType || 'manufacturer')
        : row.classification.sourceType,
      discoverySource: 'html_followup',
      extractedFromTrustedTitlePage: trustedFollowupManual(row),
      matchType: trustedFollowupManual(row) && !/\.(pdf|docx?)($|[?#])/i.test(row.url)
        ? 'manual_page_with_download'
        : 'exact_manual',
    }));

  accepted.forEach((entry) => {
    logEvent('candidate_probe_extracted_manual_link', {
      pageUrl,
      extractedUrl: entry.url,
      probeSource: sanitizeDiagnosticValue(probeSource, 80),
    });
    if (/rawthrills\.com/i.test(pageUrl)) {
      logEvent('raw_thrills_link_extracted_from_title_page', {
        pageUrl,
        extractedUrl: entry.url,
      });
      logEvent('raw_thrills_manual_link_extracted', {
        pageUrl,
        extractedUrl: entry.url,
      });
    }
    if (/laigames\.com/i.test(pageUrl)) {
      logEvent('lai_manual_link_extracted', {
        pageUrl,
        extractedUrl: entry.url,
      });
    }
  });

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
  if (normalized === 'reference_row_manual_url') return 7;
  if (normalized === 'reference_row_source_page') return 6;
  if (normalized === 'reference_row_support_page') return 6;
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

function isDemotedRawThrillsGuessedPdf(candidate = {}) {
  return candidate?.adapter === 'raw_thrills'
    && candidate?.type === 'direct_pdf'
    && /\/wp-content\/uploads\//i.test(`${candidate?.url || ''}`);
}

function isDemotedLaiGenericSearchPage(candidate = {}) {
  const url = `${candidate?.url || ''}`.toLowerCase();
  return candidate?.adapter === 'lai_seed'
    && candidate?.type === 'search_page'
    && (url.includes('laigames.com/support/?s=') || url.includes('parts.laigames.com/?s='));
}


function buildManufacturerDiscoverySeedPages({ title, manufacturerProfile, titleVariants = [] }) {
  const cleanTitle = `${title || ''}`.trim();
  if (!cleanTitle || !manufacturerProfile?.key) return [];
  const candidateVariants = (Array.isArray(titleVariants) && titleVariants.length
    ? titleVariants
    : expandArcadeTitleAliases(cleanTitle)).slice(0, 4);
  const adapters = {
    'bay tek': candidateVariants.flatMap((titleVariant) => [
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${titleVariant} Bay Tek parts search`, url: `https://parts.baytekent.com/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${titleVariant} Bay Tek support search`, url: `https://baytekent.com/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${titleVariant} Betson search`, url: `https://www.betson.com/?s=${encodeURIComponent(`${titleVariant} Bay Tek`)}` },
      { adapter: 'bay_tek_seed', type: 'search_page', label: `${titleVariant} Betson product search`, url: `https://www.betson.com/amusement-products/?s=${encodeURIComponent(titleVariant)}` }
    ]),
    'raw thrills': candidateVariants.flatMap((titleVariant) => [
      { adapter: 'raw_thrills_seed', type: 'search_page', label: `${titleVariant} Raw Thrills search`, url: `https://rawthrills.com/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'raw_thrills_seed', type: 'search_page', label: `${titleVariant} Raw Thrills games`, url: `https://rawthrills.com/games/?s=${encodeURIComponent(titleVariant)}` }
    ]),
    'ice': candidateVariants.flatMap((titleVariant) => [
      { adapter: 'ice_seed', type: 'search_page', label: `${titleVariant} ICE support search`, url: `https://support.icegame.com/portal/en/kb/search/${encodeURIComponent(titleVariant)}` },
      { adapter: 'ice_seed', type: 'search_page', label: `${titleVariant} ICE site search`, url: `https://www.icegame.com/?s=${encodeURIComponent(titleVariant)}` }
    ]),
    'unis': candidateVariants.map((titleVariant) => (
      { adapter: 'unis_seed', type: 'search_page', label: `${titleVariant} UNIS search`, url: `https://www.unistechnology.com/?s=${encodeURIComponent(titleVariant)}` }
    )),
    'coastal amusements': candidateVariants.map((titleVariant) => (
      { adapter: 'coastal_seed', type: 'search_page', label: `${titleVariant} Coastal search`, url: `https://coastalamusements.com/?s=${encodeURIComponent(titleVariant)}` }
    )),
    'lai games': candidateVariants.flatMap((titleVariant) => ([
      { adapter: 'lai_seed', type: 'search_page', label: `${titleVariant} LAI Games support search`, url: `https://laigames.com/support/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'lai_seed', type: 'search_page', label: `${titleVariant} LAI Games parts search`, url: `https://parts.laigames.com/?s=${encodeURIComponent(titleVariant)}` }
    ])),
    sega: candidateVariants.flatMap((titleVariant) => ([
      { adapter: 'sega_seed', type: 'search_page', label: `${titleVariant} Sega Amusements search`, url: `https://segaarcade.com/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'sega_seed', type: 'search_page', label: `${titleVariant} Sega support search`, url: `https://segaarcade.com/support/?s=${encodeURIComponent(titleVariant)}` },
    ])),
    elaut: candidateVariants.flatMap((titleVariant) => ([
      { adapter: 'elaut_seed', type: 'search_page', label: `${titleVariant} Elaut support search`, url: `https://www.elaut.com/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'elaut_seed', type: 'search_page', label: `${titleVariant} Elaut group search`, url: `https://www.elaut-group.com/?s=${encodeURIComponent(titleVariant)}` },
    ])),
    'adrenaline amusements': candidateVariants.map((titleVariant) => (
      { adapter: 'adrenaline_seed', type: 'search_page', label: `${titleVariant} Adrenaline search`, url: `https://adrenalineamusements.com/?s=${encodeURIComponent(titleVariant)}` }
    )),
    'smart industries': candidateVariants.flatMap((titleVariant) => ([
      { adapter: 'smart_industries_seed', type: 'search_page', label: `${titleVariant} Smart Industries search`, url: `https://smartind.com/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'smart_industries_seed', type: 'search_page', label: `${titleVariant} Smart Industries manuals search`, url: `https://smartind.com/manuals/?s=${encodeURIComponent(titleVariant)}` },
    ])),
    andamiro: candidateVariants.flatMap((titleVariant) => ([
      { adapter: 'andamiro_seed', type: 'search_page', label: `${titleVariant} Andamiro USA search`, url: `https://andamirousa.com/?s=${encodeURIComponent(titleVariant)}` },
      { adapter: 'andamiro_seed', type: 'search_page', label: `${titleVariant} Andamiro search`, url: `https://andamiro.com/?s=${encodeURIComponent(titleVariant)}` },
    ])),
    'benchmark games': candidateVariants.map((titleVariant) => (
      { adapter: 'benchmark_seed', type: 'search_page', label: `${titleVariant} Benchmark Games search`, url: `https://benchmarkgames.com/?s=${encodeURIComponent(titleVariant)}` }
    )),
    komuse: candidateVariants.map((titleVariant) => (
      { adapter: 'komuse_seed', type: 'search_page', label: `${titleVariant} Komuse search`, url: `https://komuse.com/?s=${encodeURIComponent(titleVariant)}` }
    ))
  };

  return adapters[manufacturerProfile.key] || [];
}

async function crawlManufacturerSeedPages({ candidates, manufacturer, titleVariants, manufacturerProfile, fetchImpl, manualRows, supportRows, followupPages, logEvent }) {
  for (const candidate of dedupeByUrl(candidates).slice(0, MAX_SEED_FETCHES)) {
    if (isDemotedLaiGenericSearchPage(candidate)) {
      logEvent('lai_generic_search_page_demoted', { url: candidate.url, reason: 'title_page_first_ordering' });
    }
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
            discoverySource: `seed:${candidate.adapter}`,
            titleSpecificSupport: row.classification.titleSpecificSupport === true,
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

function buildManufacturerDiscoveryAdapters({ title, manufacturerProfile, titleVariants = [], referenceHints = null, logEvent = () => {} }) {
  const adapterTitleVariants = (Array.isArray(titleVariants) && titleVariants.length
    ? titleVariants
    : expandArcadeTitleAliases(title)).slice(0, 4);
  if (!adapterTitleVariants.length || !manufacturerProfile?.key) return [];
  const normalizedVariants = new Set(
    adapterTitleVariants
      .map((value) => normalizePhrase(value))
      .filter(Boolean)
  );
  const jurassicFamilyDetected = Array.from(normalizedVariants).some((value) => /jurassic\s+park/.test(value));
  if (manufacturerProfile.key === 'raw thrills' && jurassicFamilyDetected) {
    [
      'jurassic park',
      'jurassic park arcade',
      'jurassic park vr',
      'raw thrills jurassic park',
      'raw thrills jurassic park arcade',
      'raw thrills jurassic park vr',
    ]
      .map((value) => normalizePhrase(value))
      .filter(Boolean)
      .forEach((value) => normalizedVariants.add(value));
  }
  const rawThrillsVariantSlugs = Array.from(normalizedVariants).map((value) => slugifyTitle(value)).filter(Boolean);

  const adapters = {
    'bay tek': adapterTitleVariants.flatMap((titleVariant) => {
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
          label: `${titleVariant} manuals`,
          url: `https://parts.baytekent.com/manuals/${slug}/`
        },
        {
          adapter: 'bay_tek',
          type: 'support_page',
          label: `${titleVariant} game page`,
          url: `https://baytekent.com/games/${slug}/`
        },
        {
          adapter: 'bay_tek',
          type: 'support_page',
          label: `${titleVariant} parts product`,
          url: `https://parts.baytekent.com/product/${slug}/`
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
    ice: adapterTitleVariants.flatMap((titleVariant) => {
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
    unis: adapterTitleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'unis',
          type: 'support_page',
          label: `${titleVariant} UNIS product`,
          url: `https://www.unistechnology.com/products/${slug}/`
        },
        {
          adapter: 'unis',
          type: 'support_page',
          label: `${titleVariant} UNIS support`,
          url: `https://www.unistechnology.com/support/${slug}/`
        },
        {
          adapter: 'unis',
          type: 'direct_pdf',
          label: `${titleVariant} UNIS operator manual`,
          url: `https://www.unistechnology.com/wp-content/uploads/${slug}-operator-manual.pdf`
        },
      ];
    }),
    andamiro: adapterTitleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'andamiro',
          type: 'support_page',
          label: `${titleVariant} Andamiro USA support`,
          url: `https://andamirousa.com/support/${slug}/`
        },
        {
          adapter: 'andamiro',
          type: 'support_page',
          label: `${titleVariant} Andamiro product`,
          url: `https://andamirousa.com/product/${slug}/`
        },
        {
          adapter: 'andamiro',
          type: 'direct_pdf',
          label: `${titleVariant} Andamiro operator manual`,
          url: `https://andamirousa.com/wp-content/uploads/${slug}-operator-manual.pdf`
        },
      ];
    }),
    'smart industries': adapterTitleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'smart_industries',
          type: 'support_page',
          label: `${titleVariant} Smart Industries manuals`,
          url: `https://smartind.com/manuals/${slug}/`
        },
        {
          adapter: 'smart_industries',
          type: 'support_page',
          label: `${titleVariant} Smart Industries product`,
          url: `https://smartind.com/product/${slug}/`
        },
        {
          adapter: 'smart_industries',
          type: 'direct_pdf',
          label: `${titleVariant} Smart Industries service manual`,
          url: `https://smartind.com/wp-content/uploads/${slug}-service-manual.pdf`
        },
      ];
    }),
    'benchmark games': adapterTitleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'benchmark_games',
          type: 'support_page',
          label: `${titleVariant} Benchmark Games support`,
          url: `https://benchmarkgames.com/support/${slug}/`
        },
        {
          adapter: 'benchmark_games',
          type: 'support_page',
          label: `${titleVariant} Benchmark Games games`,
          url: `https://benchmarkgames.com/games/${slug}/`
        },
        {
          adapter: 'benchmark_games',
          type: 'direct_pdf',
          label: `${titleVariant} Benchmark Games operator manual`,
          url: `https://benchmarkgames.com/wp-content/uploads/${slug}-operator-manual.pdf`
        },
      ];
    }),
    komuse: adapterTitleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'komuse',
          type: 'support_page',
          label: `${titleVariant} Komuse support`,
          url: `https://komuse.com/support/${slug}/`
        },
        {
          adapter: 'komuse',
          type: 'support_page',
          label: `${titleVariant} Komuse product`,
          url: `https://komuse.com/product/${slug}/`
        },
        {
          adapter: 'komuse',
          type: 'direct_pdf',
          label: `${titleVariant} Komuse operator manual`,
          url: `https://komuse.com/wp-content/uploads/${slug}-operator-manual.pdf`
        },
      ];
    }),
    'coastal amusements': adapterTitleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'coastal',
          type: 'support_page',
          label: `${titleVariant} Coastal support`,
          url: `https://coastalamusements.com/support/${slug}/`
        },
        {
          adapter: 'coastal',
          type: 'support_page',
          label: `${titleVariant} Coastal game`,
          url: `https://coastalamusements.com/games/${slug}/`
        },
        {
          adapter: 'coastal',
          type: 'direct_pdf',
          label: `${titleVariant} Coastal operator manual`,
          url: `https://coastalamusements.com/wp-content/uploads/${slug}-operator-manual.pdf`
        },
      ];
    }),
    'raw thrills': rawThrillsVariantSlugs.flatMap((slug) => {
      const titleVariant = slug.replace(/-/g, ' ');
      return [
        {
          adapter: 'raw_thrills',
          type: 'support_page',
          label: `${titleVariant} game page`,
          url: `https://rawthrills.com/games/${slug}/`
        },
        {
          adapter: 'raw_thrills',
          type: 'support_page',
          label: `${titleVariant} support`,
          url: `https://rawthrills.com/games/${slug}-support/`
        },
        {
          adapter: 'raw_thrills',
          type: 'support_page',
          label: `${titleVariant} downloads`,
          url: `https://rawthrills.com/games/${slug}/downloads/`
        },
        {
          adapter: 'raw_thrills',
          type: 'support_page',
          label: `${titleVariant} service support`,
          url: `https://rawthrills.com/service-support/${slug}/`
        },
        {
          adapter: 'raw_thrills',
          type: 'support_page',
          label: `${titleVariant} support`,
          url: `https://rawthrills.com/support/${slug}/`
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
        },
        {
          adapter: 'raw_thrills',
          type: 'direct_pdf',
          label: `${titleVariant} manual`,
          url: `https://rawthrills.com/wp-content/uploads/${slug}-manual.pdf`
        }
      ];
    }),
    'lai games': adapterTitleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'lai_games',
          type: 'support_page',
          label: `${titleVariant} product`,
          url: `https://laigames.com/games/${slug}/`
        },
        {
          adapter: 'lai_games',
          type: 'support_page',
          label: `${titleVariant} support`,
          url: `https://laigames.com/games/${slug}/support/`
        },
        {
          adapter: 'lai_games',
          type: 'support_page',
          label: `${titleVariant} downloads`,
          url: `https://laigames.com/games/${slug}/downloads/`
        },
        {
          adapter: 'lai_games',
          type: 'direct_pdf',
          label: `${titleVariant} operator manual`,
          url: `https://laigames.com/wp-content/uploads/${slug}-operator-manual.pdf`
        },
        {
          adapter: 'lai_games',
          type: 'support_page',
          label: `${titleVariant} parts`,
          url: `https://parts.laigames.com/product/${slug}/`
        },
      ];
    }),
    sega: adapterTitleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'sega',
          type: 'support_page',
          label: `${titleVariant} Sega product page`,
          url: `https://segaarcade.com/games/${slug}/`
        },
        {
          adapter: 'sega',
          type: 'support_page',
          label: `${titleVariant} Sega support page`,
          url: `https://segaarcade.com/support/${slug}/`
        },
        {
          adapter: 'sega',
          type: 'support_page',
          label: `${titleVariant} Sega downloads page`,
          url: `https://segaarcade.com/downloads/${slug}/`
        },
        {
          adapter: 'sega',
          type: 'direct_pdf',
          label: `${titleVariant} Sega operator manual`,
          url: `https://segaarcade.com/wp-content/uploads/${slug}-operator-manual.pdf`
        },
      ];
    }),
    elaut: adapterTitleVariants.flatMap((titleVariant) => {
      const slug = slugifyTitle(titleVariant);
      return [
        {
          adapter: 'elaut',
          type: 'support_page',
          label: `${titleVariant} Elaut product page`,
          url: `https://www.elaut.com/product/${slug}/`
        },
        {
          adapter: 'elaut',
          type: 'support_page',
          label: `${titleVariant} Elaut support page`,
          url: `https://www.elaut.com/support/${slug}/`
        },
        {
          adapter: 'elaut',
          type: 'support_page',
          label: `${titleVariant} Elaut Group product page`,
          url: `https://www.elaut-group.com/products/${slug}/`
        },
        {
          adapter: 'elaut',
          type: 'direct_pdf',
          label: `${titleVariant} Elaut operator manual`,
          url: `https://www.elaut.com/wp-content/uploads/${slug}-operator-manual.pdf`
        },
      ];
    }),
  };

  const seeded = dedupeByUrl(adapters[manufacturerProfile.key] || []);
  const referenceRowCandidates = Array.isArray(referenceHints?.referenceRowCandidates)
    ? referenceHints.referenceRowCandidates.slice(0, 20)
    : [];
  const referenceRowAdapterRows = [];
  const manufacturerMatchesReferenceRow = (rowManufacturer = '') => {
    const rowNormalized = normalizePhrase(rowManufacturer);
    const profileKey = normalizePhrase(manufacturerProfile?.key || '');
    if (!rowNormalized || !profileKey) return true;
    if (rowNormalized === profileKey) return true;
    const profileAliases = Array.from(new Set([
      ...(Array.isArray(manufacturerProfile?.aliases) ? manufacturerProfile.aliases : []),
      manufacturerProfile?.label || '',
      manufacturerProfile?.displayName || '',
      manufacturerProfile?.key || '',
    ].map((value) => normalizePhrase(value)).filter(Boolean)));
    return profileAliases.includes(rowNormalized) || rowNormalized.includes(profileKey) || profileKey.includes(rowNormalized);
  };
  referenceRowCandidates.forEach((row = {}) => {
    if (!manufacturerMatchesReferenceRow(row.manufacturer || '')) {
      logEvent('reference_row_filtered_out', {
        reason: 'manufacturer_mismatch',
        rowManufacturer: sanitizeDiagnosticValue(row.manufacturer || '', 120),
        manufacturerProfile: sanitizeDiagnosticValue(manufacturerProfile?.key || '', 120),
      });
      return;
    }
    const referenceRowId = sanitizeDiagnosticValue(row.sourceRowId || row.rowId || '', 120);
    const rowTitle = sanitizeDiagnosticValue(row.normalizedTitle || row.originalTitle || title, 120);
    if (row.manualUrl) {
      referenceRowAdapterRows.push({
        adapter: 'reference_row',
        type: 'direct_pdf',
        label: `${rowTitle} reference row manual`,
        url: row.manualUrl,
        referenceDerived: true,
        referenceRowField: 'manualUrl',
        referenceRowId,
      });
      logEvent('reference_row_candidate_generated', { referenceRowField: 'manualUrl', referenceRowId, url: row.manualUrl });
    }
    if (row.manualSourceUrl) {
      referenceRowAdapterRows.push({
        adapter: 'reference_row',
        type: 'support_page',
        label: `${rowTitle} reference row source page`,
        url: row.manualSourceUrl,
        referenceDerived: true,
        referenceRowField: 'manualSourceUrl',
        referenceRowId,
      });
      logEvent('reference_row_candidate_generated', { referenceRowField: 'manualSourceUrl', referenceRowId, url: row.manualSourceUrl });
    }
    if (row.supportUrl) {
      referenceRowAdapterRows.push({
        adapter: 'reference_row',
        type: 'support_page',
        label: `${rowTitle} reference row support page`,
        url: row.supportUrl,
        referenceDerived: true,
        referenceRowField: 'supportUrl',
        referenceRowId,
      });
      logEvent('reference_row_candidate_generated', { referenceRowField: 'supportUrl', referenceRowId, url: row.supportUrl });
    }
  });
  const preferredDomains = Array.isArray(referenceHints?.preferredManufacturerDomains) ? referenceHints.preferredManufacturerDomains.slice(0, 3) : [];
  const slugHints = Array.isArray(referenceHints?.likelySlugPatterns) ? referenceHints.likelySlugPatterns.slice(0, 8) : [];
  const referenceAdapterRows = [];
  const pushReferencePath = (entry = {}) => {
    if (!entry.url) return;
    referenceAdapterRows.push({ ...entry, adapter: entry.adapter || 'reference_hint', referenceDerived: true });
  };

  preferredDomains.forEach((domain) => {
    slugHints.forEach((slug) => {
      pushReferencePath({
        type: 'support_page',
        label: `${slug} reference title page`,
        url: `https://${domain}/${slug}/`
      });
      pushReferencePath({
        type: 'support_page',
        label: `${slug} reference product page`,
        url: `https://${domain}/games/${slug}/`
      });
      pushReferencePath({
        type: 'support_page',
        label: `${slug} reference support page`,
        url: `https://${domain}/support/${slug}/`
      });
      pushReferencePath({
        type: 'support_page',
        label: `${slug} reference downloads page`,
        url: `https://${domain}/downloads/${slug}/`
      });
      pushReferencePath({
        type: 'direct_pdf',
        label: `${slug} reference manual`,
        url: `https://${domain}/wp-content/uploads/${slug}-manual.pdf`
      });
    });
  });

  if (manufacturerProfile.key === 'raw thrills') {
    slugHints.forEach((slug) => {
      pushReferencePath({ adapter: 'raw_thrills_reference', type: 'support_page', label: `${slug} Raw Thrills game page`, url: `https://rawthrills.com/games/${slug}/` });
      pushReferencePath({ adapter: 'raw_thrills_reference', type: 'support_page', label: `${slug} Raw Thrills support page`, url: `https://rawthrills.com/games/${slug}-support/` });
      pushReferencePath({ adapter: 'raw_thrills_reference', type: 'support_page', label: `${slug} Raw Thrills service support`, url: `https://rawthrills.com/service-support/${slug}/` });
      pushReferencePath({ adapter: 'raw_thrills_reference', type: 'direct_pdf', label: `${slug} Raw Thrills manual pdf`, url: `https://rawthrills.com/wp-content/uploads/${slug}-manual.pdf` });
      logEvent('raw_thrills_reference_path_generated', { slug, pathsAdded: 4 });
    });
  }

  if (manufacturerProfile.key === 'lai games') {
    slugHints.forEach((slug) => {
      pushReferencePath({ adapter: 'lai_games_reference', type: 'support_page', label: `${slug} LAI title page`, url: `https://laigames.com/games/${slug}/` });
      pushReferencePath({ adapter: 'lai_games_reference', type: 'support_page', label: `${slug} LAI support page`, url: `https://laigames.com/games/${slug}/support/` });
      pushReferencePath({ adapter: 'lai_games_reference', type: 'support_page', label: `${slug} LAI downloads page`, url: `https://laigames.com/games/${slug}/downloads/` });
      pushReferencePath({ adapter: 'lai_games_reference', type: 'support_page', label: `${slug} LAI parts page`, url: `https://parts.laigames.com/product/${slug}/` });
      pushReferencePath({ adapter: 'lai_games_reference', type: 'direct_pdf', label: `${slug} LAI manual pdf`, url: `https://laigames.com/wp-content/uploads/${slug}-operator-manual.pdf` });
      logEvent('lai_reference_path_generated', { slug, pathsAdded: 5 });
    });
  }

  const orderedReferenceRows = dedupeByUrl(referenceAdapterRows).sort((a, b) => {
    if (a.type === b.type) return 0;
    if (a.type === 'direct_pdf') return -1;
    if (b.type === 'direct_pdf') return 1;
    return 0;
  });

  if (orderedReferenceRows.length) {
    logEvent('reference_adapter_paths_added', {
      referencePathCount: orderedReferenceRows.length,
      slugPatternsUsed: slugHints.slice(0, 8),
      domainsUsed: preferredDomains.slice(0, 3),
    });
  }

  return dedupeByUrl([...referenceRowAdapterRows, ...orderedReferenceRows, ...seeded]);
}

async function probeAdapterCandidates({
  candidates,
  manufacturer,
  titleVariants,
  manufacturerProfile,
  fetchImpl,
  manualRows,
  supportRows,
  followupPages,
  logEvent,
  diagnostics = {},
}) {
  let titleSpecificHitCount = 0;
  const orderedCandidates = dedupeByUrl(candidates).slice(0, MAX_ADAPTER_FETCHES);
  for (const candidate of orderedCandidates) {
    if (candidate.referenceRowField === 'manualUrl') {
      logEvent('reference_row_probe_started', { url: candidate.url, referenceRowId: candidate.referenceRowId || '', referenceRowField: 'manualUrl' });
      logEvent('reference_row_manual_url_probed', { url: candidate.url, referenceRowId: candidate.referenceRowId || '' });
      diagnostics.referenceManualUrlProbeCount = Number(diagnostics.referenceManualUrlProbeCount || 0) + 1;
    } else if (candidate.referenceRowField === 'manualSourceUrl') {
      logEvent('reference_row_probe_started', { url: candidate.url, referenceRowId: candidate.referenceRowId || '', referenceRowField: 'manualSourceUrl' });
      logEvent('reference_row_source_page_probed', { url: candidate.url, referenceRowId: candidate.referenceRowId || '' });
      diagnostics.referenceSourcePageProbeCount = Number(diagnostics.referenceSourcePageProbeCount || 0) + 1;
    } else if (candidate.referenceRowField === 'supportUrl') {
      logEvent('reference_row_probe_started', { url: candidate.url, referenceRowId: candidate.referenceRowId || '', referenceRowField: 'supportUrl' });
      logEvent('reference_row_support_page_probed', { url: candidate.url, referenceRowId: candidate.referenceRowId || '' });
      diagnostics.referenceSupportPageProbeCount = Number(diagnostics.referenceSupportPageProbeCount || 0) + 1;
    }
    if (candidate.adapter === 'raw_thrills' && candidate.type === 'support_page') {
      logEvent('raw_thrills_title_page_candidate_generated', { url: candidate.url, type: candidate.type });
    }
    if (candidate.adapter === 'lai_games' && candidate.type === 'support_page') {
      logEvent('lai_title_page_candidate_generated', { url: candidate.url, type: candidate.type });
    }
    if (isDemotedRawThrillsGuessedPdf(candidate)) {
      logEvent('raw_thrills_guessed_pdf_demoted', { url: candidate.url, reason: 'title_page_first_ordering' });
      if ((Array.isArray(candidates) ? candidates : []).some((row) => row?.referenceDerived === true && row?.type === 'support_page')) {
        logEvent('guessed_pdf_demoted_due_to_reference_path', { url: candidate.url, reason: 'reference_title_page_candidates_present' });
      }
    }
    logEvent('manufacturer_adapter_candidate_generated', {
      adapter: candidate.adapter,
      type: candidate.type,
      url: candidate.url,
    });
    try {
      const response = await fetchWithTimeout(candidate.url, { headers: { 'user-agent': SEARCH_USER_AGENT } }, fetchImpl);
      const contentType = `${response.headers?.get?.('content-type') || ''}`.toLowerCase();
      if (!response.ok) {
        if (isDemotedRawThrillsGuessedPdf(candidate) && Number(response.status || 0) === 404) {
          diagnostics.guessedPdf404Count = Number(diagnostics.guessedPdf404Count || 0) + 1;
        }
        logEvent('adapter_probe_rejected', {
          adapter: candidate.adapter,
          url: candidate.url,
          status: response.status,
          reason: 'http_error'
        });
        if (candidate.referenceRowField) {
          if (candidate.referenceRowField === 'manualUrl' && Number(response.status || 0) === 404) {
            diagnostics.referenceManualUrl404Count = Number(diagnostics.referenceManualUrl404Count || 0) + 1;
          }
          if (candidate.referenceRowField === 'manualSourceUrl') {
            diagnostics.referenceSourcePageNoManualCount = Number(diagnostics.referenceSourcePageNoManualCount || 0) + 1;
          }
          if (candidate.referenceRowField === 'supportUrl') {
            diagnostics.referenceSupportPageNoManualCount = Number(diagnostics.referenceSupportPageNoManualCount || 0) + 1;
          }
          logEvent('reference_row_candidate_rejected', {
            url: candidate.url,
            referenceRowId: candidate.referenceRowId || '',
            referenceRowField: candidate.referenceRowField,
            status: Number(response.status || 0) || 0,
            reason: 'http_error',
          });
          logEvent('reference_row_probe_skipped_reason', {
            url: candidate.url,
            referenceRowId: candidate.referenceRowId || '',
            referenceRowField: candidate.referenceRowField,
            reason: 'http_error',
            status: Number(response.status || 0) || 0,
          });
        }
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
        titleSpecificHitCount += 1;
        if (candidate.adapter === 'raw_thrills' && candidate.type === 'support_page') {
          logEvent('raw_thrills_title_page_validated', { url: candidate.url, includeManual: true });
        }
        if (candidate.adapter === 'lai_games' && candidate.type === 'support_page') {
          logEvent('lai_title_page_validated', { url: candidate.url, includeManual: true });
        }
        manualRows.push({
          title: candidate.label,
          url: candidate.url,
          sourceType: classification.sourceType,
          discoverySource: candidate.referenceRowField === 'manualUrl'
            ? 'reference_row_manual_url'
            : `adapter:${candidate.adapter}`
        });
        if (candidate.referenceRowField) {
          diagnostics.referenceRowCandidateValidatedCount = Number(diagnostics.referenceRowCandidateValidatedCount || 0) + 1;
          logEvent('reference_row_candidate_validated', {
            url: candidate.url,
            referenceRowId: candidate.referenceRowId || '',
            referenceRowField: candidate.referenceRowField,
          });
        }
        continue;
      }

      if (classification.includeSupport) {
        const commerceRejection = classifyCommerceNavigationUrl(candidate.url);
        if (commerceRejection) {
          logEvent(commerceRejection === 'junk_support_page'
            ? 'junk_support_page_rejected'
            : (commerceRejection === 'lai_generic_parts_page'
              ? 'lai_generic_parts_page_rejected'
              : 'commerce_navigation_link_rejected'), {
            url: candidate.url,
            adapter: candidate.adapter,
            referenceRowField: candidate.referenceRowField || '',
          });
          continue;
        }
        if (classification.titleSpecificSupport) titleSpecificHitCount += 1;
        if (candidate.adapter === 'raw_thrills' && candidate.type === 'support_page') {
          logEvent('raw_thrills_title_page_validated', {
            url: candidate.url,
            includeManual: false,
            titleSpecificSupport: classification.titleSpecificSupport === true,
          });
        }
        if (candidate.adapter === 'lai_games' && candidate.type === 'support_page') {
          logEvent('lai_title_page_validated', {
            url: candidate.url,
            includeManual: false,
            titleSpecificSupport: classification.titleSpecificSupport === true,
          });
        }
        supportRows.push({
          label: candidate.label,
          url: candidate.url,
          resourceType: classification.resourceType,
          discoverySource: candidate.referenceRowField === 'manualSourceUrl'
            ? 'reference_row_source_page'
            : (candidate.referenceRowField === 'supportUrl'
              ? 'reference_row_support_page'
              : `adapter:${candidate.adapter}`),
          titleSpecificSupport: classification.titleSpecificSupport === true,
        });
        if (candidate.referenceRowField) {
          diagnostics.referenceRowCandidateValidatedCount = Number(diagnostics.referenceRowCandidateValidatedCount || 0) + 1;
          logEvent('reference_row_candidate_validated', {
            url: candidate.url,
            referenceRowId: candidate.referenceRowId || '',
            referenceRowField: candidate.referenceRowField,
          });
        }
      }

      if (/text\/html|application\/xhtml\+xml/.test(contentType) && (classification.titleSpecificSupport || candidate.type === 'support_page')) {
        followupPages.push({ title: candidate.label, url: candidate.url, adapter: candidate.adapter, priority: ADAPTER_FOLLOWUP_PRIORITY });
      }
      if (classification.includeManual || classification.titleSpecificSupport) {
        logEvent('manufacturer_adapter_candidate_validated', {
          adapter: candidate.adapter,
          url: candidate.url,
          includeManual: classification.includeManual,
          titleSpecificSupport: classification.titleSpecificSupport,
        });
      }
    } catch (error) {
      logEvent('adapter_probe_error', {
        adapter: candidate.adapter,
        url: candidate.url,
        reason: isAbortLikeError(error) ? 'timeout' : sanitizeDiagnosticValue(error?.message || String(error), 120)
      });
      if (candidate.referenceRowField) {
        logEvent('reference_row_candidate_rejected', {
          url: candidate.url,
          referenceRowId: candidate.referenceRowId || '',
          referenceRowField: candidate.referenceRowField,
          reason: isAbortLikeError(error) ? 'timeout' : sanitizeDiagnosticValue(error?.message || String(error), 120),
        });
        logEvent('reference_row_probe_skipped_reason', {
          url: candidate.url,
          referenceRowId: candidate.referenceRowId || '',
          referenceRowField: candidate.referenceRowField,
          reason: isAbortLikeError(error) ? 'timeout' : sanitizeDiagnosticValue(error?.message || String(error), 120),
        });
      }
    }
  }
  if (!titleSpecificHitCount) {
    logEvent('manufacturer_adapter_no_title_specific_hit', {
      manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
      adapterCount: dedupeByUrl(candidates).slice(0, MAX_ADAPTER_FETCHES).length,
      titleVariants: (Array.isArray(titleVariants) ? titleVariants : []).slice(0, 8),
    });
  }
}

async function discoverManualDocumentation({
  assetName,
  normalizedName,
  manufacturer,
  manufacturerProfile,
  searchHints = [],
  referenceHints = null,
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
    referenceHints,
    logEvent,
  });
  const titleVariants = searchPlan.titleVariants;
  const { broadFirstQueries, officialQueries, exactTitleQueries, fallbackQueries } = searchPlan;
  const manufacturerKnown = !!normalizePhrase(manufacturer);
  const queries = [
    ...(manufacturerKnown ? officialQueries.map((query) => ({ query, mode: 'official' })) : []),
    ...(manufacturerKnown ? exactTitleQueries.map((query) => ({ query, mode: 'exact_pdf' })) : []),
    ...broadFirstQueries.map((query) => ({ query, mode: 'broad_first' })),
    ...(!manufacturerKnown ? officialQueries.map((query) => ({ query, mode: 'official' })) : []),
    ...(!manufacturerKnown ? exactTitleQueries.map((query) => ({ query, mode: 'exact_pdf' })) : []),
    ...fallbackQueries.map((query) => ({ query, mode: 'fallback' })),
    ...searchPlan.searchHints.map((query) => ({ query, mode: 'hint' }))
  ].slice(0, MAX_SEARCH_QUERIES);

  const manualRows = [];
  const supportRows = [];
  const followupPages = [];
  const adapterDiagnostics = {
    guessedPdf404Count: 0,
    referenceManualUrlProbeCount: 0,
    referenceSourcePageProbeCount: 0,
    referenceSupportPageProbeCount: 0,
    referenceManualUrl404Count: 0,
    referenceSourcePageNoManualCount: 0,
    referenceSupportPageNoManualCount: 0,
    referenceRowCandidateValidatedCount: 0,
  };
  const queryExecutionOrder = [];
  const evidenceRows = [];
  let searchTimeoutCount = 0;
  let searchNoResultsCount = 0;
  let providerBlockedCount = 0;
  let providerFailureCount = 0;
  const providerAttemptCounts = {};
  const providerZeroResultCounts = {};
  const providerFailureCounts = {};
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
  const adapterCandidates = buildManufacturerDiscoveryAdapters({ title, manufacturerProfile, titleVariants, referenceHints, logEvent });
  const referenceRowCandidates = adapterCandidates.filter((candidate) => candidate.adapter === 'reference_row');
  const referenceRowsRequested = Array.isArray(referenceHints?.referenceRowCandidates) && referenceHints.referenceRowCandidates.length > 0;
  if (referenceHints) {
    logEvent('reference_hint_rehydrated', {
      referenceEntryKey: referenceHints?.entryKey || '',
      referenceRowHintCount: Array.isArray(referenceHints?.referenceRowCandidates)
        ? referenceHints.referenceRowCandidates.length
        : 0,
      source: referenceHints?.source || 'json_index',
    });
  } else {
    logEvent('reference_hint_missing_reason', {
      reason: 'no_reference_hints_available',
    });
  }
  if (referenceRowCandidates.length) {
    logEvent('reference_row_match_expanded', {
      referenceRowCandidateCount: referenceRowCandidates.length,
      referenceRowIds: Array.from(new Set(referenceRowCandidates.map((candidate) => candidate.referenceRowId).filter(Boolean))).slice(0, 10),
      generatedProbeOrder: referenceRowCandidates.map((candidate) => candidate.referenceRowField || '').filter(Boolean).slice(0, 12),
    });
  } else if (referenceHints && referenceRowsRequested) {
    logEvent('reference_row_not_matched', {
      title: sanitizeDiagnosticValue(title, 140),
      manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
      referenceEntryKey: referenceHints?.entryKey || '',
    });
    logEvent('reference_row_probe_skipped_reason', {
      reason: 'reference_rows_not_hydrated_into_adapter_candidates',
      referenceEntryKey: referenceHints?.entryKey || '',
    });
  }
  const seedPages = buildManufacturerDiscoverySeedPages({ title, manufacturerProfile, titleVariants });
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
    logEvent('manufacturer_adapter_started', {
      manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
      adapterCandidateCount: adapterCandidates.length,
      titleVariants: titleVariants.slice(0, 8),
    });
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
      logEvent,
      diagnostics: adapterDiagnostics,
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
        const reason = sanitizeDiagnosticValue(error?.message || String(error), 120);
        const blockedOrForbidden = /\b403\b|forbidden/i.test(reason);
        providerFailureCounts[provider.name] = Number(providerFailureCounts[provider.name] || 0) + 1;
        if (isAbortLikeError(error)) searchTimeoutCount += 1;
        else if (blockedOrForbidden) providerBlockedCount += 1;
        else providerFailureCount += 1;
        if (blockedOrForbidden) {
          logEvent('provider_blocked_or_forbidden', {
            provider: provider.name,
            mode,
            query: sanitizeDiagnosticValue(query, 160),
            attempt: attempt + 1,
            reason,
          });
        } else {
          logEvent('provider_failure_nonterminal', {
            provider: provider.name,
            mode,
            query: sanitizeDiagnosticValue(query, 160),
            attempt: attempt + 1,
            reason: isAbortLikeError(error) ? 'timeout' : reason,
          });
        }
        logEvent('search_retry', {
          provider: provider.name,
          mode,
          query: sanitizeDiagnosticValue(query, 160),
          attempt: attempt + 1,
          reason: isAbortLikeError(error) ? 'timeout' : reason,
        });
        if (attempt + 1 < providerPlan.length) providerFallbackInvoked = true;
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
          discoverySource: mode,
          titleSpecificSupport: classification.titleSpecificSupport === true,
        });
        recordEvidence({
          queryMode: mode,
          query,
          title: result.title,
          url: result.url,
          classification: 'support_candidate',
          acceptedAs: 'support_or_product_page',
        });
      } else if (classification.probeEligible) {
        followupPages.push({ title: result.title, url: result.url, discoveredBy: `${mode}:probe_promoted`, priority: SEARCH_FOLLOWUP_PRIORITY });
        logEvent('candidate_promoted_for_probe', {
          mode,
          title: sanitizeDiagnosticValue(result.title, 120),
          url: result.url,
          manufacturerMatch: classification.manufacturerMatch,
          titleMatch: classification.titleMatch,
          strongManualIntent: classification.strongManualIntent,
        });
        recordEvidence({
          queryMode: mode,
          query,
          title: result.title,
          url: result.url,
          classification: 'probe_candidate',
          acceptedAs: 'probe_promoted',
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
  if ((providerBlockedCount > 0 || providerFailureCount > 0 || searchTimeoutCount > 0) && adapterCandidates.length > 0) {
    logEvent('adapter_recovery_after_provider_failure', {
      providerBlockedCount,
      providerFailureCount,
      searchTimeoutCount,
      adapterCandidateCount: adapterCandidates.length,
    });
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
      logEvent,
      probeSource: page.discoveredBy || page.adapter || 'html_followup',
    }).catch((error) => {
      logEvent('html_followup_error', {
        pageUrl: page.url,
        reason: isAbortLikeError(error) ? 'timeout' : sanitizeDiagnosticValue(error?.message || String(error), 120)
      });
      return [];
    });
    if (!extracted.length) {
      logEvent('candidate_rejected_after_probe', {
        pageUrl: page.url,
        discoveredBy: page.discoveredBy || page.adapter || 'unknown',
        reason: 'probe_no_manual_links',
      });
    }
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
  rankedManualRows.slice(0, MAX_DISCOVERY_RESULTS * 2).forEach((candidate, index) => {
    const ranked = buildRankedCandidate(candidate);
    logEvent('candidate_rank_assigned', {
      candidateUrl: candidate.url,
      candidateRankTier: ranked.tier,
      candidateDead: false,
      candidateScore: ranked.score,
      candidateIndex: index,
    });
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
  let documentationLinks = dedupeByUrl([
    ...validatedManualRows,
    ...recoveryRows,
    ...candidateManualRows.filter((row) => !deadManualUrls.has(`${row.url || ''}`.toLowerCase()))
  ])
    .map((candidate) => scoreManualCandidate(candidate, { titleVariants, manufacturerTerms, manufacturerProfile }))
    .filter(Boolean)
    .map((candidate) => buildRankedCandidate(candidate, { deadCandidateUrls: deadManualUrls }))
    .sort(compareRankedCandidates)
    .map((entry) => entry.candidate)
    .slice(0, MAX_DISCOVERY_RESULTS);
  const supportResources = dedupeByUrl(supportRows).slice(0, MAX_DISCOVERY_RESULTS);
  const titleSpecificSupportCount = supportResources.filter((entry) => entry?.titleSpecificSupport === true).length;
  const followupAttemptedCount = followupPlan.length;
  const extractedManualEvidenceCount = followedRows.length;
  const hasReferenceRows = referenceRowCandidates.length > 0;
  const anyReferenceRowProbe = Number(adapterDiagnostics.referenceManualUrlProbeCount || 0)
    + Number(adapterDiagnostics.referenceSourcePageProbeCount || 0)
    + Number(adapterDiagnostics.referenceSupportPageProbeCount || 0) > 0;
  let discoveryTerminalReason = '';
  if (documentationLinks.length) {
    discoveryTerminalReason = 'docs_discovered';
  } else if (referenceHints && referenceRowsRequested && !hasReferenceRows) {
    discoveryTerminalReason = 'reference_row_not_matched';
  } else if (hasReferenceRows && anyReferenceRowProbe && Number(adapterDiagnostics.referenceRowCandidateValidatedCount || 0) <= 0) {
    discoveryTerminalReason = 'reference_row_match_no_live_manual';
  } else if (titleSpecificSupportCount > 0) {
    discoveryTerminalReason = extractedManualEvidenceCount > 0 ? 'candidate_found_but_not_durable' : 'title_page_found_manual_probe_failed';
  } else if (supportResources.length > 0) {
    discoveryTerminalReason = 'generic-search-page-only';
  } else if (deadManualUrls.size > 0 || Number(adapterDiagnostics.guessedPdf404Count || 0) > 0) {
    discoveryTerminalReason = 'guessed-pdf-404-no-better-candidate';
  } else {
    discoveryTerminalReason = 'deterministic-search-no-results';
  }
  const bestExactDiscoveredCandidate = documentationLinks.find((entry) => {
    const tier = classifyCandidateTier(entry);
    return tier === CANDIDATE_TIER.EXACT_TITLE_VALIDATED_MANUAL
      || tier === CANDIDATE_TIER.EXACT_TITLE_UNVALIDATED_CANDIDATE
      || tier === CANDIDATE_TIER.EXACT_TITLE_SUPPORT_OR_LIBRARY;
  }) || null;
  if (bestExactDiscoveredCandidate) {
    logEvent('best_exact_title_candidate_found', {
      candidateUrl: bestExactDiscoveredCandidate.url,
      candidateTier: classifyCandidateTier(bestExactDiscoveredCandidate),
    });
  }
  if (bestExactDiscoveredCandidate && documentationLinks[0]) {
    const selectedRank = buildRankedCandidate(documentationLinks[0], { deadCandidateUrls: deadManualUrls });
    const bestRank = buildRankedCandidate(bestExactDiscoveredCandidate, { deadCandidateUrls: deadManualUrls });
    if (compareRankedCandidates(selectedRank, bestRank) > 0) {
      logEvent('final_selected_weaker_than_best_discovered', {
        selectedCandidateUrl: documentationLinks[0].url,
        selectedTier: selectedRank.tier,
        bestDiscoveredCandidateUrl: bestExactDiscoveredCandidate.url,
        bestDiscoveredTier: bestRank.tier,
      });
      logEvent('weaker_candidate_rejected', {
        rejectedCandidateUrl: documentationLinks[0].url,
        selectedCandidateUrl: bestExactDiscoveredCandidate.url,
      });
      documentationLinks = dedupeByUrl([
        bestExactDiscoveredCandidate,
        ...documentationLinks,
      ]).slice(0, MAX_DISCOVERY_RESULTS);
      logEvent('final_candidate_selected_from_best_exact_match', {
        selectedCandidateUrl: documentationLinks[0].url,
        selectedCandidateTier: classifyCandidateTier(documentationLinks[0]),
      });
    }
  }

  logEvent('complete', {
    documentationLinks: documentationLinks.map((row) => row.url),
    supportResources: supportResources.map((row) => row.url),
    htmlFollowups: dedupeByUrl(followupPages).map((row) => row.url)
  });
  if (documentationLinks.length) {
    logEvent('final_candidate_selected_from_discovery', {
      selectedCandidateUrl: documentationLinks[0].url,
      selectedCandidateTier: classifyCandidateTier(documentationLinks[0]),
    });
  }
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
    providerFailures: providerFailureCounts,
    fallbackInvoked: providerFallbackInvoked,
    providerBlockedCount,
    providerFailureCount,
    selectedCandidateUrl: documentationLinks[0]?.url || '',
    selectedCandidateTier: classifyCandidateTier(documentationLinks[0] || {}),
    bestExactTitleDiscoveredCandidateUrl: bestExactDiscoveredCandidate?.url || '',
    finalSelectedWeakerThanBestDiscovered: !!(bestExactDiscoveredCandidate && documentationLinks[0]
      && compareRankedCandidates(
        buildRankedCandidate(documentationLinks[0], { deadCandidateUrls: deadManualUrls }),
        buildRankedCandidate(bestExactDiscoveredCandidate, { deadCandidateUrls: deadManualUrls })
      ) > 0),
    deadCandidatesSuppressedCount: deadManualUrls.size,
    acquisitionState: documentationLinks.length ? 'candidate_validated' : 'no_candidate_validated',
    terminalReason: discoveryTerminalReason,
    searchTimeoutCount,
    searchNoResultsCount,
    titleSpecificSupportCount,
    followupAttemptedCount,
    extractedManualEvidenceCount,
    referenceHintSource: referenceHints ? (referenceHints.source || 'json_index') : 'none',
    referenceHit: !!referenceHints,
    referenceEntryKey: referenceHints?.entryKey || '',
    referenceSlugPatternsUsed: Array.isArray(referenceHints?.likelySlugPatterns) ? referenceHints.likelySlugPatterns.slice(0, 8) : [],
    referenceDomainsUsed: Array.isArray(referenceHints?.preferredManufacturerDomains) ? referenceHints.preferredManufacturerDomains.slice(0, 6) : [],
    titlePageFirstApplied: !!(referenceHints && adapterCandidates.some((candidate) => candidate.type === 'support_page' && candidate.referenceDerived === true)),
    referenceManualUrlProbeCount: Number(adapterDiagnostics.referenceManualUrlProbeCount || 0),
    referenceSourcePageProbeCount: Number(adapterDiagnostics.referenceSourcePageProbeCount || 0),
    referenceSupportPageProbeCount: Number(adapterDiagnostics.referenceSupportPageProbeCount || 0),
    referenceManualUrl404Count: Number(adapterDiagnostics.referenceManualUrl404Count || 0),
    referenceSourcePageNoManualCount: Number(adapterDiagnostics.referenceSourcePageNoManualCount || 0),
    referenceSupportPageNoManualCount: Number(adapterDiagnostics.referenceSupportPageNoManualCount || 0),
    referenceRowCandidateValidatedCount: Number(adapterDiagnostics.referenceRowCandidateValidatedCount || 0),
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
      providerFailureCounts,
      providerFallbackInvoked,
      providerSequenceTried: Array.from(new Set(providerSequenceTried)),
      providerBlockedCount,
      providerFailureCount,
      selectedCandidateUrl: documentationLinks[0]?.url || '',
      bestExactTitleDiscoveredCandidateUrl: bestExactDiscoveredCandidate?.url || '',
      deadCandidatesSuppressedCount: deadManualUrls.size,
      terminalReason: discoveryTerminalReason,
      titleSpecificSupportCount,
      followupAttemptedCount,
      extractedManualEvidenceCount,
      referenceHintSource: referenceHints ? (referenceHints.source || 'json_index') : 'none',
      referenceHit: !!referenceHints,
      referenceEntryKey: referenceHints?.entryKey || '',
      referenceSlugPatternsUsed: Array.isArray(referenceHints?.likelySlugPatterns) ? referenceHints.likelySlugPatterns.slice(0, 8) : [],
      referenceDomainsUsed: Array.isArray(referenceHints?.preferredManufacturerDomains) ? referenceHints.preferredManufacturerDomains.slice(0, 6) : [],
      titlePageFirstApplied: !!(referenceHints && adapterCandidates.some((candidate) => candidate.type === 'support_page' && candidate.referenceDerived === true)),
      referenceManualUrlProbeCount: Number(adapterDiagnostics.referenceManualUrlProbeCount || 0),
      referenceSourcePageProbeCount: Number(adapterDiagnostics.referenceSourcePageProbeCount || 0),
      referenceSupportPageProbeCount: Number(adapterDiagnostics.referenceSupportPageProbeCount || 0),
      referenceManualUrl404Count: Number(adapterDiagnostics.referenceManualUrl404Count || 0),
      referenceSourcePageNoManualCount: Number(adapterDiagnostics.referenceSourcePageNoManualCount || 0),
      referenceSupportPageNoManualCount: Number(adapterDiagnostics.referenceSupportPageNoManualCount || 0),
      referenceRowCandidateValidatedCount: Number(adapterDiagnostics.referenceRowCandidateValidatedCount || 0),
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
