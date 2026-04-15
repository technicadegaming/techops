const test = require('node:test');
const assert = require('node:assert/strict');

const { acquireManualToLibrary, downloadManualCandidate } = require('../src/services/manualAcquisitionService');
const { buildManualLibraryStoragePath } = require('../src/services/manualLibraryService');

function createDb(seed = {}) {
  const state = {
    manualLibrary: seed.manualLibrary || {},
  };
  return {
    state,
    collection(name) {
      if (name !== 'manualLibrary') throw new Error(`Unexpected collection ${name}`);
      return {
        where(field, op, value) {
          this._filters = [...(this._filters || []), [field, value]];
          return this;
        },
        limit() { return this; },
        async get() {
          const docs = Object.entries(state.manualLibrary)
            .filter(([, row]) => (this._filters || []).every(([field, value]) => row[field] === value))
            .map(([id, row]) => ({ id, data: () => row }));
          return { empty: docs.length === 0, docs };
        },
        doc(id) {
          return {
            async set(payload, options = {}) {
              state.manualLibrary[id] = options.merge ? { ...(state.manualLibrary[id] || {}), ...payload } : payload;
            }
          };
        }
      };
    }
  };
}

function createStorage(saves = []) {
  return {
    bucket() {
      return {
        file(path) {
          return {
            async save(buffer, options) {
              saves.push({ path, buffer: Buffer.from(buffer), options });
            }
          };
        }
      };
    }
  };
}

test('direct PDF manual acquisition stores file once and writes manualLibrary record', async () => {
  const db = createDb();
  const saves = [];
  const result = await acquireManualToLibrary({
    db,
    storage: createStorage(saves),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://example.com/files/manual.pdf',
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => Buffer.from('%PDF-1.4\nmanual')
    }),
    candidate: { url: 'https://example.com/files/manual.pdf' },
    context: { originalTitle: 'Quik Drop', canonicalTitle: 'Quik Drop', manufacturer: 'Bay Tek Games', familyTitle: 'Quik Drop' }
  });

  assert.equal(result.manualReady, true);
  assert.equal(saves.length, 1);
  const [id, row] = Object.entries(db.state.manualLibrary)[0];
  assert.ok(id);
  assert.equal(row.canonicalTitle, 'Quik Drop');
  assert.match(row.storagePath, /^manual-library\/bay-tek-games\/quik-drop\//);
});

test('repeated acquisition of same manual reuses existing library record via URL or hash dedupe', async () => {
  const db = createDb();
  const saves = [];
  const storage = createStorage(saves);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: 'https://example.com/files/manual.pdf',
    headers: { get: () => 'application/pdf' },
    arrayBuffer: async () => Buffer.from('%PDF-1.4\nmanual')
  });
  const first = await acquireManualToLibrary({ db, storage, fetchImpl, candidate: { url: 'https://example.com/files/manual.pdf' }, context: { originalTitle: 'Quik Drop', canonicalTitle: 'Quik Drop', manufacturer: 'Bay Tek Games', familyTitle: 'Quik Drop' } });
  const second = await acquireManualToLibrary({ db, storage, fetchImpl, candidate: { url: 'https://example.com/files/manual.pdf' }, context: { originalTitle: 'Quik Drop', canonicalTitle: 'Quik Drop', manufacturer: 'Bay Tek Games', familyTitle: 'Quik Drop' } });
  assert.equal(first.manualLibrary.id, second.manualLibrary.id);
  assert.equal(saves.length, 1);
});

test('title-specific source page with real download link materializes into stored manual', async () => {
  const db = createDb();
  const saves = [];
  const result = await acquireManualToLibrary({
    db,
    storage: createStorage(saves),
    fetchImpl: async (url) => {
      if (url === 'https://rawthrills.com/games/fast-furious-arcade/') {
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => 'text/html' },
          text: async () => '<a href="/wp-content/uploads/fast-furious-operator-manual.pdf">Operator Manual PDF</a>'
        };
      }
      return {
        ok: true,
        status: 200,
        url: 'https://rawthrills.com/wp-content/uploads/fast-furious-operator-manual.pdf',
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => Buffer.from('%PDF-1.4\nfast furious')
      };
    },
    candidate: { sourcePageUrl: 'https://rawthrills.com/games/fast-furious-arcade/' },
    context: { originalTitle: 'Fast & Furious', canonicalTitle: 'Fast & Furious Arcade', manufacturer: 'Raw Thrills', familyTitle: 'Fast & Furious Arcade', manufacturerProfile: { preferredSourceTokens: ['rawthrills.com'], sourceTokens: ['rawthrills.com'] } }
  });
  assert.equal(result.manualReady, true);
  assert.equal(saves.length, 1);
});

test('source page with junk links does not create a manual record', async () => {
  const db = createDb();
  const saves = [];
  const result = await acquireManualToLibrary({
    db,
    storage: createStorage(saves),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://baytekent.com/games/sink-it-shootout/',
      headers: { get: () => 'text/html' },
      text: async () => '<a href="/installations/sink-it-shootout/">Installations</a><a href="/careers/">Careers</a>'
    }),
    candidate: { sourcePageUrl: 'https://baytekent.com/games/sink-it-shootout/' },
    context: { originalTitle: 'Sink-It', canonicalTitle: 'Sink-It', manufacturer: 'Bay Tek Games', familyTitle: 'Sink-It', manufacturerProfile: { preferredSourceTokens: ['baytekent.com'], sourceTokens: ['baytekent.com'] } }
  });
  assert.equal(result.manualReady, false);
  assert.equal(Object.keys(db.state.manualLibrary).length, 0);
  assert.equal(saves.length, 0);
});

test('buildManualLibraryStoragePath uses shared library path convention', () => {
  assert.equal(buildManualLibraryStoragePath({ normalizedManufacturer: 'Raw Thrills', canonicalTitle: 'Fast & Furious Arcade', sha256: 'abc123', extension: 'pdf' }), 'manual-library/raw-thrills/fast-furious-arcade/abc123.pdf');
});

test('downloadManualCandidate aborts stalled downloads with a hard timeout', async () => {
  await assert.rejects(
    () => downloadManualCandidate(
      'https://example.com/stuck.pdf',
      async (url, options = {}) => new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error(`aborted ${url}`);
          error.name = 'AbortError';
          reject(error);
        });
      }),
      25,
    ),
    /timed out/i,
  );
});
