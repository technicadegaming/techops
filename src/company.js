import { collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, updateDoc, where } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { db } from './firebase.js';
import { functions } from './firebase.js';
import { appConfig, isBootstrapAdminEmail } from './config.js';
import { normalizeMembershipRecords } from './app/membershipCompatibility.js';
import { logAudit } from './audit.js';
import { buildInitialBillingScaffold } from './billing.js';

const C = appConfig.collections;

const slugify = (value = '') => `${value}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);

function composeAddress(parts = {}) {
  const street = `${parts.street || ''}`.trim();
  const city = `${parts.city || ''}`.trim();
  const state = `${parts.state || ''}`.trim();
  const zip = `${parts.zip || ''}`.trim();
  const locality = [city, state].filter(Boolean).join(', ');
  return [street, locality, zip].filter(Boolean).join(' ').trim();
}

function normalizeHeadquarters(payload = {}) {
  const street = `${payload.hqStreet || ''}`.trim();
  const city = `${payload.hqCity || ''}`.trim();
  const state = `${payload.hqState || ''}`.trim();
  const zip = `${payload.hqZip || ''}`.trim();
  const country = `${payload.hqCountry || ''}`.trim() || 'US';
  const address = `${payload.address || ''}`.trim() || composeAddress({ street, city, state, zip });
  return {
    street,
    city,
    state,
    zip,
    country,
    address
  };
}

function randomCode(size = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
    ? crypto.getRandomValues(new Uint8Array(size))
    : null;
  for (let i = 0; i < size; i += 1) {
    const index = bytes ? bytes[i] % chars.length : Math.floor(Math.random() * chars.length);
    out += chars[index];
  }
  return out;
}

function normalizeInviteCode(inviteCode = '') {
  return `${inviteCode || ''}`.trim().toUpperCase();
}

async function createUniqueInviteCode(size = 10, maxAttempts = 6) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const inviteCode = normalizeInviteCode(randomCode(size));
    const existing = await getDocs(query(
      collection(db, C.companyInvites),
      where('inviteCode', '==', inviteCode),
      limit(1)
    ));
    if (existing.empty) return inviteCode;
  }
  throw new Error('Unable to generate a unique invite code right now. Please retry.');
}

function isPermissionDenied(error) {
  const code = `${error?.code || ''}`.trim().toLowerCase();
  const message = `${error?.message || ''}`.trim().toLowerCase();
  return code.includes('permission-denied') || message.includes('missing or insufficient permissions');
}

async function queryMembershipsByUser(uid, userField, options = {}) {
  const filters = [where(userField, '==', uid)];
  if (options.requireActiveStatus) filters.push(where('status', '==', 'active'));
  const snap = await getDocs(query(collection(db, C.companyMemberships), ...filters));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function listMembershipsByUser(uid) {
  const legacyMembershipCollection = `${C.companyMemberships || ''}`.trim() === 'workspace_members';

  try {
    const rows = await queryMembershipsByUser(uid, 'userId', { requireActiveStatus: true });
    const normalized = normalizeMembershipRecords(rows);
    if (normalized.length || !legacyMembershipCollection) return normalized;
  } catch (error) {
    if (!legacyMembershipCollection || !isPermissionDenied(error)) throw error;
  }

  const fallbackFields = ['uid', 'userUid', 'memberUid', 'memberId'];
  const aggregate = [];
  for (const field of fallbackFields) {
    try {
      const rows = await queryMembershipsByUser(uid, field);
      aggregate.push(...rows);
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
    }
  }
  return normalizeMembershipRecords(aggregate);
}

export async function getCompany(companyId) {
  const snap = await getDoc(doc(db, C.companies, companyId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getCompanyByInviteCode(code) {
  const clean = normalizeInviteCode(code);
  if (!clean) return null;
  const invites = await getDocs(query(
    collection(db, C.companyInvites),
    where('inviteCodeNormalized', '==', clean),
    where('status', '==', 'pending'),
    limit(1)
  )).catch(async () => getDocs(query(
    collection(db, C.companyInvites),
    where('inviteCode', '==', clean),
    where('status', '==', 'pending'),
    limit(1)
  )));
  const hit = invites.docs[0];
  return hit ? { id: hit.id, ...hit.data() } : null;
}

export async function ensureBootstrapCompanyForLegacyUser(user, profile, hasLegacyData) {
  const memberships = await listMembershipsByUser(user.uid);
  if (memberships.length) return { membership: memberships[0], created: false };
  if (!hasLegacyData || !canAutoAdoptLegacyWorkspace(user, profile)) return { membership: null, created: false };

  const suggested = `${profile?.companyName || profile?.displayName || user.email?.split('@')[0] || 'Scoot'} Workspace`;
  const companyId = `co-${slugify(suggested) || user.uid.slice(0, 8)}-${user.uid.slice(0, 4)}`;
  const companyRef = doc(db, C.companies, companyId);
  await setDoc(companyRef, {
    id: companyId,
    name: suggested,
    ...buildInitialBillingScaffold({ primaryEmail: user.email, displayName: profile?.displayName || user.displayName || '' }),
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    onboardingCompleted: false,
    legacyAdopted: true
  }, { merge: true });

  const membershipRef = doc(db, C.companyMemberships, `${companyId}_${user.uid}`);
  await setDoc(membershipRef, {
    id: `${companyId}_${user.uid}`,
    companyId,
    userId: user.uid,
    role: 'owner',
    status: 'active',
    createdAt: serverTimestamp(),
    createdBy: user.uid
  }, { merge: true });

  return { membership: { id: `${companyId}_${user.uid}`, companyId, userId: user.uid, role: 'owner', status: 'active' }, created: true };
}

export function canAutoAdoptLegacyWorkspace(user, profile) {
  const normalizedEmail = `${user?.email || ''}`.trim().toLowerCase();
  if (!normalizedEmail) return false;
  if (isBootstrapAdminEmail(normalizedEmail)) return true;
  if (profile?.suppressLegacyAutoAdopt === true) return false;
  if (profile?.legacyBootstrapEligible === true) return true;
  return profile?.role === 'admin';
}

export async function createCompanyFromOnboarding(user, payload = {}) {
  const baseName = `${payload.name || ''}`.trim();
  if (!baseName) throw new Error('Company name is required.');
  const companyId = `co-${slugify(baseName) || user.uid.slice(0, 8)}-${Date.now().toString(36).slice(-4)}`;
  const headquarters = normalizeHeadquarters(payload);
  await setDoc(doc(db, C.companies, companyId), {
    id: companyId,
    name: baseName,
    ...buildInitialBillingScaffold({ primaryEmail: payload.primaryEmail || user.email, displayName: payload.ownerDisplayName || user.displayName || '' }),
    primaryEmail: payload.primaryEmail || user.email,
    primaryPhone: payload.primaryPhone || '',
    address: headquarters.address,
    hqStreet: headquarters.street,
    hqCity: headquarters.city,
    hqState: headquarters.state,
    hqZip: headquarters.zip,
    hqCountry: headquarters.country,
    timeZone: payload.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    estimatedUsers: Number(payload.estimatedUsers || 0) || null,
    estimatedAssets: Number(payload.estimatedAssets || 0) || null,
    onboardingCompleted: false,
    createdAt: serverTimestamp(),
    createdBy: user.uid
  }, { merge: true });

  await setDoc(doc(db, C.companyMemberships, `${companyId}_${user.uid}`), {
    id: `${companyId}_${user.uid}`,
    companyId,
    userId: user.uid,
    role: 'owner',
    status: 'active',
    createdAt: serverTimestamp(),
    createdBy: user.uid
  }, { merge: true });

  const baseTimeZone = payload.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const legacyLocations = Array.isArray(payload.locations) ? payload.locations : [];
  const normalizedFirstLocation = payload.firstLocation && typeof payload.firstLocation === 'object'
    ? payload.firstLocation
    : null;
  const locations = [
    ...(normalizedFirstLocation ? [normalizedFirstLocation] : []),
    ...legacyLocations
  ];
  let firstLocationId = '';
  if (!locations.length) {
    locations.push({
      name: `${baseName} HQ`,
      address: headquarters.address,
      timeZone: baseTimeZone,
      notes: 'Auto-created from company profile.'
    });
  }
  for (const raw of locations) {
    const hasContent = [`${raw?.name || ''}`, `${raw?.address || ''}`, `${raw?.timeZone || ''}`, `${raw?.notes || ''}`].some((entry) => `${entry}`.trim());
    if (!hasContent) continue;
    const fallbackName = `${baseName || ''}`.trim() ? `${baseName} Main` : 'Main location';
    const name = `${raw?.name || ''}`.trim() || fallbackName;
    const locId = `loc-${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    await setDoc(doc(db, C.companyLocations, locId), {
      id: locId,
      companyId,
      name,
      address: raw.address || '',
      timeZone: raw.timeZone || baseTimeZone,
      notes: raw.notes || '',
      createdAt: serverTimestamp(),
      createdBy: user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid
    }, { merge: true });
    if (!firstLocationId) firstLocationId = locId;
  }

  const ownerWorkerId = `worker-owner-${user.uid.slice(0, 12)}`;
  const ownerWorkerName = `${payload.ownerDisplayName || user.displayName || user.email?.split('@')[0] || 'Owner'}`.trim();
  await setDoc(doc(db, C.workers, ownerWorkerId), {
    id: ownerWorkerId,
    companyId,
    displayName: ownerWorkerName,
    email: `${user.email || payload.primaryEmail || ''}`.trim().toLowerCase(),
    role: 'admin',
    enabled: true,
    available: true,
    accountStatus: 'linked_owner',
    defaultLocationId: firstLocationId || '',
    locationName: `${locations[0]?.name || `${baseName} HQ`}`.trim(),
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid
  }, { merge: true });

  return { companyId };
}

