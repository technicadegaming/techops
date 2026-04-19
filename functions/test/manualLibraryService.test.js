const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUrl,
  createManualLibraryId,
  writeManualLibraryRecord,
  findApprovedManualLibraryRecord
} = require('../src/services/manualLibraryService');

test('normalizeUrl strips fragments for manual-library dedupe', () => {
  assert.equal(normalizeUrl('https://example.com/manual.pdf#page=1'), 'https://example.com/manual.pdf');
});

test('createManualLibraryId remains stable for same manual inputs', () => {
  const a = createManualLibraryId({ normalizedManufacturer: 'raw thrills', canonicalTitle: 'Fast & Furious Arcade', variant: '2 player', sha256: 'abc' });
  const b = createManualLibraryId({ normalizedManufacturer: 'raw thrills', canonicalTitle: 'Fast & Furious Arcade', variant: '2 player', sha256: 'abc' });
  assert.equal(a, b);
});

test('writeManualLibraryRecord persists normalized lookup keys for global manual reuse', async () => {
  const state = {};
  const db = {
    collection() {
      return {
        doc(id) {
          return {
            async set(payload) {
              state[id] = payload;
            }
          };
        }
      };
    }
  };
  await writeManualLibraryRecord({
    db,
    manualLibraryId: 'manual-1',
    record: {
      canonicalTitle: 'King Kong of Skull Island VR',
      familyTitle: 'King Kong VR',
      manufacturer: 'Raw Thrills',
      alternateTitleKeys: ['King Kong VR', 'King Kong'],
    }
  });
  assert.equal(state['manual-1'].canonicalTitleNormalized, 'king kong of skull island vr');
  assert.equal(state['manual-1'].familyTitleNormalized, 'king kong vr');
  assert.ok(Array.isArray(state['manual-1'].aliasKeys));
  assert.ok(state['manual-1'].aliasKeys.includes('king kong vr'));
});

test('findApprovedManualLibraryRecord reuses approved manual via normalized aliases', async () => {
  const rows = {
    'manual-approved': {
      canonicalTitle: 'King Kong of Skull Island VR',
      canonicalTitleNormalized: 'king kong of skull island vr',
      familyTitle: 'King Kong VR',
      familyTitleNormalized: 'king kong vr',
      manufacturer: 'Raw Thrills',
      normalizedManufacturer: 'raw thrills',
      aliasKeys: ['king kong vr', 'king kong'],
      approved: true,
      approvalState: 'approved'
    }
  };
  const db = {
    collection() {
      return {
        where(field, op, value) {
          this._filters = [...(this._filters || []), [field, value]];
          return this;
        },
        limit() { return this; },
        async get() {
          const docs = Object.entries(rows)
            .filter(([, row]) => (this._filters || []).every(([field, value]) => row[field] === value))
            .map(([id, row]) => ({ id, data: () => row }));
          return { docs };
        }
      };
    }
  };
  const hit = await findApprovedManualLibraryRecord({
    db,
    canonicalTitle: 'King Kong VR',
    familyTitle: 'King Kong',
    manufacturer: 'Raw Thrills',
    alternateTitles: ['King Kong of Skull Island VR']
  });
  assert.equal(hit?.id, 'manual-approved');
});
