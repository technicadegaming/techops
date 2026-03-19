const SEARCH_USER_AGENT = 'techops-manual-discovery/1.0';
const MAX_SEARCH_RESULTS_PER_QUERY = 8;
const MAX_DISCOVERY_RESULTS = 10;
const MAX_FOLLOWUP_FETCHES = 4;
const MAX_ADAPTER_FETCHES = 8;
const SEARCH_FOLLOWUP_PRIORITY = 0;
const ADAPTER_FOLLOWUP_PRIORITY = 1;
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
  const hostManualIntent = sourceType === 'manual_library' && /manual/.test(normalizePhrase(host));
  const exactMachineManual = titleMatch && manufacturerMatch && (directPdf || manualIntent || downloadIntent || hostManualIntent);
  const titleSpecificSupport = titleMatch && manufacturerMatch && /support|product|parts|downloads?|manual|service|install/.test(path);
  const genericSupport = isGenericSupportPath(path, titleVariants);
  const includeManual = titleMatch && manufacturerMatch && !genericSupport && (directPdf || manualIntent || downloadIntent || hostManualIntent);
  const includeSupport = titleSpecificSupport || sourceType === 'manufacturer' || sourceType === 'support' || sourceType === 'parts';
  const rejectionReasons = [];

  if (!titleMatch) rejectionReasons.push('missing_title_match');
  if (!manufacturerMatch) rejectionReasons.push('missing_manufacturer_match');
  if (!directPdf && !manualIntent && !downloadIntent && !hostManualIntent) rejectionReasons.push('missing_manual_signal');
  if (genericSupport) rejectionReasons.push('generic_support_page');
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
  const anchorCandidates = extractAnchorCandidates(html, pageUrl);
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
  const { officialQueries, fallbackQueries } = buildManualSearchQueries({ manufacturer, title, manufacturerProfile });
  const queries = [
    ...officialQueries.map((query) => ({ query, mode: 'official' })),
    ...fallbackQueries.map((query) => ({ query, mode: 'fallback' })),
    ...searchHints.slice(0, 3).map((query) => ({ query, mode: 'hint' }))
  ];

  const manualRows = [];
  const supportRows = [];
  const followupPages = [];
  const adapterCandidates = buildManufacturerDiscoveryAdapters({ title, manufacturerProfile });

  logEvent('start', {
    assetName: sanitizeDiagnosticValue(assetName, 120),
    normalizedName: sanitizeDiagnosticValue(normalizedName, 120),
    manufacturer: sanitizeDiagnosticValue(manufacturer, 120),
    provider: searchProvider?.name || 'anonymous_search_provider',
    adapterCount: adapterCandidates.length,
    queriesTried: queries.map((entry) => ({ mode: entry.mode, query: sanitizeDiagnosticValue(entry.query, 160) }))
  });

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
  buildManualSearchQueries,
  buildManufacturerDiscoveryAdapters,
  searchDuckDuckGoHtml,
  classifyManualCandidate,
  extractManualLinksFromHtmlPage,
  discoverManualDocumentation
};