export async function createCompanyInvite({
  companyId,
  email,
  role = 'staff',
  user,
  displayName = '',
  createWorkerProfile = false,
  workerTitle = '',
  workerNotes = ''
}) {
  const inviteCode = await createUniqueInviteCode(10);
  const token = `${companyId}.${inviteCode}.${Math.random().toString(36).slice(2, 10)}`;
  const ref = doc(collection(db, C.companyInvites));
  await setDoc(ref, {
    id: ref.id,
    companyId,
    email: `${email || ''}`.trim().toLowerCase(),
    role,
    displayName: `${displayName || ''}`.trim(),
    inviteCode,
    inviteCodeNormalized: normalizeInviteCode(inviteCode),
    token,
    createWorkerProfile: createWorkerProfile === true,
    workerTitle: `${workerTitle || ''}`.trim(),
    workerNotes: `${workerNotes || ''}`.trim(),
    status: 'pending',
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    expiresAt: null
  }, { merge: true });
  await logAudit({
    action: 'create',
    actionType: 'invite_sent',
    category: 'people_access',
    entityType: 'companyInvites',
    entityId: ref.id,
    targetType: 'invite',
    targetId: ref.id,
    targetLabel: `${email || ''}`.trim().toLowerCase(),
    summary: `Invite sent to ${`${email || ''}`.trim().toLowerCase()}`,
    user,
    metadata: { role, companyId }
  });
  return { id: ref.id, inviteCode, token };
}

