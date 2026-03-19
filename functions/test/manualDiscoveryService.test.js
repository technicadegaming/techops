const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildManufacturerQueryTerms,
  buildManualSearchQueries,
  buildManufacturerDiscoverySeedPages,
  buildManufacturerDiscoveryAdapters,
  classifyManualCandidate,
  extractAnchorCandidates,
  extractManualLinksFromHtmlPage,
  discoverManualDocumentation
} = require('../src/services/manualDiscoveryService');
const { getManufacturerProfile } = require('../src/services/assetEnrichmentService');

test('buildManualSearchQueries prioritizes official domains for known manufacturers', () => {
  const bayTekProfile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const queries = buildManualSearchQueries({
    manufacturer: 'Bay Tek Games',
    title: 'Quik Drop',
    manufacturerProfile: bayTekProfile
  });

  assert.match(queries.officialQueries[0], /site:parts\.baytekent\.com/i);
  assert.match(queries.exactTitleQueries[0], /"Bay Tek Games" "Quik Drop" "service manual" pdf/);
  assert.match(queries.fallbackQueries[0], /site:betson\.com/i);
});

test('buildManufacturerDiscoveryAdapters exposes deterministic candidates for Bay Tek, ICE, and Raw Thrills', () => {
  const bayTek = buildManufacturerDiscoveryAdapters({
    title: 'Quik Drop',
    manufacturerProfile: getManufacturerProfile('Bay Tek Games', 'Quik Drop')
  });
  const ice = buildManufacturerDiscoveryAdapters({
    title: 'Air FX',
    manufacturerProfile: getManufacturerProfile('ICE', 'Air FX')
  });
  const rawThrills = buildManufacturerDiscoveryAdapters({
    title: 'Jurassic Park Arcade',
    manufacturerProfile: getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade')
  });

  assert.ok(bayTek.some((row) => row.url === 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf'));
  assert.ok(ice.some((row) => row.url === 'https://support.icegame.com/manuals/air-fx-service-manual.pdf'));
  assert.ok(rawThrills.some((row) => row.url === 'https://rawthrills.com/games/jurassic-park-arcade-support'));
});

test('classifyManualCandidate restores hostname-based manual intent for exact-title manual-library links while rejecting generic manual hubs', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const exactLibraryManual = classifyManualCandidate({
    title: 'Bay Tek Quik Drop Operator Guide',
    url: 'https://manuals.example.com/bay-tek/quik-drop',
    manufacturer: 'Bay Tek Games',
    titleVariants: ['quik drop'],
    manufacturerProfile: profile
  });
  const genericLibraryHub = classifyManualCandidate({
    title: 'Bay Tek Manuals Library',
    url: 'https://manuals.example.com/library',
    manufacturer: 'Bay Tek Games',
    titleVariants: ['quik drop'],
    manufacturerProfile: profile
  });

  assert.equal(exactLibraryManual.includeManual, true);
  assert.equal(exactLibraryManual.rejectionReasons.includes('missing_manual_signal'), false);
  assert.equal(genericLibraryHub.includeManual, false);
  assert.ok(genericLibraryHub.rejectionReasons.includes('missing_title_match'));
});

test('classifyManualCandidate rejects generic support hubs with rejection reasons but keeps title-specific manual pdf links', () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade');
  const generic = classifyManualCandidate({
    title: 'Raw Thrills Support',
    url: 'https://rawthrills.com/support',
    manufacturer: 'Raw Thrills',
    titleVariants: ['jurassic park arcade'],
    manufacturerProfile: profile
  });
  const exactManual = classifyManualCandidate({
    title: 'Jurassic Park Arcade Operator Manual',
    url: 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf',
    manufacturer: 'Raw Thrills',
    titleVariants: ['jurassic park arcade'],
    manufacturerProfile: profile
  });

  assert.equal(generic.includeManual, false);
  assert.ok(generic.rejectionReasons.includes('generic_support_page'));
  assert.equal(exactManual.includeManual, true);
  assert.deepEqual(exactManual.rejectionReasons, []);
});

