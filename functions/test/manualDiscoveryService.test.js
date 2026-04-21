const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildManufacturerQueryTerms,
  buildDeterministicSearchPlan,
  buildManualSearchQueries,
  buildManufacturerDiscoverySeedPages,
  buildManufacturerDiscoveryAdapters,
  classifyManualCandidate,
  extractBingAnchors,
  extractAnchorCandidates,
  extractManualLinksFromHtmlPage,
  discoverManualDocumentation,
  searchDuckDuckGoHtml
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
  assert.ok(queries.broadFirstQueries.some((query) => query === '"Quik Drop" arcade manual'));
  assert.ok(queries.broadFirstQueries.some((query) => /"Bay Tek(?: Games)?" "Quik Drop" arcade manual/i.test(query)));
  assert.ok(queries.broadFirstQueries.some((query) => query === '"Quik Drop" operator manual'));
  assert.ok(queries.broadFirstQueries.some((query) => query === '"Quik Drop" service manual'));
  assert.ok(queries.broadFirstQueries.some((query) => query === '"Quik Drop" install guide'));
  assert.ok(queries.broadFirstQueries.some((query) => query === '"Quik Drop" pdf'));
  assert.ok(queries.exactTitleQueries.some((query) => /"Bay Tek(?: Games)?" "Quik Drop" "service manual" pdf/.test(query)));
  assert.match(queries.fallbackQueries[0], /site:betson\.com/i);
  assert.ok(queries.exactTitleQueries.some((query) => /"Quik Drop" manual pdf/i.test(query)));
  assert.ok(queries.exactTitleQueries.some((query) => /"Quik Drop" operator manual pdf/i.test(query)));
  assert.ok(queries.exactTitleQueries.some((query) => /filetype:pdf "Quik Drop"/i.test(query)));
  assert.ok(queries.exactTitleQueries.some((query) => /^quik drop manual pdf$/i.test(query)));
  assert.ok(queries.fallbackQueries.some((query) => /"Quik Drop" distributor manual/i.test(query)));
  assert.ok(queries.fallbackQueries.some((query) => /site:mossdistributing\.com/i.test(query)));
});

test('buildManualSearchQueries includes broadened non-quoted query variants for Raw Thrills title families', () => {
  const profile = getManufacturerProfile('Raw Thrills', 'King Kong VR');
  const queries = buildManualSearchQueries({
    manufacturer: 'Raw Thrills',
    title: 'King Kong VR',
    manufacturerProfile: profile,
  });
  const normalized = queries.exactTitleQueries.map((query) => query.toLowerCase());
  assert.equal(normalized.includes('raw thrills king kong of skull island vr pdf'), true);
  assert.equal(normalized.includes('king kong of skull island vr raw thrills manual'), true);
  assert.equal(normalized.includes('filetype:pdf king kong of skull island vr raw thrills'), true);
});

test('buildDeterministicSearchPlan includes typed/normalized/family variants and baseline deterministic queries', () => {
  const profile = getManufacturerProfile('LAI Games', 'Virtual Rabbids');
  const plan = buildDeterministicSearchPlan({
    assetName: 'Virtual Rabbids',
    normalizedName: 'Virtual Rabbids: The Big Ride',
    manufacturer: 'LAI Games',
    manufacturerProfile: profile,
    searchHints: ['virtual rabbids service manual'],
  });

  assert.equal(plan.titleVariants.includes('Virtual Rabbids'), true);
  assert.equal(plan.titleVariants.includes('Virtual Rabbids: The Big Ride'), true);
  assert.ok(plan.broadFirstQueries.some((query) => query === '"Virtual Rabbids" arcade manual'));
  assert.ok(plan.broadFirstQueries.some((query) => query === '"Virtual Rabbids" install guide'));
  assert.ok(plan.broadFirstQueries.some((query) => query === '"Virtual Rabbids" pdf'));
  assert.ok(plan.officialQueries.every((query) => query.startsWith('site:')));
});

test('buildDeterministicSearchPlan applies manufacturer-aware normalization for vague Bay Tek titles', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Skeeball Modern');
  const plan = buildDeterministicSearchPlan({
    assetName: 'skeeball modern',
    normalizedName: 'skeeball modern',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
  });

  const normalizedVariants = plan.titleVariants.map((entry) => entry.toLowerCase());
  assert.equal(plan.manufacturerAwareNormalizationApplied, true);
  assert.equal(normalizedVariants.some((entry) => entry.includes('skeeball')), true);
  assert.equal(normalizedVariants.some((entry) => entry.includes('bay tek')), true);
});

test('buildDeterministicSearchPlan filters noisy token-reordered title variants while keeping useful normalized variants', () => {
  const profile = getManufacturerProfile('Sega', 'Power Roll');
  const logs = [];
  const plan = buildDeterministicSearchPlan({
    assetName: 'Power Roll',
    normalizedName: 'Wizard of Oz',
    manufacturer: 'Sega',
    manufacturerProfile: profile,
    logEvent: (event, payload) => logs.push([event, payload]),
  });
  const normalizedVariants = plan.titleVariants.map((entry) => entry.toLowerCase());
  assert.equal(normalizedVariants.includes('power roll'), true);
  assert.equal(normalizedVariants.includes('wizard of oz'), true);
  assert.equal(normalizedVariants.includes('roll power'), false);
  assert.equal(normalizedVariants.includes('oz of wizard'), false);
  assert.equal(normalizedVariants.includes('of oz wizard'), false);
  assert.equal(normalizedVariants.includes('power roll sega'), false);
  assert.equal(logs.some(([event]) => event === 'title_variant_rejected'), true);
  assert.equal(logs.some(([event]) => event === 'title_variant_rejected_reason'), true);
});

test('buildManualSearchQueries always includes both title-only and title+manufacturer deterministic query pairs', () => {
  const profile = getManufacturerProfile('LAI Games', 'Virtual Rabbids');
  const queries = buildManualSearchQueries({
    manufacturer: 'LAI Games',
    title: 'Virtual Rabbids',
    manufacturerProfile: profile,
  });

  const baseline = queries.broadFirstQueries.map((entry) => entry.toLowerCase());
  assert.equal(baseline.includes('"virtual rabbids" arcade manual'), true);
  assert.equal(baseline.some((entry) => /"lai games"\s+"virtual rabbids"\s+arcade manual/.test(entry)), true);
  assert.equal(baseline.includes('"virtual rabbids" operator manual'), true);
  assert.equal(baseline.some((entry) => /"lai games"\s+"virtual rabbids"\s+operator manual/.test(entry)), true);
  assert.equal(baseline.includes('"virtual rabbids" service manual'), true);
  assert.equal(baseline.some((entry) => /"lai games"\s+"virtual rabbids"\s+service manual/.test(entry)), true);
  assert.equal(baseline.includes('"virtual rabbids" install guide'), true);
  assert.equal(baseline.some((entry) => /"lai games"\s+"virtual rabbids"\s+install guide/.test(entry)), true);
  assert.equal(baseline.includes('"virtual rabbids" pdf'), true);
  assert.equal(baseline.some((entry) => /"lai games"\s+"virtual rabbids"\s+pdf/.test(entry)), true);
});

