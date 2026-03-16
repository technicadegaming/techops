import { addDoc, collection } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { db, serverTimestamp } from './firebase.js';
import { appConfig } from './config.js';
import { buildCompanyScopedPayload } from './companyScope.js';

export async function logAudit({ action, entityType, entityId, summary, user, before = null, after = null, scoped = true }) {
  const payload = {
    action,
    entityType,
    entityId,
    summary,
    userUid: user?.uid || 'system',
    userIdentity: user?.email || user?.displayName || 'system',
    before,
    after,
    timestamp: serverTimestamp()
  };
  await addDoc(
    collection(db, appConfig.collections.auditLogs),
    scoped ? buildCompanyScopedPayload('auditLogs', payload) : payload
  );
}
