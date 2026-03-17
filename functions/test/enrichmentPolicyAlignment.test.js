const test = require('node:test');
const assert = require('node:assert/strict');

const { canRunAssetEnrichment } = require('../src/lib/permissions');
const { authorizeAssetEnrichment } = require('../src/lib/enrichmentAuthorization');

function makeDb({ assets = {}, memberships = {} } = {}) {
  return {
    collection(name) {
      if (name === 'assets') {
        return {
          doc(id) {
            return {
              async get() {
                if (!assets[id]) return { exists: false, data: () => ({}) };
                return { exists: true, data: () => assets[id] };
              }
            };
          }
        };
      }
      if (name === 'companyMemberships') {
        return {
          doc(id) {
            return {
              async get() {
                if (!memberships[id]) return { exists: false, data: () => ({}) };
                return { exists: true, id, data: () => memberships[id] };
              }
            };
          },
          where() {
            return {
              where() {
                return {
                  where() {
                    return {
                      limit() {
                        return {
                          async get() {
                            return { empty: true, docs: [] };
                          }
                        };
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
      throw new Error(`Unknown collection ${name}`);
    }
  };
}

test('asset enrichment role threshold is manager+ globally for legacy assets', async () => {
  assert.equal(canRunAssetEnrichment('owner'), true);
  assert.equal(canRunAssetEnrichment('admin'), true);
  assert.equal(canRunAssetEnrichment('manager'), true);
  assert.equal(canRunAssetEnrichment('lead'), false);
  assert.equal(canRunAssetEnrichment('staff'), false);

  const db = makeDb({ assets: { legacyA: { id: 'legacyA' } } });

  const allowedManager = await authorizeAssetEnrichment({ db, assetId: 'legacyA', uid: 'u1', getUserRole: async () => 'manager' });
  const blockedLead = await authorizeAssetEnrichment({ db, assetId: 'legacyA', uid: 'u1', getUserRole: async () => 'lead' });

  assert.equal(allowedManager.scope, 'legacy_no_company');
  assert.equal(allowedManager.allowed, true);
  assert.equal(blockedLead.scope, 'legacy_no_company');
  assert.equal(blockedLead.allowed, false);
});

test('company-scoped asset enrichment allows owner/admin/manager and blocks lead/staff', async () => {
  const db = makeDb({
    assets: { a1: { id: 'a1', companyId: 'c1' } },
    memberships: {
      c1_uOwner: { companyId: 'c1', userId: 'uOwner', role: 'owner', status: 'active' },
      c1_uAdmin: { companyId: 'c1', userId: 'uAdmin', role: 'admin', status: 'active' },
      c1_uManager: { companyId: 'c1', userId: 'uManager', role: 'manager', status: 'active' },
      c1_uLead: { companyId: 'c1', userId: 'uLead', role: 'lead', status: 'active' },
      c1_uStaff: { companyId: 'c1', userId: 'uStaff', role: 'staff', status: 'active' }
    }
  });

  const owner = await authorizeAssetEnrichment({ db, assetId: 'a1', uid: 'uOwner', getUserRole: async () => 'staff' });
  const admin = await authorizeAssetEnrichment({ db, assetId: 'a1', uid: 'uAdmin', getUserRole: async () => 'staff' });
  const manager = await authorizeAssetEnrichment({ db, assetId: 'a1', uid: 'uManager', getUserRole: async () => 'staff' });
  const lead = await authorizeAssetEnrichment({ db, assetId: 'a1', uid: 'uLead', getUserRole: async () => 'staff' });
  const staff = await authorizeAssetEnrichment({ db, assetId: 'a1', uid: 'uStaff', getUserRole: async () => 'staff' });

  assert.equal(owner.allowed, true);
  assert.equal(admin.allowed, true);
  assert.equal(manager.allowed, true);
  assert.equal(lead.allowed, false);
  assert.equal(staff.allowed, false);
});

test('global admin bypasses company membership check', async () => {
  const db = makeDb({ assets: { a2: { id: 'a2', companyId: 'c2' } } });
  const result = await authorizeAssetEnrichment({ db, assetId: 'a2', uid: 'uAdmin', getUserRole: async () => 'admin' });
  assert.equal(result.scope, 'global_admin');
  assert.equal(result.allowed, true);
});