test('buildManufacturerDiscoveryAdapters exposes deterministic candidates for Bay Tek and Raw Thrills', () => {
  const bayTek = buildManufacturerDiscoveryAdapters({
    title: 'Quik Drop',
    manufacturerProfile: getManufacturerProfile('Bay Tek Games', 'Quik Drop')
  });
  const rawThrills = buildManufacturerDiscoveryAdapters({
    title: 'Jurassic Park Arcade',
    manufacturerProfile: getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade')
  });

  assert.ok(bayTek.some((row) => row.url === 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf'));
  assert.ok(rawThrills.some((row) => row.url === 'https://rawthrills.com/games/jurassic-park-arcade-support/'));
});

test('buildManufacturerDiscoveryAdapters includes Sega and Elaut title-specific adapter candidates', () => {
  const sega = buildManufacturerDiscoveryAdapters({
    title: 'Power Roll',
    titleVariants: ['Power Roll'],
    manufacturerProfile: getManufacturerProfile('Sega', 'Power Roll'),
  });
  const elaut = buildManufacturerDiscoveryAdapters({
    title: 'Wizard of Oz',
    titleVariants: ['Wizard of Oz'],
    manufacturerProfile: getManufacturerProfile('Elaut', 'Wizard of Oz'),
  });
  assert.equal(sega.some((entry) => entry.url === 'https://segaarcade.com/games/power-roll/'), true);
  assert.equal(sega.some((entry) => /segaarcade\.com\/wp-content\/uploads\/power-roll-operator-manual\.pdf/.test(entry.url)), true);
  assert.equal(elaut.some((entry) => entry.url === 'https://www.elaut.com/product/wizard-of-oz/'), true);
  assert.equal(elaut.some((entry) => /elaut\.com\/wp-content\/uploads\/wizard-of-oz-operator-manual\.pdf/.test(entry.url)), true);
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

test('classifyManualCandidate hard-rejects junk installations, services, search, and blog links even when manual-ish words appear', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Sink It Shootout');
  const junkCandidates = [
    {
      title: 'Sink It Shootout Installations',
      url: 'https://baytekent.com/installations/sink-it-shootout/'
    },
    {
      title: 'Sink It Shootout Financial Services',
      url: 'https://baytekent.com/financial-services/sink-it/'
    },
    {
      title: 'Sink It Shootout Search',
      url: 'https://www.betson.com/?s=Sink+It+Shootout'
    },
    {
      title: 'Sink It Shootout Blog',
      url: 'https://baytekent.com/blog/sink-it-shootout-service'
    }
  ];

  junkCandidates.forEach((candidate) => {
    const result = classifyManualCandidate({
      title: candidate.title,
      url: candidate.url,
      manufacturer: 'Bay Tek Games',
      titleVariants: ['sink it', 'sink it shootout'],
      manufacturerProfile: profile
    });

    assert.equal(result.includeManual, false);
    assert.equal(result.includeSupport, false);
    assert.ok(result.rejectionReasons.includes('junk_path') || result.rejectionReasons.includes('generic_support_page'));
  });
});

test('classifyManualCandidate rejects Google Play and App Store URLs as non-manual app listings', () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Willy Crash');
  const googlePlay = classifyManualCandidate({
    title: 'Willy Crash App Listing',
    url: 'https://play.google.com/store/apps/details?id=com.example.willycrash',
    manufacturer: 'Raw Thrills',
    titleVariants: ['willy crash'],
    manufacturerProfile: profile,
  });
  const appleStore = classifyManualCandidate({
    title: 'Willy Crash iOS',
    url: 'https://apps.apple.com/us/app/willy-crash/id1234567890',
    manufacturer: 'Raw Thrills',
    titleVariants: ['willy crash'],
    manufacturerProfile: profile,
  });

  assert.equal(googlePlay.includeManual, false);
  assert.equal(googlePlay.includeSupport, false);
  assert.ok(googlePlay.rejectionReasons.includes('non_manual_app_store_url'));

  assert.equal(appleStore.includeManual, false);
  assert.equal(appleStore.includeSupport, false);
  assert.ok(appleStore.rejectionReasons.includes('non_manual_app_store_url'));
});

test('classifyManualCandidate hard-rejects known irrelevant hard-negative domains for manual lookups', () => {
  const profile = getManufacturerProfile('LAI Games', 'Virtual Rabbids');
  const irrelevant = classifyManualCandidate({
    title: 'Virtual Rabbids manual',
    url: 'https://www.virtualdj.com/forums/123456/Virtual-Rabbids.html',
    manufacturer: 'LAI Games',
    titleVariants: ['virtual rabbids'],
    manufacturerProfile: profile,
  });

  assert.equal(irrelevant.includeManual, false);
  assert.equal(irrelevant.includeSupport, false);
  assert.ok(irrelevant.rejectionReasons.includes('hard_negative_domain'));
});

test('extractBingAnchors unwraps Bing redirects and drops hard-negative domains early', () => {
  const rows = extractBingAnchors(`
    <li class="b_algo">
      <h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=${encodeURIComponent('https://laigames.com/virtual-rabbids-the-big-ride/')}">Virtual Rabbids | LAI Games</a></h2>
    </li>
    <li class="b_algo">
      <h2><a href="https://www.zhihu.com/question/12345">Virtual Rabbids question</a></h2>
    </li>
    <li class="b_algo">
      <h2><a href="https://www.virtualdj.com/forums/12345/arcade.html">Virtual Rabbids forum</a></h2>
    </li>
    <li class="b_algo">
      <h2><a href="https://www.bing.com/search?q=virtual+rabbids">Bing search wrapper</a></h2>
    </li>
  `);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://laigames.com/virtual-rabbids-the-big-ride/');
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

test('classifyManualCandidate rejects LAI generic commerce/auth/cart/category pages for manual/support extraction', () => {
  const profile = getManufacturerProfile('LAI Games', 'HYPERshoot');
  const urls = [
    'https://parts.laigames.com/cart.php',
    'https://parts.laigames.com/login.php',
    'https://parts.laigames.com/create_account.php',
    'https://parts.laigames.com/shop-all-parts',
    'https://parts.laigames.com/balls/',
    'https://parts.laigames.com/cabinet-components/',
    'https://parts.laigames.com/category/decals/',
  ];
  urls.forEach((url) => {
    const row = classifyManualCandidate({
      title: 'HYPERshoot support',
      url,
      manufacturer: 'LAI Games',
      titleVariants: ['hypershoot'],
      manufacturerProfile: profile,
    });
    assert.equal(row.includeManual, false);
    assert.equal(row.includeSupport, false);
    assert.ok(
      row.rejectionReasons.includes('lai_generic_parts_page')
      || row.rejectionReasons.includes('junk_path')
      || row.rejectionReasons.includes('not_support_or_manual')
    );
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

test('discoverManualDocumentation logs broad-first query execution order and recovers Raw Thrills-style candidates when official misses', async () => {
  const events = [];
  const profile = getManufacturerProfile('Raw Thrills', 'King Kong VR');
  const result = await discoverManualDocumentation({
    assetName: 'King Kong VR',
    normalizedName: 'King Kong VR',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    logger: { log: (event, payload) => events.push({ event, payload }) },
    traceId: 'raw-thrills-broad-first',
    searchProvider: async (query) => {
      if (/king kong/i.test(query)) {
        return [{ title: 'King Kong Operator Manual PDF', url: 'https://cdn.example.com/king-kong-operator-manual.pdf' }];
      }
      return [];
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/pdf' },
      text: async () => '',
      arrayBuffer: async () => Buffer.from('%PDF-1.4')
    })
  });
  assert.equal(result.documentationLinks.some((row) => /king-kong-operator-manual\.pdf/i.test(row.url)), true);
  const orderEvent = events.find((entry) => entry.event === 'manualDiscovery:query_execution_order');
  assert.ok(orderEvent);
  assert.equal(orderEvent.payload?.order?.[0]?.mode, 'official');
});

test('discoverManualDocumentation falls back from all-zero Bing batch to DuckDuckGo and uses fallback provider results', async () => {
  const logs = [];
  const profile = getManufacturerProfile('LAI Games', 'Virtual Rabbids');
  const fetchMock = async (url, options = {}) => {
    const asString = String(url);
    if (asString.includes('bing.com/search?')) {
      return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<html><body>No results</body></html>' };
    }
    if (asString.includes('duckduckgo.com/html/?q=')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => `
          <a class="result__a" rel="nofollow" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://laigames.com/downloads/virtual-rabbids-operator-manual.pdf')}">
            Virtual Rabbids Operator Manual
          </a>
        `,
      };
    }
    if (asString.includes('duckduckgo.com/lite/?q=')) {
      return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '' };
    }
    if (asString === 'https://laigames.com/downloads/virtual-rabbids-operator-manual.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, text: async () => '', arrayBuffer: async () => Buffer.from('%PDF-1.4') };
    }
    if (options.method === 'HEAD') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'Virtual Rabbids',
    normalizedName: 'Virtual Rabbids: The Big Ride',
    manufacturer: 'LAI Games',
    manufacturerProfile: profile,
    searchProviderOptions: { primarySearchProvider: 'bing_html' },
    fetchImpl: fetchMock,
    logger: { log: (event, payload) => logs.push([event, payload]) },
    traceId: 'fallback-bing-to-ddg',
  });

  assert.equal(result.documentationLinks.some((row) => row.url === 'https://laigames.com/downloads/virtual-rabbids-operator-manual.pdf'), true);
  assert.equal(logs.some(([event]) => event === 'manualDiscovery:provider_batch_started'), true);
  assert.equal(logs.some(([event]) => event === 'manualDiscovery:provider_zero_results'), true);
  assert.equal(logs.some(([event]) => event === 'manualDiscovery:provider_fallback_invoked'), true);
  assert.equal(logs.some(([event]) => event === 'manualDiscovery:run_summary'), true);
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

  assert.deepEqual(result.documentationLinks.map((row) => row.url).sort(), [
    'https://parts.baytekent.com/downloads/quik-drop-operator-manual.pdf',
    'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf',
  ].sort());
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
    if (url === 'https://parts.baytekent.com/manuals/sink-it-operator-manual.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    if (url === 'https://support.icegame.com/manuals/air-fx-service-manual.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    if (url === 'https://rawthrills.com/games/jurassic-park-arcade-support' || url === 'https://rawthrills.com/games/jurassic-park-arcade-support/') {
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
  assert.equal(
    Number(htmlFetchCounts.get('https://rawthrills.com/games/jurassic-park-arcade-support/') || htmlFetchCounts.get('https://rawthrills.com/games/jurassic-park-arcade-support') || 0),
    1,
  );
  assert.equal(htmlFetchCounts.get('https://rawthrills.com/games/jurassic-park-arcade-support-a'), 1);
  assert.equal(htmlFetchCounts.get('https://rawthrills.com/games/jurassic-park-arcade-support-d'), 1);
});

test('discoverManualDocumentation prefers discovered numbered/revisioned Raw Thrills PDFs over guessed adapter slugs', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'King Kong VR');
  const logs = [];
  const searchProvider = async () => ([
    {
      title: 'King Kong of Skull Island Manual REV6',
      url: 'https://rawthrills.com/wp-content/uploads/040-00078-01_King_Kong_of_Skull_Island_Manual_REV6.pdf'
    }
  ]);
  const fetchMock = async (url, options = {}) => {
    const method = options?.method || 'GET';
    if (method === 'HEAD') {
      if (url === 'https://rawthrills.com/wp-content/uploads/040-00078-01_King_Kong_of_Skull_Island_Manual_REV6.pdf') {
        return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
      }
      if (/king-kong-of-skull-island-vr-operator-manual\.pdf$/.test(url) || /king-kong-vr-operator-manual\.pdf$/.test(url)) {
        return { ok: false, status: 404, headers: { get: () => 'text/html' } };
      }
    }
    if (url === 'https://rawthrills.com/games/king-kong-of-skull-island-vr-support') {
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, text: async () => '' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'King Kong VR',
    normalizedName: 'King Kong of Skull Island VR',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    searchProvider,
    fetchImpl: fetchMock,
    logger: { log: (...args) => logs.push(args) },
    traceId: 'trace-king-kong-ranking',
  });

  assert.equal(result.documentationLinks[0]?.url, 'https://rawthrills.com/wp-content/uploads/040-00078-01_King_Kong_of_Skull_Island_Manual_REV6.pdf');
  assert.ok(['official', 'broad_first', 'exact_pdf'].includes(result.documentationLinks[0]?.discoverySource));
  assert.equal(
    logs.some((entry) => entry[0] === 'manualDiscovery:candidate_preference')
    || logs.some((entry) => entry[0] === 'manualDiscovery:raw_thrills_guessed_pdf_demoted'),
    true
  );
  assert.equal(logs.some((entry) => entry[0] === 'manualDiscovery:candidate_scoring'), true);
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

  const urls = pages.map((row) => row.url);
  assert.deepEqual(urls.slice(0, 4), [
    'https://parts.baytekent.com/?s=Quik%20Drop',
    'https://baytekent.com/?s=Quik%20Drop',
    'https://www.betson.com/?s=Quik%20Drop%20Bay%20Tek',
    'https://www.betson.com/amusement-products/?s=Quik%20Drop'
  ]);
  assert.equal(urls.includes('https://parts.baytekent.com/?s=Quick%20Drop'), true);
});

test('Virtual Rabbids aliases expand official search and seed coverage to canonical Big Ride naming', () => {
  const profile = getManufacturerProfile('LAI Games', 'Virtual Rabbids');
  const queries = buildManualSearchQueries({
    manufacturer: 'LAI Games',
    title: 'Virtual Rabbids Arcade',
    manufacturerProfile: profile
  });
  const pages = buildManufacturerDiscoverySeedPages({
    title: 'Virtual Rabbids Arcade',
    manufacturerProfile: profile
  });

  assert.equal(queries.officialQueries.some((query) => /virtual rabbids.*big ride/i.test(query)), true);
  assert.equal(queries.exactTitleQueries.some((query) => /virtual rabbids arcade/i.test(query)), true);
  assert.equal(pages.some((page) => /Virtual%20Rabbids.*Big%20Ride/i.test(page.url)), true);
});

test('discoverManualDocumentation matches Virtual Rabbids canonical Big Ride manual results from alias-driven lookup', async () => {
  const profile = getManufacturerProfile('LAI Games', 'Virtual Rabbids');
  const fetchMock = async (url) => {
    if (url === 'https://laigames.com/virtual-rabbids-upgrade-kit') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<a href="/downloads/virtual-rabbids-the-big-ride-install-guide.pdf">Virtual Rabbids: The Big Ride Install Guide PDF</a>'
      };
    }
    if (url === 'https://laigames.com/downloads/virtual-rabbids-the-big-ride-install-guide.pdf') {
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    }
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'Virtual Rabbids',
    normalizedName: 'Virtual Rabbids Arcade',
    manufacturer: 'LAI Games',
    manufacturerProfile: profile,
    searchProvider: async () => [{
      title: 'Virtual Rabbids: The Big Ride Upgrade Kit',
      url: 'https://laigames.com/virtual-rabbids-upgrade-kit'
    }],
    fetchImpl: fetchMock,
    logger: { log: () => {} }
  });

  assert.equal(result.documentationLinks[0]?.url, 'https://laigames.com/downloads/virtual-rabbids-the-big-ride-install-guide.pdf');
  assert.equal(result.documentationLinks[0]?.sourceType, 'manufacturer');
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

test('extractManualLinksFromHtmlPage rejects LAI generic parts/cart/category/shop-all-parts links', async () => {
  const profile = getManufacturerProfile('LAI Games', 'HYPERshoot');
  const events = [];
  const rows = await extractManualLinksFromHtmlPage({
    pageUrl: 'https://parts.laigames.com/category/decals/',
    pageTitle: 'HYPERshoot parts',
    manufacturer: 'LAI Games',
    titleVariants: ['hypershoot'],
    manufacturerProfile: profile,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => `
        <html><body>
          <a href="https://parts.laigames.com/cart.php">Cart</a>
          <a href="https://parts.laigames.com/login.php">Sign In</a>
          <a href="https://parts.laigames.com/shop-all-parts">Shop All Parts</a>
          <a href="https://parts.laigames.com/balls/">Balls</a>
          <a href="https://parts.laigames.com/category/decals/">Decals</a>
        </body></html>
      `,
    }),
    logEvent: (event, payload) => events.push({ event, payload }),
  });
  assert.deepEqual(rows, []);
  assert.equal(events.some((entry) => entry.event === 'junk_support_page_rejected'), true);
  assert.equal(events.some((entry) => entry.event === 'commerce_navigation_link_rejected'), true);
  assert.equal(events.some((entry) => entry.event === 'lai_generic_parts_page_rejected'), true);
});


