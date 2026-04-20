const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTrustedCatalogRow,
  findTrustedCatalogManualMatch,
  importTrustedCatalogRows,
} = require('../src/services/trustedManualCatalogService');

function createDoc(data = {}, id = 'doc-1') {
  return { id, data: () => data };
}

function createDb(seed = {}) {
  const state = {
    trustedManualCatalog: seed.trustedManualCatalog || {},
  };
  return {
    state,
    collection(name) {
      if (name !== 'trustedManualCatalog') throw new Error(`Unexpected collection ${name}`);
      return {
        where(field, op, value) {
          this._filters = [...(this._filters || []), [field, op, value]];
          return this;
        },
        limit() { return this; },
        async get() {
          const docs = Object.entries(state.trustedManualCatalog)
            .filter(([, row]) => (this._filters || []).every(([field, op, value]) => {
              const fieldValue = row[field];
              if (op === 'array-contains') return Array.isArray(fieldValue) && fieldValue.includes(value);
              return fieldValue === value;
            }))
            .map(([id, row]) => createDoc(row, id));
          return { docs };
        },
        doc(id) {
          return {
            async set(payload, options = {}) {
              state.trustedManualCatalog[id] = options.merge ? { ...(state.trustedManualCatalog[id] || {}), ...payload } : payload;
            }
          };
        }
      };
    }
  };
}

test('normalizeTrustedCatalogRow creates imported_csv trusted row + lookup keys', () => {
  const row = normalizeTrustedCatalogRow({
    assetId: 'jurassic-park-arcade-01',
    'asset name': 'Jurassic Park Arcade (2-Player)',
    manufacturer: 'Raw Thrills',
    originalTitle: '2 PERSON JURASSIC PARK',
    normalizedTitle: 'Jurassic Park Arcade',
    normalizedName: 'Jurassic Park Arcade',
    alternateNames: 'Jurassic Park',
    manualUrl: 'https://rawthrills.com/wp-content/uploads/2020/01/JP-Manual-r09.pdf',
    manualReady: 'True',
    reviewRequired: 'False',
    matchConfidence: '0.98',
  }, 'fixtures/import.csv');

  assert.equal(row.source, 'imported_csv');
  assert.equal(row.trustedCatalog, true);
  assert.equal(row.normalizedTitleKey, 'jurassic park arcade');
  assert.equal(row.normalizedManufacturerKey, 'raw thrills');
  assert.equal(row.aliasKeys.includes('jurassic park'), true);
});

test('findTrustedCatalogManualMatch prefers high-confidence manual-ready rows', async () => {
  const db = createDb({
    trustedManualCatalog: {
      'jurassic-park-arcade-01': normalizeTrustedCatalogRow({
        assetId: 'jurassic-park-arcade-01',
        'asset name': 'Jurassic Park Arcade (2-Player)',
        manufacturer: 'Raw Thrills',
        originalTitle: '2 PERSON JURASSIC PARK',
        normalizedTitle: 'Jurassic Park Arcade',
        normalizedName: 'Jurassic Park Arcade',
        alternateNames: 'Jurassic Park',
        manualUrl: 'https://rawthrills.com/wp-content/uploads/2020/01/JP-Manual-r09.pdf',
        manualReady: true,
        reviewRequired: false,
        matchConfidence: 0.98,
      }),
    },
  });

  const match = await findTrustedCatalogManualMatch({
    db,
    assetName: 'Jurassic Park Arcade',
    normalizedName: 'Jurassic Park Arcade',
    manufacturer: 'Raw Thrills',
    alternateNames: ['Jurassic Park'],
  });

  assert.ok(match);
  assert.equal(match.highConfidenceSelected, true);
  assert.equal(match.row.manualUrl, 'https://rawthrills.com/wp-content/uploads/2020/01/JP-Manual-r09.pdf');
});

test('importTrustedCatalogRows reports import counts', async () => {
  const db = createDb();
  const stats = await importTrustedCatalogRows({
    db,
    sourceFile: '/tmp/catalog.csv',
    rows: [
      {
        assetId: 'king-kong-of-skull-island-vr-01',
        'asset name': 'King Kong of Skull Island VR (2-Player)',
        manufacturer: 'Raw Thrills',
        normalizedTitle: 'King Kong of Skull Island VR',
        manualUrl: 'https://rawthrills.com/wp-content/uploads/2021/03/040-00078-01_King_Kong_of_Skull_Island_Manual_REV6.pdf',
        manualReady: true,
        reviewRequired: false,
        matchConfidence: 0.97,
      },
      {
        assetId: 'duck-derby-01',
        'asset name': 'Duck Derby',
        manufacturer: 'Adrenaline Amusements',
        normalizedTitle: 'Duck Derby',
        manualUrl: '',
        manualReady: false,
        reviewRequired: true,
        matchConfidence: 0.78,
      },
    ],
  });

  assert.equal(stats.rowsProcessed, 2);
  assert.equal(stats.rowsImported, 2);
  assert.equal(stats.rowsMissingManualUrl, 1);
  assert.equal(stats.rowsTrustedManualReady, 1);
  assert.equal(Object.keys(db.state.trustedManualCatalog).length, 2);
});
