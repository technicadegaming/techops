import {
  collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { db, serverTimestamp } from './firebase.js';
import { appConfig } from './config.js';
import { logAudit } from './audit.js';

const C = appConfig.collections;

const companyScopedCollections = new Set([
  'assets', 'tasks', 'operations', 'manuals', 'pmSchedules', 'notes', 'auditLogs',
  'taskAiRuns', 'taskAiFollowups', 'troubleshootingLibrary', 'appSettings', 'workers', 'importHistory', 'companyLocations', 'companyInvites'
]);

const companyScopeState = {
  companyId: null,
  allowLegacy: false
};

export function setActiveCompanyContext(companyId, options = {}) {
  companyScopeState.companyId = companyId || null;
  companyScopeState.allowLegacy = !!options.allowLegacy;
}

function isScopedCollection(name) {
  return companyScopedCollections.has(name);
}

function includeRecordForActiveCompany(entity = {}) {
  if (!companyScopeState.companyId || !isScopedCollection(entity.__collection)) return true;
  const itemCompanyId = entity.companyId || null;
  if (itemCompanyId === companyScopeState.companyId) return true;
  if (!itemCompanyId && companyScopeState.allowLegacy) return true;
  return false;
}

function withCompanyPayload(name, payload = {}) {
  if (!isScopedCollection(name) || !companyScopeState.companyId) return payload;
  return { ...payload, companyId: payload.companyId || companyScopeState.companyId };
}

const withMeta = (payload, user, isCreate) => ({
  ...payload,
  ...(isCreate ? { createdAt: serverTimestamp(), createdBy: user.uid } : {}),
  updatedAt: serverTimestamp(),
  updatedBy: user.uid
});

export async function listEntities(name) {
  const snap = await getDocs(query(collection(db, C[name]), orderBy('updatedAt', 'desc')));
  return snap.docs
    .map((d) => ({ id: d.id, __collection: name, ...d.data() }))
    .filter(includeRecordForActiveCompany)
    .map(({ __collection, ...rest }) => rest);
}

export async function listAudit(filters = {}) {
  let q = query(collection(db, C.auditLogs), orderBy('timestamp', 'desc'));
  if (filters.action) q = query(collection(db, C.auditLogs), where('action', '==', filters.action), orderBy('timestamp', 'desc'));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, __collection: 'auditLogs', ...d.data() }))
    .filter(includeRecordForActiveCompany)
    .map(({ __collection, ...rest }) => rest)
    .filter((i) => !filters.entityType || i.entityType === filters.entityType)
    .filter((i) => !filters.userUid || i.userUid === filters.userUid);
}

export async function upsertEntity(name, id, payload, user) {
  const ref = doc(db, C[name], id);
  const beforeSnap = await getDoc(ref);
  const before = beforeSnap.exists() ? beforeSnap.data() : null;
  const action = before ? 'update' : 'create';
  const nextPayload = withMeta(withCompanyPayload(name, { id, ...payload }), user, !before);
  await setDoc(ref, nextPayload, { merge: true });
  const after = (await getDoc(ref)).data();
  await logAudit({ action, entityType: name, entityId: id, summary: `${action} ${name}/${id}`, user, before, after: { ...after, companyId: nextPayload.companyId || after?.companyId || null } });
}

export async function deleteEntity(name, id, user) {
  const ref = doc(db, C[name], id);
  const before = (await getDoc(ref)).data() || null;
  await deleteDoc(ref);
  await logAudit({ action: 'delete', entityType: name, entityId: id, summary: `delete ${name}/${id}`, user, before, after: null });
}

export async function loadUserProfile(uid) {
  const snap = await getDoc(doc(db, C.users, uid));
  return snap.exists() ? snap.data() : null;
}

export async function saveUserProfile(uid, profile, actor) {
  const ref = doc(db, C.users, uid);
  const before = (await getDoc(ref)).data() || null;
  await setDoc(ref, withMeta({ id: uid, ...profile }, actor || { uid }, !before), { merge: true });
  await logAudit({ action: before ? 'update' : 'create', entityType: 'users', entityId: uid, summary: 'user profile changed', user: actor || { uid }, before, after: profile });
}

const defaultAiSettings = {
  aiEnabled: false,
  aiAutoAttach: false,
  aiUseInternalKnowledge: true,
  aiUseWebSearch: false,
  aiAskFollowups: true,
  aiModel: 'gpt-4.1-mini',
  aiMaxWebSources: 3,
  aiConfidenceThreshold: 0.45,
  aiAllowManualRerun: true,
  aiSaveSuccessfulFixesToLibraryDefault: false,
  aiShortResponseMode: true,
  aiVerboseManagerMode: false,
  defaultTaskSeverity: 'medium',
  aiFeedbackCollectionEnabled: true,
  mobileConciseModeDefault: true,
  taskIntakeRequiredFields: ['id', 'title', 'assetId', 'issueCategory', 'severity']
};

export async function getAppSettings() {
  if (companyScopeState.companyId) {
    const companyDocId = `ai_${companyScopeState.companyId}`;
    const scopedRef = doc(db, C.appSettings, companyDocId);
    const scopedSnap = await getDoc(scopedRef);
    if (scopedSnap.exists()) return { ...defaultAiSettings, ...scopedSnap.data() };
  }
  const aiRef = doc(db, C.appSettings, 'ai');
  const aiSnap = await getDoc(aiRef);
  if (aiSnap.exists()) return { ...defaultAiSettings, ...aiSnap.data() };
  const legacyRef = doc(db, C.appSettings, 'global');
  const legacySnap = await getDoc(legacyRef);
  return legacySnap.exists() ? { ...defaultAiSettings, ...legacySnap.data() } : defaultAiSettings;
}

export async function saveAppSettings(settings, user) {
  const id = companyScopeState.companyId ? `ai_${companyScopeState.companyId}` : 'ai';
  await upsertEntity('appSettings', id, settings, user);
}

export async function countEntities(name) {
  const rows = await listEntities(name);
  return rows.length;
}

export async function clearEntitySet(name, user, predicate = () => true) {
  const rows = await listEntities(name);
  const targets = rows.filter(predicate);
  for (const row of targets) {
    await deleteEntity(name, row.id, user);
  }
  return targets.length;
}

export async function updateEntity(name, id, payload) {
  await updateDoc(doc(db, C[name], id), payload);
}