test('discoverManualDocumentation caps slow search work and degrades repeated provider failures to empty terminal results', async () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Broken Search');
  const queries = [];
  const result = await discoverManualDocumentation({
    assetName: 'Broken Search',
    normalizedName: 'Broken Search',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
    searchProvider: async (query) => {
      queries.push(query);
      throw new Error('fetch failed');
    },
    fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' }),
    logger: { log: () => {} },
    traceId: 'trace-provider-fail'
  });

  assert.ok(Array.isArray(result.documentationLinks));
  assert.equal(result.supportResources.length, 0);
  assert.equal(queries.length, 12);
  assert.equal(result.queriesTried.length, 12);
});

test('extractManualLinksFromHtmlPage returns empty rows when source fetch aborts', async () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'Quik Drop');
  const events = [];
  const error = new Error('operation aborted');
  error.name = 'AbortError';

  const rows = await extractManualLinksFromHtmlPage({
    pageUrl: 'https://parts.baytekent.com/support/quik-drop',
    pageTitle: 'Quik Drop Support',
    manufacturer: 'Bay Tek Games',
    titleVariants: ['quik drop'],
    manufacturerProfile: profile,
    fetchImpl: async () => { throw error; },
    logEvent: (event, payload) => events.push({ event, payload })
  });

  assert.deepEqual(rows, []);
  assert.equal(events.at(-1).event, 'html_followup_error');
  assert.equal(events.at(-1).payload.reason, 'timeout');
});


