import {
  collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { db, serverTimestamp } from './firebase.js';
import { appConfig } from './config.js';
import { logAudit } from './audit.js';
import { buildCompanyScopedPayload, getActiveCompanyContext, includeRecordForActiveCompany, isCompanyScopedCollection, setActiveCompanyContext } from './companyScope.js';

const C = appConfig.collections;
export { setActiveCompanyContext };

const withMeta = (payload, user, isCreate) => ({
  ...payload,
  ...(isCreate ? { createdAt: serverTimestamp(), createdBy: user.uid } : {}),
  updatedAt: serverTimestamp(),
  updatedBy: user.uid
});

export async function listEntities(name) {
  const scope = getActiveCompanyContext();
  const scopedQuery = isCompanyScopedCollection(name) && scope.companyId && !scope.allowLegacy;
  const baseQuery = scopedQuery
    ? query(collection(db, C[name]), where('companyId', '==', scope.companyId), orderBy('updatedAt', 'desc'))
    : query(collection(db, C[name]), orderBy('updatedAt', 'desc'));
  const snap = await getDocs(baseQuery);
  return snap.docs
    .map((d) => ({ id: d.id, __collection: name, ...d.data() }))
    .filter((entity) => includeRecordForActiveCompany(name, entity))
    .map(({ __collection, ...rest }) => rest);
}

export async function listAudit(filters = {}) {
  const scope = getActiveCompanyContext();
  const constraints = [];
  if (isCompanyScopedCollection('auditLogs') && scope.companyId && !scope.allowLegacy) {
    constraints.push(where('companyId', '==', scope.companyId));
  }
  if (filters.action) constraints.push(where('action', '==', filters.action));
  constraints.push(orderBy('timestamp', 'desc'));
  const q = query(collection(db, C.auditLogs), ...constraints);
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, __collection: 'auditLogs', ...d.data() }))
    .filter((entity) => includeRecordForActiveCompany('auditLogs', entity))
    .map(({ __collection, ...rest }) => rest)
    .filter((i) => !filters.entityType || i.entityType === filters.entityType)
    .filter((i) => !filters.userUid || i.userUid === filters.userUid);
}

export async function upsertEntity(name, id, payload, user) {
  const ref = doc(db, C[name], id);
  const basePayload = buildCompanyScopedPayload(name, { id, ...payload });
  let before = null;
  let action = 'create';
  try {
    const beforeSnap = await getDoc(ref);
    before = beforeSnap.exists() ? beforeSnap.data() : null;
    action = before ? 'update' : 'create';
  } catch (error) {
    const code = `${error?.code || ''}`;
    const optimisticCreate = code.includes('permission-denied') && isCompanyScopedCollection(name) && !!basePayload.companyId;
    if (!optimisticCreate) throw error;
  }
  const nextPayload = withMeta(basePayload, user, action === 'create');
  if (isCompanyScopedCollection(name) && !nextPayload.companyId && !before?.companyId) {
    const scope = getActiveCompanyContext();
    throw new Error(`Missing company context for ${name}/${id}. Active company: ${scope.companyId || 'none'}.`);
  }
  await setDoc(ref, nextPayload, { merge: true });
  const after = { ...(before || {}), ...nextPayload };
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
  taskIntakeRequiredFields: ['assetId', 'description', 'reporter']
};

export async function getAppSettings() {
  const scope = getActiveCompanyContext();
  if (scope.companyId) {
    const companyDocId = `ai_${scope.companyId}`;
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
  const scope = getActiveCompanyContext();
  const id = scope.companyId ? `ai_${scope.companyId}` : 'ai';
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
  const nextPayload = buildCompanyScopedPayload(name, payload);
  if (isCompanyScopedCollection(name) && !nextPayload.companyId) {
    const scope = getActiveCompanyContext();
    throw new Error(`Missing company context for ${name}/${id}. Active company: ${scope.companyId || 'none'}.`);
  }
  await updateDoc(doc(db, C[name], id), nextPayload);
}
