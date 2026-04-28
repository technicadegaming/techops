import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { db, serverTimestamp } from './firebase.js';
import { appConfig } from './config.js';
import { toCanonicalAssetRecord } from './features/assetIdentity.js';
import { logAudit } from './audit.js';
import {
  buildCompanyScopedPayload,
  getActiveCompanyContext,
  includeRecordForActiveCompany,
  isCompanyScopedCollection,
  setActiveCompanyContext
} from './companyScope.js';

const C = appConfig.collections;
export { setActiveCompanyContext };


function mapSnapshotEntity(name, snap) {
  const payload = { ...(snap.data() || {}) };
  const record = { id: snap.id, ...payload };
  if (name !== 'assets') return record;
  const storedAssetId = `${payload.id || ''}`.trim();
  return toCanonicalAssetRecord({
    ...record,
    firestoreDocId: snap.id,
    docId: snap.id,
    _docId: snap.id,
    assetRecordId: snap.id,
    storedAssetId,
  });
}

const withMeta = (payload, user, isCreate) => ({
  ...payload,
  ...(isCreate ? { createdAt: serverTimestamp(), createdBy: user.uid } : {}),
  updatedAt: serverTimestamp(),
  updatedBy: user.uid
});

export async function listEntities(name) {
  const scope = getActiveCompanyContext();
  const scopedQuery = isCompanyScopedCollection(name) && scope.companyId && !scope.allowLegacy;
  const collectionRef = collection(db, C[name]);
  const buildOrderedQuery = () => (scopedQuery
    ? query(collectionRef, where('companyId', '==', scope.companyId), orderBy('updatedAt', 'desc'))
    : query(collectionRef, orderBy('updatedAt', 'desc')));
  const buildFallbackScopeQuery = () => (scopedQuery
    ? query(collectionRef, where('companyId', '==', scope.companyId))
    : query(collectionRef));

  let snap;
  try {
    snap = await getDocs(buildOrderedQuery());
  } catch (error) {
    const message = `${error?.message || ''}`.toLowerCase();
    const code = `${error?.code || ''}`.toLowerCase();
    const missingIndex = code.includes('failed-precondition') || message.includes('index');
    if (!missingIndex) throw error;
    console.info('[people_invites] Falling back to non-ordered Firestore query due to missing index.', {
      collection: name,
      companyId: scope.companyId || null
    });
    snap = await getDocs(buildFallbackScopeQuery());
  }

  return snap.docs
    .map((d) => mapSnapshotEntity(name, d))
    .sort((a, b) => {
      const aAt = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bAt = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bAt - aAt;
    })
    .filter((entity) => includeRecordForActiveCompany(name, entity));
}

export async function listAudit(filters = {}) {
  const scope = getActiveCompanyContext();
  const constraints = [];

  if (isCompanyScopedCollection('auditLogs') && scope.companyId && !scope.allowLegacy) {
    constraints.push(where('companyId', '==', scope.companyId));
  }
  if (filters.action) constraints.push(where('action', '==', filters.action));
  if (filters.category) constraints.push(where('category', '==', filters.category));
  constraints.push(orderBy('timestamp', 'desc'));

  const q = query(collection(db, C.auditLogs), ...constraints);
  const snap = await getDocs(q);

  return snap.docs
    .map((d) => mapSnapshotEntity('auditLogs', d))
    .filter((entity) => includeRecordForActiveCompany('auditLogs', entity))
    .filter((i) => !filters.entityType || i.entityType === filters.entityType)
    .filter((i) => !filters.userUid || i.userUid === filters.userUid);
}