test('searchDuckDuckGoHtml parses classic DuckDuckGo html redirect results', async () => {
  const fetchMock = async () => ({
    ok: true,
    text: async () => `
      <html><body>
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://laigames.com/game/virtual-rabbids-the-big-ride/')}">Virtual Rabbids: The Big Ride Support</a>
      </body></html>
    `
  });

  const rows = await searchDuckDuckGoHtml('virtual rabbids', fetchMock);

  assert.deepEqual(rows, [{
    title: 'Virtual Rabbids: The Big Ride Support',
    url: 'https://laigames.com/game/virtual-rabbids-the-big-ride/'
  }]);
});

test('searchDuckDuckGoHtml falls back to lite results when html endpoint markup yields no matches', async () => {
  let calls = 0;
  const fetchMock = async (url) => {
    void url;
    calls += 1;
    return {
      ok: true,
      text: async () => calls === 1
        ? '<html><body><div class="no-results">No parser match</div></body></html>'
        : `
          <html><body>
            <a href="https://rawthrills.com/games/jurassic-park-arcade-support" class="result-link">Jurassic Park Arcade Support</a>
          </body></html>
        `
    };
  };

  const rows = await searchDuckDuckGoHtml('jurassic park arcade', fetchMock);

  assert.equal(calls, 2);
  assert.deepEqual(rows, [{
    title: 'Jurassic Park Arcade Support',
    url: 'https://rawthrills.com/games/jurassic-park-arcade-support'
  }]);
});