export async function revokeInvite(inviteId, user) {
  const ref = doc(db, C.companyInvites, inviteId);
  const before = await getDoc(ref);
  const invite = before.exists() ? before.data() : {};
  await updateDoc(doc(db, C.companyInvites, inviteId), {
    status: 'revoked',
    revokedAt: serverTimestamp(),
    revokedBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid
  });
  await logAudit({
    action: 'update',
    actionType: 'invite_revoked',
    category: 'people_access',
    entityType: 'companyInvites',
    entityId: inviteId,
    targetType: 'invite',
    targetId: inviteId,
    targetLabel: invite.email || inviteId,
    summary: `Invite revoked for ${invite.email || inviteId}`,
    user,
    metadata: { role: invite.role || '', status: 'revoked' }
  });
}

export async function acceptInvite({ inviteCode }) {
  const callable = httpsCallable(functions, 'acceptCompanyInvite');
  try {
    const result = await callable({
      inviteCode: normalizeInviteCode(inviteCode)
    });
    return `${result?.data?.companyId || ''}`.trim();
  } catch (error) {
    throw mapInviteAcceptanceError(error);
  }
}

export function mapInviteAcceptanceError(error) {
  const code = `${error?.code || ''}`.trim().toLowerCase();
  const message = `${error?.message || ''}`.trim();
  if (code.includes('permission-denied')) return new Error('Wrong email for this invite. Sign in with the invited email and retry.');
  if (code.includes('failed-precondition') && /expired/i.test(message)) return new Error('This invite has expired. Ask your admin for a new invite.');
  if (code.includes('failed-precondition') && /revoked/i.test(message)) return new Error('This invite was revoked. Ask your admin for a new invite.');
  if (code.includes('already-exists')) return new Error('This invite was already accepted. Ask your admin for a new invite code if needed.');
  if (code.includes('not-found')) return new Error('Invite code not found. Verify the code and try again.');
  if (code.includes('unimplemented') || /function|deploy|not found/i.test(message)) return new Error('Invite service is unavailable. Deploy functions and try again.');
  return error instanceof Error ? error : new Error(message || 'Unable to accept invite right now.');
}

export async function deleteCompanyInvite(inviteId) {
  await deleteDoc(doc(db, C.companyInvites, inviteId));
}

export async function listCompanyMembers(companyId) {
  const snap = await getDocs(query(collection(db, C.companyMemberships), where('companyId', '==', companyId), orderBy('createdAt', 'desc')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
