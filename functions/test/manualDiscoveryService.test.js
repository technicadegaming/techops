const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildManualSearchQueries,
  buildManufacturerDiscoveryAdapters,
  classifyManualCandidate,
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
  assert.match(queries.fallbackQueries[0], /"Bay Tek Games" "Quik Drop" "service manual" pdf/);
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
  assert.equal(result.supportResources.some((row) => row.url === 'https://baytekent.com/support'), true);
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