test('discoverManualDocumentation retries provider chain and falls back when primary provider fails', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade');
  const events = [];
  const fetchMock = async (url, options = {}) => {
    const method = `${options.method || 'GET'}`.toUpperCase();
    if (method === 'HEAD') return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    if (url.startsWith('https://www.bing.com/search?')) return { ok: false, status: 403, text: async () => '' };
    if (url.startsWith('https://duckduckgo.com/html/?q=')) {
      return {
        ok: true,
        text: async () => `<a class="result__a" href="${'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf'}">Jurassic Park Arcade Operator Manual</a>`
      };
    }
    return { ok: true, text: async () => '' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'Jurassic Park Arcade',
    normalizedName: 'Jurassic Park Arcade',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    fetchImpl: fetchMock,
    logger: { log: (...args) => events.push(args) },
    searchProviderOptions: { primarySearchProvider: 'bing_html' },
  });

  assert.equal(result.documentationLinks.some((row) => /jurassic-park-arcade-operator-manual\.pdf$/i.test(row.url)), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:search_retry' && entry[1]?.provider === 'bing_html'), true);
});

test('discoverManualDocumentation invokes provider fallback when primary provider returns all-zero results', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'King Kong of Skull Island VR');
  const events = [];
  const fetchMock = async (url, options = {}) => {
    const method = `${options.method || 'GET'}`.toUpperCase();
    if (method === 'HEAD') return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    if (url.startsWith('https://www.bing.com/search?')) return { ok: true, status: 200, text: async () => '<html></html>' };
    if (url.startsWith('https://duckduckgo.com/html/?q=')) {
      return {
        ok: true,
        text: async () => `<a class="result__a" href="${'https://rawthrills.com/wp-content/uploads/king-kong-vr-1-2-12345-rev2.pdf'}">King Kong VR Service Manual</a>`
      };
    }
    return { ok: true, status: 200, text: async () => '' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'King Kong VR',
    normalizedName: 'King Kong of Skull Island VR',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    fetchImpl: fetchMock,
    logger: { log: (...args) => events.push(args) },
    searchProviderOptions: { primarySearchProvider: 'bing_html' },
  });

  assert.equal(result.documentationLinks.some((row) => /king-kong-vr-1-2-12345-rev2\.pdf$/i.test(row.url)), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:provider_zero_results' && entry[1]?.provider === 'bing_html'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:provider_fallback_invoked'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:run_summary' && entry[1]?.fallbackInvoked === true), true);
});

test('discoverManualDocumentation performs dead-link recovery using filename mirror search', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade');
  const events = [];
  const searchCalls = [];
  const deadUrl = 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf';
  const mirrorUrl = 'https://mirror.example.com/manuals/jurassic-park-arcade-operator-manual.pdf';
  const provider = async (query) => {
    searchCalls.push(query);
    if (/jurassic park arcade/i.test(query)) {
      return [{ title: 'Jurassic Park Arcade Operator Manual', url: deadUrl }];
    }
    if (/jurassic-park-arcade-operator-manual\.pdf/i.test(query)) {
      return [{ title: 'Jurassic Park Arcade Operator Manual Mirror', url: mirrorUrl }];
    }
    return [];
  };
  const fetchMock = async (url, options = {}) => {
    const method = `${options.method || 'GET'}`.toUpperCase();
    if (method === 'HEAD' && url === deadUrl) return { ok: false, status: 404, headers: { get: () => 'application/pdf' } };
    return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, text: async () => '' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'Jurassic Park Arcade',
    normalizedName: 'Jurassic Park Arcade',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    searchProvider: provider,
    fetchImpl: fetchMock,
    logger: { log: (...args) => events.push(args) },
  });

  assert.equal(result.documentationLinks.some((row) => row.url === mirrorUrl), true);
  assert.equal(result.documentationLinks.some((row) => row.url === deadUrl), false);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:dead_link_recovery_start'), true);
  assert.equal(searchCalls.some((query) => /jurassic-park-arcade-operator-manual\.pdf/i.test(query)), true);
});

test('discoverManualDocumentation dead-link recovery skips generic basename details and query-driven app URLs', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Willy Crash');
  const searchCalls = [];
  const deadUrl = 'https://play.google.com/store/apps/details?id=com.example.willycrash';
  const provider = async (query) => {
    searchCalls.push(query);
    if (/willy crash/i.test(query)) {
      return [{ title: 'Willy Crash Play Listing', url: deadUrl }];
    }
    return [];
  };
  const fetchMock = async (url, options = {}) => {
    const method = `${options.method || 'GET'}`.toUpperCase();
    if (method === 'HEAD' && url === deadUrl) return { ok: false, status: 404, headers: { get: () => 'text/html' } };
    return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '' };
  };

  const result = await discoverManualDocumentation({
    assetName: 'Willy Crash',
    normalizedName: 'Willy Crash',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    searchProvider: provider,
    fetchImpl: fetchMock,
    logger: console,
  });

  assert.ok(Array.isArray(result.documentationLinks));
  assert.equal(searchCalls.some((query) => /"details"/i.test(query)), false);
  assert.equal(searchCalls.some((query) => /id=com\.example\.willycrash/i.test(query)), false);
  assert.equal(searchCalls.some((query) => /filetype:pdf "Willy Crash"/i.test(query)), false);
});

test('buildManufacturerDiscoveryAdapters generates title-specific Raw Thrills and LAI candidate paths', () => {
  const raw = buildManufacturerDiscoveryAdapters({
    title: 'King Kong VR',
    titleVariants: ['King Kong VR', 'King Kong of Skull Island VR'],
    manufacturerProfile: getManufacturerProfile('Raw Thrills', 'King Kong VR'),
  });
  const lai = buildManufacturerDiscoveryAdapters({
    title: 'HYPERshoot',
    titleVariants: ['HYPERshoot', 'Hyper Shoot'],
    manufacturerProfile: getManufacturerProfile('LAI Games', 'HYPERshoot'),
  });
  assert.equal(raw.some((entry) => /rawthrills\.com\/games\/king-kong-of-skull-island-vr/.test(entry.url)), true);
  assert.equal(raw.some((entry) => /operator-manual\.pdf/.test(entry.url)), true);
  assert.equal(lai.some((entry) => /laigames\.com\/games\/hypershoot\/support/.test(entry.url)), true);
  assert.equal(lai.some((entry) => /parts\.laigames\.com\/product\/hyper-shoot/.test(entry.url)), true);
});

test('buildManufacturerDiscoveryAdapters expands Raw Thrills Jurassic Park family variants and title paths', () => {
  const raw = buildManufacturerDiscoveryAdapters({
    title: 'Jurassic Park Arcade',
    titleVariants: ['Jurassic Park Arcade'],
    manufacturerProfile: getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade'),
  });
  const urls = raw.map((entry) => entry.url);
  assert.equal(urls.some((url) => /rawthrills\.com\/games\/jurassic-park\/$/.test(url)), true);
  assert.equal(urls.some((url) => /rawthrills\.com\/games\/jurassic-park-arcade\/downloads\/$/.test(url)), true);
  assert.equal(urls.some((url) => /rawthrills\.com\/games\/jurassic-park-vr-support\/$/.test(url)), true);
  assert.equal(urls.some((url) => /rawthrills\.com\/wp-content\/uploads\/jurassic-park-manual\.pdf/.test(url)), true);
});