export async function getEntity(name, id, options = {}) {
  const ref = doc(db, C[name], id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;

  const entity = mapSnapshotEntity(name, snap);
  if (options.bypassCompanyFilter) return entity;
  return includeRecordForActiveCompany(name, entity) ? entity : null;
}

function classifyAuditEvent(name, action, id, before = null, after = null) {
  const label = after?.name || after?.title || after?.email || id;

  if (name === 'assets') {
    if (action === 'create') {
      return {
        actionType: 'asset_created',
        category: 'assets_docs',
        summary: `Asset created: ${label}`
      };
    }

    const beforeManuals = Array.isArray(before?.manualLinks) ? before.manualLinks : [];
    const afterManuals = Array.isArray(after?.manualLinks) ? after.manualLinks : [];

    if (afterManuals.length > beforeManuals.length) {
      return {
        actionType: 'docs_applied',
        category: 'assets_docs',
        summary: `Manual applied to ${label}`
      };
    }
    if (afterManuals.length < beforeManuals.length) {
      return {
        actionType: 'docs_removed',
        category: 'assets_docs',
        summary: `Manual removed from ${label}`
      };
    }

    return {
      actionType: 'asset_edited',
      category: 'assets_docs',
      summary: `Asset updated: ${label}`
    };
  }

  if (name === 'tasks') {
    if (action === 'create') {
      return {
        actionType: 'task_created',
        category: 'operations_tasks',
        summary: `Task created: ${label}`
      };
    }

    const beforeAssigned = (before?.assignedWorkers || []).join('|');
    const afterAssigned = (after?.assignedWorkers || []).join('|');

    if (beforeAssigned !== afterAssigned) {
      return {
        actionType: beforeAssigned ? 'task_reassigned' : 'task_assigned',
        category: 'operations_tasks',
        summary: `${beforeAssigned ? 'Task reassigned' : 'Task assigned'}: ${label}`
      };
    }

    if (`${before?.status || ''}` !== `${after?.status || ''}`) {
      if (`${after?.status || ''}` === 'completed') {
        return {
          actionType: 'task_closed',
          category: 'operations_tasks',
          summary: `Task closed: ${label}`
        };
      }
      return {
        actionType: 'task_status_changed',
        category: 'operations_tasks',
        summary: `Task status changed: ${label}`
      };
    }

    return {
      actionType: 'task_edited',
      category: 'operations_tasks',
      summary: `Task updated: ${label}`
    };
  }

  if (name === 'companyMemberships') {
    return {
      actionType: action === 'create' ? 'membership_created' : 'membership_role_status_changed',
      category: 'people_access',
      summary: `Membership updated: ${label}`
    };
  }

  if (name === 'companyLocations') {
    return {
      actionType: action === 'create' ? 'location_created' : 'location_edited',
      category: 'settings',
      summary: `${action === 'create' ? 'Location created' : 'Location updated'}: ${label}`
    };
  }

  if (name === 'appSettings') {
    return {
      actionType: 'settings_updated',
      category: 'settings',
      summary: 'Workspace settings updated'
    };
  }

  if (name === 'troubleshootingLibrary' && action === 'create') {
    return {
      actionType: 'ai_fix_saved_to_library',
      category: 'settings',
      summary: 'AI fix saved to troubleshooting library'
    };
  }

  return {
    actionType: `${name}_${action}`,
    category: 'settings',
    summary: `${action} ${name}/${id}`
  };
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
    const optimisticCreate =
      code.includes('permission-denied') &&
      isCompanyScopedCollection(name) &&
      !!basePayload.companyId;

    if (!optimisticCreate) throw error;
  }

  const nextPayload = withMeta(basePayload, user, action === 'create');

  if (isCompanyScopedCollection(name) && !nextPayload.companyId && !before?.companyId) {
    const scope = getActiveCompanyContext();
    throw new Error(`Missing company context for ${name}/${id}. Active company: ${scope.companyId || 'none'}.`);
  }

  await setDoc(ref, nextPayload, { merge: true });

  const after = { ...(before || {}), ...nextPayload };
  const audit = classifyAuditEvent(name, action, id, before, after);

  await logAudit({
    action,
    actionType: audit.actionType,
    category: audit.category,
    entityType: name,
    entityId: id,
    targetType: name,
    targetId: id,
    targetLabel: after?.name || after?.title || after?.email || id,
    summary: audit.summary,
    user,
    metadata: {
      status: after?.status || '',
      beforeStatus: before?.status || '',
      assignedWorkers: (after?.assignedWorkers || []).join(', '),
      companyId: nextPayload.companyId || after?.companyId || null
    }
  });
}

export async function deleteEntity(name, id, user) {
  const ref = doc(db, C[name], id);
  const before = (await getDoc(ref)).data() || null;
  await deleteDoc(ref);
  await logAudit({
    action: 'delete',
    entityType: name,
    entityId: id,
    summary: `delete ${name}/${id}`,
    user,
    before,
    after: null
  });
}

export async function loadUserProfile(uid) {
  const snap = await getDoc(doc(db, C.users, uid));
  return snap.exists() ? snap.data() : null;
}

export async function saveUserProfile(uid, profile, actor) {
  const ref = doc(db, C.users, uid);
  let before = null;

  try {
    before = (await getDoc(ref)).data() || null;
  } catch (error) {
    const code = `${error?.code || ''}`.toLowerCase();
    if (!code.includes('permission-denied')) throw error;
  }

  await setDoc(ref, withMeta({ id: uid, ...profile }, actor || { uid }, !before), { merge: true });

  try {
    await logAudit({
      action: before ? 'update' : 'create',
      entityType: 'users',
      entityId: uid,
      summary: 'user profile changed',
      user: actor || { uid },
      before,
      after: profile,
      scoped: false
    });
  } catch (error) {
    console.warn('[saveUserProfile] audit log skipped', error);
  }
}

export const defaultAiSettings = {
  aiEnabled: false,
  aiAutoAttach: false,
  aiUseInternalKnowledge: true,
  aiUseWebSearch: false,
  operationsWebResearchEnabled: false,
  aiAskFollowups: true,
  aiModel: 'gpt-4.1-mini',
  aiMaxWebSources: 3,
  aiConfidenceThreshold: 0.45,
  aiAllowManualRerun: true,
  aiAllowStaffManualRerun: false,
  aiAllowStaffSaveFixesToLibrary: false,
  aiSaveSuccessfulFixesToLibraryDefault: false,
  aiShortResponseMode: true,
  aiVerboseManagerMode: false,
  defaultTaskSeverity: 'medium',
  aiFeedbackCollectionEnabled: true,
  mobileConciseModeDefault: true,
  taskIntakeRequiredFields: ['assetId', 'description', 'reporter'],
  aiConfiguredExplicitly: false
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