test('extractManualLinksFromHtmlPage pulls direct manual links from title-specific support pages', async () => {
  const events = [];
  const fetchMock = async () => ({
    ok: true,
    headers: { get: () => 'text/html' },
    text: async () => `
      <html><body>
        <a href="/downloads/quik-drop-service-manual.pdf">Quik Drop Service Manual PDF</a>
        <a href="/support">Support</a>
      </body></html>
    `
  });
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const rows = await extractManualLinksFromHtmlPage({
    pageUrl: 'https://parts.baytekent.com/support/quik-drop',
    pageTitle: 'Quik Drop Support',
    manufacturer: 'Bay Tek Games',
    titleVariants: ['quik drop'],
    manufacturerProfile: profile,
    fetchImpl: fetchMock,
    logEvent: (event, payload) => events.push({ event, payload })
  });

  assert.deepEqual(rows.map((row) => row.url), ['https://parts.baytekent.com/downloads/quik-drop-service-manual.pdf']);
  assert.equal(events.some((entry) => entry.event === 'html_followup_extracted'), true);
});

test('extractAnchorCandidates rejects junk hash, accessibility, and chrome anchors from Bay Tek seed pages', () => {
  const rows = extractAnchorCandidates(`
    <html><body>
      <a href="#">Toggle menu</a>
      <a class="skip-link screen-reader-text" href="#main-content">Skip to main content</a>
      <nav><a class="menu-link" href="/support">Support</a></nav>
      <footer><a href="/contact-us">Contact Us</a></footer>
      <main>
        <a href="/product/quik-drop/">Quik Drop</a>
        <a href="/manuals/quik-drop-service-manual.pdf">Quik Drop Service Manual PDF</a>
      </main>
    </body></html>
  `, 'https://parts.baytekent.com/?s=Quik%20Drop', { mode: 'seed' });

  assert.deepEqual(rows.map((row) => row.url), [
    'https://parts.baytekent.com/product/quik-drop/',
    'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf'
  ]);
});

test('extractAnchorCandidates rejects Bay Tek utility, homepage, and chrome links while keeping title-specific result links', () => {
  const rows = extractAnchorCandidates(`
    <html><body>
      <header><a href="https://baytekent.com/">Bay Tek Home</a></header>
      <nav>
        <a href="https://parts.baytekent.com/">Parts Home</a>
        <a href="https://parts.baytekent.com/cart.php">Cart</a>
        <a href="https://parts.baytekent.com/login.php">Login</a>
      </nav>
      <section class="products">
        <a href="https://parts.baytekent.com/product/quik-drop/">Quik Drop</a>
        <a href="https://parts.baytekent.com/support/quik-drop">Quik Drop Support</a>
        <a href="https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf">Quik Drop Service Manual PDF</a>
      </section>
    </body></html>
  `, 'https://parts.baytekent.com/?s=Quik%20Drop', { mode: 'seed' });

  assert.deepEqual(rows.map((row) => row.url), [
    'https://parts.baytekent.com/product/quik-drop/',
    'https://parts.baytekent.com/support/quik-drop',
    'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf'
  ]);
});

test('classifyManualCandidate rejects Bay Tek homepage, parts homepage, cart, and login links while keeping title-specific result and pdf links', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const candidates = [
    { url: 'https://baytekent.com/', title: 'Bay Tek Entertainment' },
    { url: 'https://parts.baytekent.com/', title: 'Bay Tek Parts' },
    { url: 'https://parts.baytekent.com/cart.php', title: 'Cart' },
    { url: 'https://parts.baytekent.com/login.php', title: 'Login' }
  ];

  for (const candidate of candidates) {
    const result = classifyManualCandidate({
      title: candidate.title,
      url: candidate.url,
      manufacturer: 'Bay Tek Games',
      titleVariants: ['quik drop'],
      manufacturerProfile: profile
    });

    assert.equal(result.includeManual, false);
    assert.equal(result.includeSupport, false);
    assert.ok(result.rejectionReasons.includes('bay_tek_utility_link') || result.rejectionReasons.includes('generic_support_page'));
  }

  const titleSpecificResult = classifyManualCandidate({
    title: 'Bay Tek Quik Drop',
    url: 'https://parts.baytekent.com/product/quik-drop/',
    manufacturer: 'Bay Tek Games',
    titleVariants: ['quik drop'],
    manufacturerProfile: profile
  });
  const directPdf = classifyManualCandidate({
    title: 'Quik Drop Service Manual PDF',
    url: 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf',
    manufacturer: 'Bay Tek Games',
    titleVariants: ['quik drop'],
    manufacturerProfile: profile
  });

  assert.equal(titleSpecificResult.includeManual, false);
  assert.equal(titleSpecificResult.titleSpecificSupport, true);
  assert.equal(titleSpecificResult.includeSupport, true);
  assert.equal(directPdf.includeManual, true);
});