test('discoverManualDocumentation logs promoted probe extraction and Raw Thrills title-page manual links', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade');
  const events = [];
  const result = await discoverManualDocumentation({
    assetName: 'Jurassic Park Arcade',
    normalizedName: 'Jurassic Park Arcade',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    searchProvider: async () => ([
      { title: 'Jurassic Park Arcade Product', url: 'https://rawthrills.com/games/jurassic-park-arcade/' },
    ]),
    fetchImpl: async (url, options = {}) => {
      if ((options.method || 'GET').toUpperCase() === 'HEAD') return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
      if (url === 'https://rawthrills.com/games/jurassic-park-arcade/' || url === 'https://rawthrills.com/games/jurassic-park-arcade') {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'text/html' },
          text: async () => '<a href="/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf">Operator Manual</a>'
        };
      }
      if (url.endsWith('/jurassic-park-arcade-operator-manual.pdf')) return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    },
    logger: { log: (...args) => events.push(args) },
  });
  assert.equal(result.documentationLinks.some((row) => /jurassic-park-arcade-operator-manual\.pdf$/.test(row.url)), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:candidate_probe_extracted_manual_link'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:raw_thrills_link_extracted_from_title_page'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:raw_thrills_title_page_candidate_generated'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:raw_thrills_title_page_validated'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:raw_thrills_manual_link_extracted'), true);
});

test('discoverManualDocumentation demotes Raw Thrills guessed PDFs behind title-page extraction for Jurassic Park', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade');
  const events = [];
  const result = await discoverManualDocumentation({
    assetName: 'Jurassic Park Arcade',
    normalizedName: 'Jurassic Park Arcade',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    searchProvider: async () => [],
    fetchImpl: async (url, options = {}) => {
      const method = (options?.method || 'GET').toUpperCase();
      if (method === 'HEAD') {
        if (/jurassic-park-arcade-operator-manual\.pdf$/.test(url)) return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
        if (/\/wp-content\/uploads\/jurassic-park-.*-manual\.pdf$/i.test(url)) return { ok: false, status: 404, headers: { get: () => 'application/pdf' } };
      }
      if (/rawthrills\.com\/games\/jurassic-park-arcade\/?$/.test(url)) {
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<a href="/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf">Manual</a>' };
      }
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    },
    logger: { log: (...args) => events.push(args) },
  });
  if (result.documentationLinks.length) {
    assert.equal(result.documentationLinks[0]?.url.includes('/wp-content/uploads/jurassic-park-manual.pdf'), false);
  }
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:raw_thrills_guessed_pdf_demoted'), true);
});

test('discoverManualDocumentation prioritizes LAI title pages before generic search pages and extracts manual evidence', async () => {
  const profile = getManufacturerProfile('LAI Games', 'HYPERshoot');
  const events = [];
  const result = await discoverManualDocumentation({
    assetName: 'HYPERshoot',
    normalizedName: 'HYPERshoot',
    manufacturer: 'LAI Games',
    manufacturerProfile: profile,
    searchProvider: async () => [],
    fetchImpl: async (url, options = {}) => {
      const method = (options?.method || 'GET').toUpperCase();
      if (method === 'HEAD' && /hypershoot-operator-manual\.pdf$/i.test(url)) return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
      if (/laigames\.com\/games\/hypershoot\/?$/.test(url)) {
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<a href="/downloads/hypershoot-operator-manual.pdf">Operator manual</a>' };
      }
      if (/laigames\.com\/support\/\?s=/.test(url) || /parts\.laigames\.com\/\?s=/.test(url)) {
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<a href="/support">Search hub</a>' };
      }
      if (/laigames\.com\/downloads\/hypershoot-operator-manual\.pdf$/.test(url)) {
        return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, text: async () => '' };
      }
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    },
    logger: { log: (...args) => events.push(args) },
  });
  assert.equal(result.documentationLinks.some((row) => /hypershoot-operator-manual\.pdf$/i.test(row.url)), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:lai_title_page_candidate_generated'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:lai_title_page_validated'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:lai_manual_link_extracted'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:lai_generic_search_page_demoted'), true);
});

test('discoverManualDocumentation records title_page_found_manual_probe_failed for close exact-title support hits', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade');
  const result = await discoverManualDocumentation({
    assetName: 'Jurassic Park Arcade',
    normalizedName: 'Jurassic Park Arcade',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    searchProvider: async () => ([
      { title: 'Jurassic Park Arcade Support', url: 'https://rawthrills.com/games/jurassic-park-arcade-support/' },
    ]),
    fetchImpl: async (url) => {
      if (url === 'https://rawthrills.com/games/jurassic-park-arcade-support/' || url === 'https://rawthrills.com/games/jurassic-park-arcade-support') {
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<a href="/support">Support Hub</a>' };
      }
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    },
    logger: { log: () => {} },
  });
  assert.equal(result.documentationLinks.length, 0);
  assert.equal(result.diagnostics.terminalReason, 'title_page_found_manual_probe_failed');
});

test('discoverManualDocumentation reports guessed-pdf-404-no-better-candidate when only guessed PDFs fail', async () => {
  const profile = getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade');
  const result = await discoverManualDocumentation({
    assetName: 'Jurassic Park Arcade',
    normalizedName: 'Jurassic Park Arcade',
    manufacturer: 'Raw Thrills',
    manufacturerProfile: profile,
    searchProvider: async () => [],
    fetchImpl: async (url, options = {}) => {
      const method = (options?.method || 'GET').toUpperCase();
      if (method === 'HEAD' && /wp-content\/uploads\/.*manual\.pdf$/i.test(url)) return { ok: false, status: 404, headers: { get: () => 'application/pdf' } };
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    },
    logger: { log: () => {} },
  });
  assert.equal(result.documentationLinks.length, 0);
  assert.equal(result.diagnostics.terminalReason, 'guessed-pdf-404-no-better-candidate');
});

test('discoverManualDocumentation reports generic-search-page-only when only generic support pages are found', async () => {
  const profile = getManufacturerProfile('LAI Games', 'Virtual Rabbids');
  const result = await discoverManualDocumentation({
    assetName: 'Virtual Rabbids',
    normalizedName: 'Virtual Rabbids',
    manufacturer: 'LAI Games',
    manufacturerProfile: profile,
    searchProvider: async () => ([{ title: 'LAI support', url: 'https://laigames.com/support/' }]),
    fetchImpl: async (url) => {
      if (url === 'https://laigames.com/support/' || url === 'https://laigames.com/support') {
        return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<a href="/support/">Support</a>' };
      }
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '<html></html>' };
    },
    logger: { log: () => {} },
  });
  assert.equal(result.documentationLinks.length, 0);
  assert.equal(['generic-search-page-only', 'deterministic-search-no-results'].includes(result.diagnostics.terminalReason), true);
});

