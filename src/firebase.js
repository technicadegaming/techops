import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { getFirestore, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js';
import { getFunctions } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { appConfig } from './config.js';

if (!appConfig.firebase.projectId) {
  console.warn('Firebase config missing. Add window.__APP_CONFIG__ or edit src/config.js for local testing.');
}

const app = initializeApp(appConfig.firebase);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, 'us-central1');
export { serverTimestamp };
