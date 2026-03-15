const { canRunAssetEnrichment, normalizeRole } = require('./permissions');

const ENRICHMENT_COMPANY_ROLES = new Set(['owner', 'admin', 'manager']);

function isGlobalAdminRole(role) {
  return normalizeRole(role) === 'admin';
}

function hasCompanyEnrichmentRole(role) {
  return ENRICHMENT_COMPANY_ROLES.has(`${role || ''}`.trim().toLowerCase());
}

async function getActiveMembershipForCompany({ db, companyId, uid }) {
  if (!companyId || !uid) return null;

  const directRef = db.collection('companyMemberships').doc(`${companyId}_${uid}`);
  const directSnap = await directRef.get();
  if (directSnap.exists) {
    const data = directSnap.data() || {};
    if (data.status === 'active') return { id: directSnap.id, ...data };
  }

  const fallbackSnap = await db.collection('companyMemberships')
    .where('companyId', '==', companyId)
    .where('userId', '==', uid)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (fallbackSnap.empty) return null;
  const doc = fallbackSnap.docs[0];
  return { id: doc.id, ...(doc.data() || {}) };
}

async function authorizeAssetEnrichment({ db, assetId, uid, getUserRole }) {
  const globalRole = await getUserRole(uid);
  if (isGlobalAdminRole(globalRole)) {
    return { allowed: true, globalRole, scope: 'global_admin' };
  }

  const assetSnap = await db.collection('assets').doc(assetId).get();
  if (!assetSnap.exists) {
    return { allowed: false, globalRole, scope: 'asset_not_found' };
  }

  const asset = assetSnap.data() || {};
  const companyId = `${asset.companyId || ''}`.trim();

  if (!companyId) {
    return {
      allowed: canRunAssetEnrichment(globalRole),
      globalRole,
      scope: 'legacy_no_company',
      asset
    };
  }

  const membership = await getActiveMembershipForCompany({ db, companyId, uid });
  const companyRole = `${membership?.role || ''}`.trim().toLowerCase();
  const allowed = hasCompanyEnrichmentRole(companyRole);

  return {
    allowed,
    globalRole,
    companyRole,
    companyId,
    scope: 'company_membership',
    asset
  };
}

module.exports = {
  ENRICHMENT_COMPANY_ROLES,
  isGlobalAdminRole,
  hasCompanyEnrichmentRole,
  getActiveMembershipForCompany,
  authorizeAssetEnrichment
};
