import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, updateDoc, where } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { db } from './firebase.js';
import { appConfig } from './config.js';

const C = appConfig.collections;

const slugify = (value = '') => `${value}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);

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
  if (!hasLegacyData) return { membership: null, created: false };

  const suggested = `${profile?.companyName || profile?.displayName || user.email?.split('@')[0] || 'WOW'} Workspace`;
  const companyId = `co-${slugify(suggested) || user.uid.slice(0, 8)}-${user.uid.slice(0, 4)}`;
  const companyRef = doc(db, C.companies, companyId);
  await setDoc(companyRef, {
    id: companyId,
    name: suggested,
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

export async function createCompanyFromOnboarding(user, payload = {}) {
  const baseName = `${payload.name || ''}`.trim();
  if (!baseName) throw new Error('Company name is required.');
  const companyId = `co-${slugify(baseName) || user.uid.slice(0, 8)}-${Date.now().toString(36).slice(-4)}`;
  await setDoc(doc(db, C.companies, companyId), {
    id: companyId,
    name: baseName,
    primaryEmail: payload.primaryEmail || user.email,
    primaryPhone: payload.primaryPhone || '',
    address: payload.address || '',
    timeZone: payload.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    estimatedUsers: Number(payload.estimatedUsers || 0) || null,
    estimatedAssets: Number(payload.estimatedAssets || 0) || null,
    onboardingCompleted: true,
    onboardingCompletedAt: serverTimestamp(),
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

  const locations = Array.isArray(payload.locations) ? payload.locations : [];
  for (const raw of locations) {
    const name = `${raw?.name || ''}`.trim();
    if (!name) continue;
    const locId = `loc-${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    await setDoc(doc(db, C.companyLocations, locId), {
      id: locId,
      companyId,
      name,
      address: raw.address || '',
      timeZone: raw.timeZone || payload.timeZone || '',
      notes: raw.notes || '',
      createdAt: serverTimestamp(),
      createdBy: user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid
    }, { merge: true });
  }

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
  return { id: ref.id, inviteCode, token };
}

export async function revokeInvite(inviteId, user) {
  await updateDoc(doc(db, C.companyInvites, inviteId), {
    status: 'revoked',
    revokedAt: serverTimestamp(),
    revokedBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid
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
  return invite.companyId;
}

export async function deleteCompanyInvite(inviteId) {
  await deleteDoc(doc(db, C.companyInvites, inviteId));
}

export async function listCompanyMembers(companyId) {
  const snap = await getDocs(query(collection(db, C.companyMemberships), where('companyId', '==', companyId), orderBy('createdAt', 'desc')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