test('classifyManualCandidate rejects generic Bay Tek terms/blog/parts-service pages for Quik Drop support flow', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const urls = [
    'https://www.baytekent.com/terms-conditions/',
    'https://www.baytekent.com/blog',
    'https://www.baytekent.com/parts-service',
    'https://parts.baytekent.com/'
  ];

  urls.forEach((url) => {
    const result = classifyManualCandidate({
      title: 'Bay Tek Support',
      url,
      manufacturer: 'Bay Tek Games',
      titleVariants: ['quik drop'],
      manufacturerProfile: profile
    });
    assert.equal(result.includeManual, false);
    assert.equal(result.includeSupport, false);
    assert.ok(result.rejectionReasons.includes('generic_support_page') || result.rejectionReasons.includes('bay_tek_utility_link'));
  });
});

test('discoverManualDocumentation extracts Quik Drop PDF from Betson title-specific result pages', async () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const fetchMock = async (url) => {
    if (url === 'https://www.betson.com/?s=Quik%20Drop%20Bay%20Tek') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => `
          <html><body>
            <a href="https://www.betson.com/blog">Blog</a>
            <a href="https://www.betson.com/amusement-products/quik-drop/">Quik Drop by Bay Tek</a>
          </body></html>
        `
      };
    }
    if (url === 'https://www.betson.com/amusement-products/quik-drop/') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => `
          <html><body>
            <a href="https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf">Download Quik Drop Service Manual PDF</a>
          </body></html>
        `
      };
    }
    if (url === 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    searchProvider: async () => [],
    fetchImpl: fetchMock,
    logger: { log: () => {} }
  });

  assert.equal(result.documentationLinks.some((row) => row.url === 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf'), true);
  assert.equal(result.supportResources.some((row) => /blog/.test(row.url)), false);
});

test('discoverManualDocumentation extracts real Bay Tek search results and follows title-specific result pages instead of chrome anchors', async () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const fetchMock = async (url) => {
    if (url === 'https://parts.baytekent.com/?s=Quik%20Drop') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => `
          <html><body>
            <a href="#">Toggle menu</a>
            <a class="skip-link" href="#main-content">Skip to main content</a>
            <nav><a class="menu-link" href="/support">Support</a></nav>
            <a href="/product/quik-drop/">Bay Tek Quik Drop</a>
            <a href="/manuals/quik-drop-service-manual.pdf">Quik Drop Service Manual PDF</a>
          </body></html>
        `
      };
    }
    if (url === 'https://parts.baytekent.com/product/quik-drop/') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => `
          <html><body>
            <a href="/downloads/quik-drop-operator-manual.pdf">Quik Drop Operator Manual PDF</a>
            <a href="#main-content">Skip to main content</a>
          </body></html>
        `
      };
    }
    if (url === 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf' || url === 'https://parts.baytekent.com/downloads/quik-drop-operator-manual.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    searchProvider: async () => [],
    fetchImpl: fetchMock,
    logger: { log: () => {} }
  });

  assert.deepEqual(result.documentationLinks.map((row) => row.url), [
    'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf',
    'https://parts.baytekent.com/downloads/quik-drop-operator-manual.pdf'
  ]);
  assert.equal(result.supportResources.some((row) => /#|main-content/.test(row.url)), false);
  assert.equal(result.supportResources.some((row) => row.url === 'https://parts.baytekent.com/support'), false);
});

