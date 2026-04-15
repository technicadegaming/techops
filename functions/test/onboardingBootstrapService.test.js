const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpsError } = require('firebase-functions/v2/https');
const { finalizeOnboardingBootstrap } = require('../src/services/onboardingBootstrapService');

function createDocSnapshot(id, data) {
  return {
    id,
    exists: data != null,
    data: () => data,
  };
}

function createDb(fixtures = {}) {
  const writes = [];
  return {
    writes,
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              return createDocSnapshot(id, fixtures[name]?.[id] ?? null);
            },
            async set(payload, options) {
              writes.push({ name, id, payload, options });
              fixtures[name] = fixtures[name] || {};
              fixtures[name][id] = { ...(fixtures[name][id] || {}), ...payload };
            },
          };
        },
        where(field, op, value) {
          const filters = [{ field, op, value }];
          const chain = {
            where(nextField, nextOp, nextValue) {
              filters.push({ field: nextField, op: nextOp, value: nextValue });
              return chain;
            },
            limit() {
              return chain;
            },
            async get() {
              const docs = Object.entries(fixtures[name] || {})
                .filter(([, data]) => filters.every(({ field, op, value }) => op === '==' && `${data?.[field] || ''}` === `${value || ''}`))
                .map(([id, data]) => createDocSnapshot(id, data));
              return { docs, empty: docs.length === 0 };
            },
          };
          return chain;
        },
        limit() {
          return this;
        },
        async get() {
          const docs = Object.entries(fixtures[name] || {}).map(([id, data]) => createDocSnapshot(id, data));
          return { docs, empty: docs.length === 0 };
        },
      };
    },
  };
}

test('finalizeOnboardingBootstrap repairs stale bootstrap fields for an active owner membership', async () => {
  const db = createDb({
    companies: {
      'co-1': { id: 'co-1', name: 'Scoot Business', createdBy: 'user-1', onboardingCompleted: false },
    },
    users: {
      'user-1': { email: 'owner@example.com', role: 'pending', onboardingState: 'needs_company_setup' },
    },
    companyMemberships: {
      'co-1_user-1': { companyId: 'co-1', userId: 'user-1', role: 'pending', status: 'active' },
    },
    companyLocations: {
      'loc-1': { companyId: 'co-1', name: 'Main Floor' },
    },
  });

  const result = await finalizeOnboardingBootstrap({
    db,
    auth: { uid: 'user-1' },
    companyId: 'co-1',
    requireLocation: true,
  });

  assert.equal(result.repaired, true);
  assert.equal(result.resolvedRole, 'owner');
  assert.deepEqual(result.patches.user, { onboardingState: 'complete', role: 'owner' });
  assert.deepEqual(result.patches.membership, { role: 'owner' });
  assert.equal(result.patches.company.onboardingCompleted, true);
  assert.equal(result.patches.company.onboardingState, 'complete');
  assert.match(result.patches.company.onboardingCompletedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(db.writes.length, 3);
});

test('finalizeOnboardingBootstrap is idempotent when bootstrap metadata is already current', async () => {
  const completedAt = '2026-03-21T00:00:00.000Z';
  const db = createDb({
    companies: {
      'co-1': { id: 'co-1', name: 'Scoot Business', createdBy: 'user-1', onboardingCompleted: true, onboardingState: 'complete', onboardingCompletedAt: completedAt },
    },
    users: {
      'user-1': { email: 'owner@example.com', role: 'owner', onboardingState: 'complete' },
    },
    companyMemberships: {
      'co-1_user-1': { companyId: 'co-1', userId: 'user-1', role: 'owner', status: 'active' },
    },
    companyLocations: {
      'loc-1': { companyId: 'co-1', name: 'Main Floor' },
    },
  });

  const result = await finalizeOnboardingBootstrap({
    db,
    auth: { uid: 'user-1' },
    companyId: 'co-1',
    requireLocation: true,
  });

  assert.equal(result.repaired, false);
  assert.deepEqual(result.patches, { user: {}, membership: {}, company: {} });
  assert.equal(result.checks.companyOnboardingCompletedAt, completedAt);
  assert.equal(db.writes.length, 0);
});

test('finalizeOnboardingBootstrap rejects bootstrap repair when a required location is missing', async () => {
  const db = createDb({
    companies: {
      'co-1': { id: 'co-1', name: 'Scoot Business', createdBy: 'user-1', onboardingCompleted: false },
    },
    users: {
      'user-1': { email: 'owner@example.com', role: 'pending', onboardingState: 'needs_company_setup' },
    },
    companyMemberships: {
      'co-1_user-1': { companyId: 'co-1', userId: 'user-1', role: 'owner', status: 'active' },
    },
    companyLocations: {},
  });

  await assert.rejects(
    () => finalizeOnboardingBootstrap({ db, auth: { uid: 'user-1' }, companyId: 'co-1', requireLocation: true }),
    (error) => {
      assert.ok(error instanceof HttpsError);
      assert.equal(error.code, 'failed-precondition');
      assert.match(error.message, /location/i);
      return true;
    },
  );
});
