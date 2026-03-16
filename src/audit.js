import { addDoc, collection } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { db, serverTimestamp } from './firebase.js';
import { appConfig } from './config.js';
import { buildCompanyScopedPayload } from './companyScope.js';

function compactMetadata(input) {
  if (!input || typeof input !== 'object') return {};
  return Object.entries(input)
    .slice(0, 16)
    .reduce((acc, [key, value]) => {
      if (value == null) return acc;
      if (Array.isArray(value)) {
        acc[key] = value.slice(0, 8).map((item) => `${item}`.slice(0, 120));
        return acc;
      }
      if (typeof value === 'object') {
        acc[key] = '[object]';
        return acc;
      }
      acc[key] = `${value}`.slice(0, 240);
      return acc;
    }, {});
}

export async function logAudit({
  action,
  actionType,
  category = 'settings',
  entityType,
  entityId,
  targetType,
  targetId,
  targetLabel,
  summary,
  user,
  metadata = null,
  before = null,
  after = null,
  scoped = true
}) {
  const payload = {
    action: action || actionType || 'update',
    actionType: actionType || action || 'update',
    category,
    entityType: entityType || targetType || 'unknown',
    entityId: entityId || targetId || '',
    targetType: targetType || entityType || 'unknown',
    targetId: targetId || entityId || '',
    targetLabel: `${targetLabel || ''}`.trim(),
    summary: `${summary || ''}`.trim() || `${actionType || action || 'updated'} ${entityType || targetType || 'record'}`,
    actorUid: user?.uid || 'system',
    actorName: user?.displayName || user?.email || user?.uid || 'system',
    userUid: user?.uid || 'system',
    userIdentity: user?.email || user?.displayName || user?.uid || 'system',
    metadata: compactMetadata(metadata || {}),
    timestamp: serverTimestamp()
  };
  if (before || after) {
    payload.before = before || null;
    payload.after = after || null;
  }
  await addDoc(
    collection(db, appConfig.collections.auditLogs),
    scoped ? buildCompanyScopedPayload('auditLogs', payload) : payload
  );
}