test('discoverManualDocumentation finds exact manual-only results for Bay Tek titles and keeps generic support out of manual results', async () => {
  const logs = [];
  const searchProvider = async (query) => {
    if (query.includes('site:parts.baytekent.com') && query.includes('"Quik Drop"')) {
      return [
        { title: 'Bay Tek Support', url: 'https://baytekent.com/support' },
        { title: 'Quik Drop Service Manual PDF', url: 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf' }
      ];
    }
    return [];
  };
  const result = await discoverManualDocumentation({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: getManufacturerProfile('Bay Tek Games', 'Quik Drop'),
    searchProvider,
    fetchImpl: async (url) => ({
      ok: url === 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf',
      status: url === 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf' ? 200 : 404,
      headers: { get: () => 'application/pdf' }
    }),
    logger: { log: (...args) => logs.push(args) },
    traceId: 'trace-1'
  });

  assert.deepEqual(result.documentationLinks.map((row) => row.url), ['https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf']);
  assert.equal(result.supportResources.some((row) => row.url === 'https://baytekent.com/support'), false);
  assert.equal(logs.some((entry) => entry[0] === 'manualDiscovery:search_results'), true);
  assert.equal(logs.some((entry) => entry[0] === 'manualDiscovery:result_classification'), true);
});

test('discoverManualDocumentation regression coverage for Bay Tek, ICE, and Raw Thrills adapters and follow-up extraction', async () => {
  const searchProvider = async () => [];
  const fetchMock = async (url) => {
    if (url === 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    if (url === 'https://parts.baytekent.com/support/sink-it') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<a href="/manuals/sink-it-operator-manual.pdf">Sink It Operator Manual</a>'
      };
    }
    if (url === 'https://support.icegame.com/manuals/air-fx-service-manual.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    if (url === 'https://rawthrills.com/games/jurassic-park-arcade-support') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<a href="/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf">Jurassic Park Arcade Operator Manual</a>'
      };
    }
    if (url === 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
  };

  const cases = [
    {
      assetName: 'Quik Drop',
      manufacturer: 'Bay Tek Games',
      expected: 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf'
    },
    {
      assetName: 'Sink It',
      manufacturer: 'Bay Tek Games',
      expected: 'https://parts.baytekent.com/manuals/sink-it-operator-manual.pdf'
    },
    {
      assetName: 'Air FX',
      manufacturer: 'ICE',
      expected: 'https://support.icegame.com/manuals/air-fx-service-manual.pdf'
    },
    {
      assetName: 'Jurassic Park Arcade',
      manufacturer: 'Raw Thrills',
      expected: 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf'
    }
  ];

  for (const entry of cases) {
    const profile = getManufacturerProfile(entry.manufacturer, entry.assetName);
    const result = await discoverManualDocumentation({
      assetName: entry.assetName,
      normalizedName: entry.assetName,
      manufacturer: entry.manufacturer,
      manufacturerProfile: profile,
      searchProvider,
      fetchImpl: fetchMock,
      logger: { log: () => {} }
    });
    assert.equal(result.documentationLinks[0]?.url, entry.expected);
    assert.ok(result.documentationLinks.every((row) => !/\/support\/?$|\/products\/?$/.test(new URL(row.url).pathname)));
  }
});


test('discoverManualDocumentation prioritizes search-discovered follow-up pages ahead of adapter support pages', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade');
  const htmlFetchCounts = new Map();
  const searchSupportPages = [
    'https://rawthrills.com/games/jurassic-park-arcade-support-a',
    'https://rawthrills.com/games/jurassic-park-arcade-support-b',
    'https://rawthrills.com/games/jurassic-park-arcade-support-c',
    'https://rawthrills.com/games/jurassic-park-arcade-support-d'
  ];

  const searchProvider = async () => searchSupportPages.map((url, index) => ({
    title: `Raw Thrills Jurassic Park Arcade Support ${index + 1}`,
    url
  }));

  const fetchMock = async (url) => {
    htmlFetchCounts.set(url, Number(htmlFetchCounts.get(url) || 0) + 1);
    if (url === 'https://rawthrills.com/games/jurassic-park-arcade-support') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<a href="/support">Generic Support</a>'
      };
    }
    if (searchSupportPages.includes(url)) {
      const suffix = url.slice(-1);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => `<a href="/wp-content/uploads/jurassic-park-arcade-operator-manual-${suffix}.pdf">Jurassic Park Arcade Operator Manual ${suffix.toUpperCase()}</a>`
      };
    }
    if (/jurassic-park-arcade-operator-manual-[a-d]\.pdf$/.test(url)) {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'Jurassic Park Arcade',
    normalizedName: 'Jurassic Park Arcade',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    searchProvider,
    fetchImpl: fetchMock,
    logger: { log: () => {} }
  });

  assert.deepEqual(result.documentationLinks.map((row) => row.url), [
    'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual-a.pdf',
    'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual-b.pdf',
    'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual-c.pdf',
    'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual-d.pdf'
  ]);
  assert.equal(htmlFetchCounts.get('https://rawthrills.com/games/jurassic-park-arcade-support'), 1);
  assert.equal(htmlFetchCounts.get('https://rawthrills.com/games/jurassic-park-arcade-support-a'), 1);
  assert.equal(htmlFetchCounts.get('https://rawthrills.com/games/jurassic-park-arcade-support-d'), 1);
});


