import { addDoc, collection } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { db, serverTimestamp } from './firebase.js';
import { appConfig } from './config.js';

export async function logAudit({ action, entityType, entityId, summary, user, before = null, after = null }) {
  await addDoc(collection(db, appConfig.collections.auditLogs), {
    action,
    entityType,
    entityId,
    summary,
    userUid: user?.uid || 'system',
    userIdentity: user?.email || user?.displayName || 'system',
    before,
    after,
    timestamp: serverTimestamp()
  });
}