test('buildDeterministicSearchPlan creates richer manufacturer-aware variants for skeeball modern', () => {
  const profile = getManufacturerProfile('Bay Tek Games', 'skeeball modern');
  const plan = buildDeterministicSearchPlan({
    assetName: 'skeeball modern',
    normalizedName: 'skeeball modern',
    manufacturer: 'Bay Tek Games',
    manufacturerProfile: profile,
  });
  const variants = plan.titleVariants.map((v) => v.toLowerCase());
  assert.equal(variants.includes('skeeball modern'), true);
  assert.equal(variants.length > 2, true);
  assert.equal(variants.includes('skeeballmodern'), true);
  assert.equal(variants.some((v) => v.includes('bay tek')), true);
});

test('reference hints expand title variants for difficult known titles', () => {
  const cases = [
    ['Jurassic Park Arcade', 'Raw Thrills', ['Jurassic Park']],
    ['King Kong VR', 'Raw Thrills', ['King Kong of Skull Island VR']],
    ['HYPERshoot', 'LAI Games', ['Hyper Shoot']],
    ['Virtual Rabbids', 'LAI Games', ['Virtual Rabbids: The Big Ride']],
    ['Sink It', 'Bay Tek Games', ['Sink It Shootout']],
    ['Wizard of Oz', 'Elaut', ['Wizard of Oz Coin Pusher']],
  ];

  cases.forEach(([title, manufacturer, aliases]) => {
    const plan = buildDeterministicSearchPlan({
      assetName: title,
      normalizedName: title,
      manufacturer,
      manufacturerProfile: getManufacturerProfile(manufacturer, title),
      referenceHints: {
        canonicalTitleHints: [title],
        aliases,
        familyTitles: aliases,
        preferredManufacturerDomains: ['example.com'],
        likelyManualFilenamePatterns: [`${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-manual.pdf`],
      },
    });
    assert.equal(plan.titleVariants.some((variant) => aliases.some((alias) => variant.toLowerCase().includes(alias.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')[0]))), true);
    assert.equal(plan.searchHints.some((hint) => hint.includes('site:example.com')), true);
  });
});

test('reference hints add adapter probe paths without auto-validating manuals', () => {
  const adapters = buildManufacturerDiscoveryAdapters({
    title: 'King Kong VR',
    titleVariants: ['King Kong VR'],
    manufacturerProfile: getManufacturerProfile('Raw Thrills', 'King Kong VR'),
    referenceHints: {
      preferredManufacturerDomains: ['rawthrills.com'],
      likelySlugPatterns: ['king-kong-of-skull-island-vr'],
    },
  });
  assert.equal(adapters.some((entry) => entry.adapter === 'reference_hint' && /rawthrills\.com\/king-kong-of-skull-island-vr\//.test(entry.url)), true);
  assert.equal(adapters.some((entry) => entry.adapter === 'reference_hint' && /rawthrills\.com\/wp-content\/uploads\/king-kong-of-skull-island-vr-manual\.pdf/.test(entry.url)), true);
});

test('discoverManualDocumentation treats provider 403 as nonterminal and still validates adapter/manual hits', async () => {
  const profile = getManufacturerProfile('LAI Games', 'HYPERshoot');
  const events = [];
  const result = await discoverManualDocumentation({
    assetName: 'HYPERshoot',
    normalizedName: 'HYPERshoot',
    manufacturer: 'LAI Games',
    manufacturerProfile: profile,
    fetchImpl: async (url, options = {}) => {
      if ((options.method || 'GET').toUpperCase() === 'HEAD') return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, text: async () => '' };
    },
    searchProvider: async () => { throw new Error('Search request failed with status 403'); },
    logger: { log: (...args) => events.push(args) },
  });
  assert.equal(result.documentationLinks.length > 0, true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:provider_blocked_or_forbidden'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:provider_failure_nonterminal'), false);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:manufacturer_adapter_started'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:adapter_recovery_after_provider_failure'), true);
});

test('buildManufacturerDiscoveryAdapters generates reference-first paths for Jurassic Park (Raw Thrills) and HYPERshoot (LAI)', () => {
  const logs = [];
  const raw = buildManufacturerDiscoveryAdapters({
    title: 'Jurassic Park Arcade',
    titleVariants: ['Jurassic Park Arcade'],
    manufacturerProfile: getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade'),
    referenceHints: {
      preferredManufacturerDomains: ['rawthrills.com'],
      likelySlugPatterns: ['jurassic-park-arcade'],
    },
    logEvent: (event, payload) => logs.push([event, payload]),
  });
  const lai = buildManufacturerDiscoveryAdapters({
    title: 'HYPERshoot',
    titleVariants: ['HYPERshoot'],
    manufacturerProfile: getManufacturerProfile('LAI Games', 'HYPERshoot'),
    referenceHints: {
      preferredManufacturerDomains: ['laigames.com'],
      likelySlugPatterns: ['hypershoot'],
    },
    logEvent: (event, payload) => logs.push([event, payload]),
  });

  assert.equal(raw.some((entry) => entry.adapter === 'raw_thrills_reference'), true);
  assert.equal(lai.some((entry) => entry.adapter === 'lai_games_reference' && /laigames\.com\/games\/hypershoot\/support\//.test(entry.url)), true);
  assert.equal(logs.some((entry) => entry[0] === 'raw_thrills_reference_path_generated'), true);
  assert.equal(logs.some((entry) => entry[0] === 'lai_reference_path_generated'), true);
});

test('buildManufacturerDiscoveryAdapters prioritizes reference row URLs before guessed manufacturer paths', () => {
  const raw = buildManufacturerDiscoveryAdapters({
    title: 'Jurassic Park Arcade',
    titleVariants: ['Jurassic Park Arcade'],
    manufacturerProfile: getManufacturerProfile('Raw Thrills', 'Jurassic Park Arcade'),
    referenceHints: {
      referenceRowCandidates: [{
        sourceRowId: 'jp-row-1',
        manufacturer: 'Raw Thrills',
        normalizedTitle: 'Jurassic Park Arcade',
        manualUrl: 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual-r09.pdf',
        manualSourceUrl: 'https://rawthrills.com/games/jurassic-park-arcade/',
        supportUrl: 'https://rawthrills.com/games/jurassic-park-arcade-support/',
      }],
      preferredManufacturerDomains: ['rawthrills.com'],
      likelySlugPatterns: ['jurassic-park-arcade'],
    },
  });
  assert.equal(raw[0].url, 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual-r09.pdf');
  assert.equal(raw[0].adapter, 'reference_row');
  assert.equal(raw.some((entry) => entry.adapter === 'raw_thrills' && entry.type === 'direct_pdf'), true);
});

test('buildManufacturerDiscoveryAdapters keeps manufacturer-first reference row filtering (Wizard of Oz / Elaut)', () => {
  const elaut = buildManufacturerDiscoveryAdapters({
    title: 'Wizard of Oz',
    titleVariants: ['Wizard of Oz'],
    manufacturerProfile: getManufacturerProfile('Elaut', 'Wizard of Oz'),
    referenceHints: {
      referenceRowCandidates: [{
        sourceRowId: 'raw-jp-row',
        manufacturer: 'Raw Thrills',
        normalizedTitle: 'Jurassic Park Arcade',
        manualUrl: 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-manual.pdf',
      }, {
        sourceRowId: 'elaut-woz-row',
        manufacturer: 'Elaut',
        normalizedTitle: 'Wizard of Oz',
        manualSourceUrl: 'https://www.elaut.com/product/wizard-of-oz/',
      }],
    },
  });
  assert.equal(elaut.some((entry) => entry.adapter === 'reference_row' && /rawthrills\.com/i.test(entry.url)), false);
  assert.equal(elaut.some((entry) => entry.adapter === 'reference_row' && /elaut\.com\/product\/wizard-of-oz/i.test(entry.url)), true);
});

test('discoverManualDocumentation probes reference row candidates first for HYPERshoot/Virtual Rabbids style manufacturer matches', async () => {
  const profile = getManufacturerProfile('LAI Games', 'HYPERshoot');
  const events = [];
  const result = await discoverManualDocumentation({
    assetName: 'HYPERshoot',
    normalizedName: 'HYPERshoot',
    manufacturer: 'LAI Games',
    manufacturerProfile: profile,
    referenceHints: {
      referenceRowCandidates: [{
        sourceRowId: 'lai-hs-row',
        manufacturer: 'LAI Games',
        normalizedTitle: 'HYPERshoot',
        manualUrl: 'https://laigames.com/wp-content/uploads/hypershoot-operator-manual.pdf',
        manualSourceUrl: 'https://laigames.com/games/hypershoot/',
        supportUrl: 'https://laigames.com/games/hypershoot/support/',
      }],
    },
    searchProvider: async () => [],
    fetchImpl: async (_url, options = {}) => {
      if ((options.method || 'GET').toUpperCase() === 'HEAD') return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, text: async () => '' };
    },
    logger: { log: (...args) => events.push(args) },
  });
  assert.equal(result.documentationLinks.some((row) => /hypershoot-operator-manual\.pdf$/i.test(row.url)), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:reference_row_candidate_generated'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:reference_row_manual_url_probed'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:reference_row_candidate_validated'), true);

  const rabbits = await discoverManualDocumentation({
    assetName: 'Virtual Rabbids',
    normalizedName: 'Virtual Rabbids',
    manufacturer: 'LAI Games',
    manufacturerProfile: getManufacturerProfile('LAI Games', 'Virtual Rabbids'),
    referenceHints: {
      referenceRowCandidates: [{
        sourceRowId: 'lai-rabbids-row',
        manufacturer: 'LAI Games',
        normalizedTitle: 'Virtual Rabbids: The Big Ride',
        manualUrl: 'https://www.betson.com/wp-content/uploads/2020/01/VirtualRabbidsTheBigRideManual16.pdf',
        manualSourceUrl: 'https://www.betson.com/amusement-products/virtual-rabbids-the-big-ride/',
        supportUrl: 'https://www.betson.com/amusement-products/virtual-rabbids-the-big-ride/',
      }],
    },
    searchProvider: async () => [],
    fetchImpl: async (_url, options = {}) => {
      if ((options.method || 'GET').toUpperCase() === 'HEAD') return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
      return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, text: async () => '' };
    },
    logger: { log: () => {} },
  });
  assert.equal(rabbits.documentationLinks.some((row) => /virtualrabbidsthebigridemanual16\.pdf$/i.test(row.url)), true);
});

test('discoverManualDocumentation probes reference rows first for Jurassic Park and King Kong Raw Thrills entries', async () => {
  const events = [];
  const fetchImpl = async (_url, options = {}) => {
    if ((options.method || 'GET').toUpperCase() === 'HEAD') return { ok: true, status: 200, headers: { get: () => 'application/pdf' } };
    return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, text: async () => '' };
  };
  const searchProvider = async () => [{ title: 'generic fallback result', url: 'https://example.com/search-result' }];

  const jurassic = await discoverManualDocumentation({
    assetName: 'Jurassic Park',
    normalizedName: 'Jurassic Park',
    manufacturer: 'Raw Thrills Inc.',
    manufacturerProfile: getManufacturerProfile('Raw Thrills', 'Jurassic Park'),
    referenceHints: {
      entryKey: 'raw thrills::jurassic park arcade',
      referenceRowCandidates: [{
        sourceRowId: 'jp-row',
        manufacturer: 'Raw Thrills',
        normalizedTitle: 'Jurassic Park Arcade',
        manualUrl: 'https://rawthrills.com/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf',
        manualSourceUrl: 'https://rawthrills.com/games/jurassic-park-arcade/',
        supportUrl: 'https://rawthrills.com/games/jurassic-park-arcade-support/',
      }],
    },
    searchProvider,
    fetchImpl,
    logger: { log: (...args) => events.push(args) },
  });
  const kingKong = await discoverManualDocumentation({
    assetName: 'King Kong',
    normalizedName: 'King Kong',
    manufacturer: 'RawThrills',
    manufacturerProfile: getManufacturerProfile('Raw Thrills', 'King Kong'),
    referenceHints: {
      entryKey: 'raw thrills::king kong of skull island vr',
      referenceRowCandidates: [{
        sourceRowId: 'kk-row',
        manufacturer: 'Raw Thrills',
        normalizedTitle: 'King Kong of Skull Island VR',
        manualUrl: 'https://rawthrills.com/wp-content/uploads/king-kong-of-skull-island-vr-operator-manual.pdf',
      }],
    },
    searchProvider,
    fetchImpl,
    logger: { log: (...args) => events.push(args) },
  });

  assert.equal(jurassic.documentationLinks.some((row) => /jurassic-park-arcade-operator-manual\.pdf$/i.test(row.url)), true);
  assert.equal(kingKong.documentationLinks.some((row) => /king-kong-of-skull-island-vr-operator-manual\.pdf$/i.test(row.url)), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:reference_row_match_expanded'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:reference_row_manual_url_probed'), true);
  assert.equal(events.some((entry) => entry[0] === 'manualDiscovery:reference_row_candidate_generated'), true);
});