test('Bay Tek alias expansion includes entertainment naming in query terms and fallback search coverage', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const terms = buildManufacturerQueryTerms('Bay Tek Games', profile);
  const queries = buildManualSearchQueries({
    manufacturer: 'Bay Tek Games',
    title: 'Quik Drop',
    manufacturerProfile: profile
  });

  assert.ok(terms.includes('bay tek entertainment'));
  assert.ok(queries.fallbackQueries.some((query) => query.toLowerCase().includes('"bay tek entertainment"')));
});

test('buildManufacturerDiscoverySeedPages exposes deterministic Bay Tek official and distributor crawl targets', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const pages = buildManufacturerDiscoverySeedPages({ title: 'Quik Drop', manufacturerProfile: profile });

  assert.deepEqual(pages.map((row) => row.url), [
    'https://parts.baytekent.com/?s=Quik%20Drop',
    'https://baytekent.com/?s=Quik%20Drop',
    'https://www.betson.com/?s=Quik%20Drop%20Bay%20Tek',
    'https://www.betson.com/amusement-products/?s=Quik%20Drop'
  ]);
});

test('discoverManualDocumentation can recover Quik Drop direct pdf from deterministic Bay Tek seed crawling without DuckDuckGo hits', async () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const fetchMock = async (url) => {
    if (url === 'https://parts.baytekent.com/?s=Quik%20Drop') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<a href="/manuals/quik-drop-service-manual.pdf">Quik Drop Service Manual PDF</a>'
      };
    }
    if (url === 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    searchProvider: async () => [],
    fetchImpl: fetchMock,
    logger: { log: () => {} }
  });

  assert.equal(result.documentationLinks[0]?.url, 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf');
});

test('discoverManualDocumentation rejects Bay Tek utility links and extracts Quik Drop documentation suggestions from mocked search and result pages', async () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const fetchMock = async (url) => {
    if (url === 'https://parts.baytekent.com/?s=Quik%20Drop') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => `
          <html><body>
            <a href="https://parts.baytekent.com/cart.php">Cart</a>
            <a href="https://parts.baytekent.com/login.php">Login</a>
            <a href="https://baytekent.com/">Bay Tek Home</a>
            <a href="https://parts.baytekent.com/">Parts Home</a>
            <div class="product">
              <a href="/product/quik-drop/">Quik Drop</a>
            </div>
          </body></html>
        `
      };
    }
    if (url === 'https://parts.baytekent.com/product/quik-drop/') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => `
          <html><body>
            <a href="/downloads/quik-drop-operator-manual.pdf">Download Quik Drop Operator Manual</a>
            <a href="/support">Support</a>
          </body></html>
        `
      };
    }
    if (url === 'https://parts.baytekent.com/downloads/quik-drop-operator-manual.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'Quik Drop',
    normalizedName: 'Quik Drop',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    searchProvider: async () => [],
    fetchImpl: fetchMock,
    logger: { log: () => {} }
  });

  assert.ok(result.documentationLinks.some((row) => row.url === 'https://parts.baytekent.com/downloads/quik-drop-operator-manual.pdf'));
  assert.equal(result.documentationLinks.some((row) => /cart\.php|login\.php|baytekent\.com\/?$|parts\.baytekent\.com\/?$/.test(row.url)), false);
  assert.equal(result.supportResources.some((row) => /cart\.php|login\.php|https:\/\/baytekent\.com\/?$|https:\/\/parts\.baytekent\.com\/?$/.test(row.url)), false);
});
