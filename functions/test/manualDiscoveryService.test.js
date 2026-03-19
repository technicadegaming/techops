const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildManualSearchQueries,
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

test('classifyManualCandidate rejects generic support hubs but keeps title-specific manual pdf links', () => {
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
  assert.equal(exactManual.includeManual, true);
});

test('extractManualLinksFromHtmlPage pulls direct manual links from title-specific support pages', async () => {
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
    fetchImpl: fetchMock
  });

  assert.deepEqual(rows.map((row) => row.url), ['https://parts.baytekent.com/downloads/quik-drop-service-manual.pdf']);
});

test('discoverManualDocumentation finds exact manual-only results for Bay Tek titles and keeps generic support out of manual results', async () => {
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
    fetchImpl: async () => { throw new Error('should not fetch html follow-up'); }
  });

  assert.deepEqual(result.documentationLinks.map((row) => row.url), ['https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf']);
  assert.equal(result.supportResources.some((row) => row.url === 'https://baytekent.com/support'), true);
});

test('discoverManualDocumentation regression coverage for Bay Tek, ICE, and Raw Thrills titles', async () => {
  const fixtures = {
    'site:parts.baytekent.com "Quik Drop"': [
      { title: 'Quik Drop Service Manual PDF', url: 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf' }
    ],
    'site:parts.baytekent.com "Sink It"': [
      { title: 'Sink It Support', url: 'https://baytekent.com/support/sink-it' }
    ],
    'site:parts.baytekent.com "Skee-Ball Modern"': [
      { title: 'Skee-Ball Modern Operator Manual', url: 'https://parts.baytekent.com/manuals/skee-ball-modern-operator-manual.pdf' }
    ],
    'site:support.icegame.com "Air FX"': [
      { title: 'Air FX Service Manual PDF', url: 'https://support.icegame.com/manuals/air-fx-service-manual.pdf' }
    ],
    'site:rawthrills.com "Jurassic Park Arcade"': [
      { title: 'Raw Thrills Support', url: 'https://rawthrills.com/support' },
      { title: 'Jurassic Park Arcade Support', url: 'https://rawthrills.com/games/jurassic-park-arcade-support' }
    ]
  };

  const searchProvider = async (query) => {
    const matchedKey = Object.keys(fixtures).find((key) => query.includes(key));
    return matchedKey ? fixtures[matchedKey] : [];
  };

  const fetchMock = async (url) => ({
    ok: true,
    headers: { get: () => 'text/html' },
    text: async () => {
      if (url.includes('sink-it')) return '<a href="/manuals/sink-it-operator-manual.pdf">Sink It Operator Manual</a>';
      if (url.includes('jurassic-park-arcade-support')) return '<a href="/wp-content/uploads/jurassic-park-arcade-operator-manual.pdf">Jurassic Park Arcade Operator Manual</a>';
      return '<html></html>';
    }
  });

  const cases = [
    {
      assetName: 'Quik Drop',
      manufacturer: 'Bay Tek Games',
      expected: 'https://parts.baytekent.com/manuals/quik-drop-service-manual.pdf'
    },
    {
      assetName: 'Sink It',
      manufacturer: 'Bay Tek Games',
      expected: 'https://baytekent.com/manuals/sink-it-operator-manual.pdf'
    },
    {
      assetName: 'Skee-Ball Modern',
      manufacturer: 'Bay Tek Games',
      expected: 'https://parts.baytekent.com/manuals/skee-ball-modern-operator-manual.pdf'
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
      fetchImpl: fetchMock
    });
    assert.equal(result.documentationLinks[0]?.url, entry.expected);
    assert.ok(result.documentationLinks.every((row) => !/\/support\/?$|\/products\/?$/.test(new URL(row.url).pathname)));
  }
});
