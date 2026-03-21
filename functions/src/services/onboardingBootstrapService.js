const { HttpsError } = require('firebase-functions/v2/https');

const COMPLETE_STATE = 'complete';
const ACTIVE_STATUS = 'active';
const PENDING_ROLE = 'pending';

function normalizeString(value = '') {
  return `${value || ''}`.trim();
}

function normalizeCompanyRole(role = '') {
  return `${role || ''}`.trim().toLowerCase();
}

function isPendingRole(role = '') {
  return normalizeCompanyRole(role) === PENDING_ROLE;
}

function toIsoString(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function deriveResolvedRole({ userId, company = {}, membership = null, activeMemberships = [], userProfile = {} } = {}) {
  const membershipRole = normalizeCompanyRole(membership?.role);
  if (membershipRole && !isPendingRole(membershipRole)) return membershipRole;

  const profileRole = normalizeCompanyRole(userProfile?.role);
  if (profileRole && !isPendingRole(profileRole)) return profileRole;

  if (normalizeString(company.createdBy) === normalizeString(userId)) return 'owner';

  const firstUserRole = activeMemberships
    .filter((entry) => normalizeString(entry.userId) === normalizeString(userId))
    .map((entry) => normalizeCompanyRole(entry.role))
    .find((role) => role && !isPendingRole(role));

  return firstUserRole || membershipRole || profileRole || PENDING_ROLE;
}

async function loadActiveMemberships(db, companyId) {
  const snap = await db.collection('companyMemberships')
    .where('companyId', '==', companyId)
    .where('status', '==', ACTIVE_STATUS)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

async function loadCompanyLocations(db, companyId) {
  const snap = await db.collection('companyLocations')
    .where('companyId', '==', companyId)
    .limit(1)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

async function finalizeOnboardingBootstrap({ db, auth, companyId, requireLocation = true }) {
  const uid = normalizeString(auth?.uid);
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

  const normalizedCompanyId = normalizeString(companyId);
  if (!normalizedCompanyId) throw new HttpsError('invalid-argument', 'companyId is required');

  const [companySnap, userSnap, membershipSnap, activeMemberships, locations] = await Promise.all([
    db.collection('companies').doc(normalizedCompanyId).get(),
    db.collection('users').doc(uid).get(),
    db.collection('companyMemberships').doc(`${normalizedCompanyId}_${uid}`).get(),
    loadActiveMemberships(db, normalizedCompanyId),
    requireLocation ? loadCompanyLocations(db, normalizedCompanyId) : Promise.resolve([])
  ]);

  if (!companySnap.exists) throw new HttpsError('not-found', 'Company not found');

  const company = { id: companySnap.id, ...(companySnap.data() || {}) };
  const userProfile = userSnap.exists ? { id: userSnap.id, ...(userSnap.data() || {}) } : {};
  const membership = membershipSnap.exists ? { id: membershipSnap.id, ...(membershipSnap.data() || {}) } : null;

  if (!membership || normalizeString(membership.status || ACTIVE_STATUS).toLowerCase() !== ACTIVE_STATUS) {
    throw new HttpsError('permission-denied', 'Active membership required for bootstrap finalization');
  }

  if (!activeMemberships.length) {
    throw new HttpsError('failed-precondition', 'At least one active membership is required');
  }

  if (requireLocation && !locations.length) {
    throw new HttpsError('failed-precondition', 'At least one location is required');
  }

  const resolvedRole = deriveResolvedRole({ userId: uid, company, membership, activeMemberships, userProfile });
  if (!resolvedRole || isPendingRole(resolvedRole)) {
    throw new HttpsError('failed-precondition', 'Unable to resolve a non-pending company role');
  }

  const userPatch = {};
  if (normalizeString(userProfile.onboardingState) !== COMPLETE_STATE) userPatch.onboardingState = COMPLETE_STATE;
  if (isPendingRole(userProfile.role) || !normalizeString(userProfile.role)) userPatch.role = resolvedRole;

  const membershipPatch = {};
  if (isPendingRole(membership.role) || !normalizeString(membership.role)) membershipPatch.role = resolvedRole;

  const companyPatch = {};
  if (company.onboardingCompleted !== true) companyPatch.onboardingCompleted = true;
  if (normalizeString(company.onboardingState) !== COMPLETE_STATE) companyPatch.onboardingState = COMPLETE_STATE;
  if (!company.onboardingCompletedAt) companyPatch.onboardingCompletedAt = new Date().toISOString();

  const writes = [];
  if (Object.keys(userPatch).length) writes.push(db.collection('users').doc(uid).set(userPatch, { merge: true }));
  if (Object.keys(membershipPatch).length) writes.push(db.collection('companyMemberships').doc(membership.id).set(membershipPatch, { merge: true }));
  if (Object.keys(companyPatch).length) writes.push(db.collection('companies').doc(normalizedCompanyId).set(companyPatch, { merge: true }));
  await Promise.all(writes);

  return {
    companyId: normalizedCompanyId,
    repaired: writes.length > 0,
    resolvedRole,
    patches: {
      user: userPatch,
      membership: membershipPatch,
      company: companyPatch
    },
    checks: {
      membershipCount: activeMemberships.length,
      locationCount: locations.length,
      companyOnboardingCompletedAt: toIsoString(company.onboardingCompletedAt) || companyPatch.onboardingCompletedAt || null
    }
  };
}

module.exports = {
  COMPLETE_STATE,
  deriveResolvedRole,
  finalizeOnboardingBootstrap
};
