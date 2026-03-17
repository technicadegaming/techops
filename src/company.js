import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, updateDoc, where } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { db } from './firebase.js';
import { appConfig } from './config.js';
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
  for (let i = 0; i < size; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function listMembershipsByUser(uid) {
  const snap = await getDocs(query(collection(db, C.companyMemberships), where('userId', '==', uid), where('status', '==', 'active')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getCompany(companyId) {
  const snap = await getDoc(doc(db, C.companies, companyId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getCompanyByInviteCode(code) {
  const clean = `${code || ''}`.trim().toUpperCase();
  if (!clean) return null;
  const invites = await getDocs(query(collection(db, C.companyInvites), where('inviteCode', '==', clean), where('status', '==', 'pending'), limit(1)));
  const hit = invites.docs[0];
  return hit ? { id: hit.id, ...hit.data() } : null;
}

export async function ensureBootstrapCompanyForLegacyUser(user, profile, hasLegacyData) {
  const memberships = await listMembershipsByUser(user.uid);
  if (memberships.length) return { membership: memberships[0], created: false };
  if (!hasLegacyData || !canAutoAdoptLegacyWorkspace(user, profile)) return { membership: null, created: false };

  const suggested = `${profile?.companyName || profile?.displayName || user.email?.split('@')[0] || 'Technicade'} Workspace`;
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
  if (appConfig.bootstrapAdmins.map((email) => `${email || ''}`.trim().toLowerCase()).includes(normalizedEmail)) return true;
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

export async function createCompanyInvite({ companyId, email, role = 'staff', user }) {
  const inviteCode = randomCode(10);
  const token = `${companyId}.${inviteCode}.${Math.random().toString(36).slice(2, 10)}`;
  const ref = doc(collection(db, C.companyInvites));
  await setDoc(ref, {
    id: ref.id,
    companyId,
    email: `${email || ''}`.trim().toLowerCase(),
    role,
    inviteCode,
    token,
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

export async function acceptInvite({ inviteCode, user }) {
  const invite = await getCompanyByInviteCode(inviteCode);
  if (!invite) throw new Error('Invite not found or no longer valid.');
  if (invite.email && user.email && invite.email !== user.email.toLowerCase()) {
    throw new Error('Invite email does not match signed-in user.');
  }
  const membershipId = `${invite.companyId}_${user.uid}`;
  await setDoc(doc(db, C.companyMemberships, membershipId), {
    id: membershipId,
    companyId: invite.companyId,
    userId: user.uid,
    role: invite.role || 'staff',
    status: 'active',
    inviteId: invite.id,
    createdAt: serverTimestamp(),
    createdBy: user.uid
  }, { merge: true });
  await updateDoc(doc(db, C.companyInvites, invite.id), {
    status: 'accepted',
    acceptedAt: serverTimestamp(),
    acceptedBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid
  });
  await logAudit({
    action: 'update',
    actionType: 'invite_accepted',
    category: 'people_access',
    entityType: 'companyInvites',
    entityId: invite.id,
    targetType: 'invite',
    targetId: invite.id,
    targetLabel: invite.email || invite.id,
    summary: `Invite accepted by ${user.displayName || user.email || user.uid}`,
    user,
    metadata: { companyId: invite.companyId, role: invite.role || 'staff' }
  });
  return invite.companyId;
}

export async function deleteCompanyInvite(inviteId) {
  await deleteDoc(doc(db, C.companyInvites, inviteId));
}

export async function listCompanyMembers(companyId) {
  const snap = await getDocs(query(collection(db, C.companyMemberships), where('companyId', '==', companyId), orderBy('createdAt', 'desc')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
