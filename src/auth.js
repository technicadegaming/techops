import {
  createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { auth } from './firebase.js';
import { appConfig } from './config.js';
import { loadUserProfile, saveUserProfile, listEntities } from './data.js';

export async function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export async function register(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

export async function logout() {
  return signOut(auth);
}

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function resolveProfile(user) {
  let profile = await loadUserProfile(user.uid);
  let isNewProfile = false;
  if (!profile) {
    const users = await listEntities('users').catch(() => []);
    const shouldBootstrapAdmin = users.length === 0 || appConfig.bootstrapAdmins.includes(user.email);
    profile = {
      email: user.email,
      displayName: user.displayName || user.email,
      role: shouldBootstrapAdmin ? 'admin' : 'staff',
      enabled: true
    };
    await saveUserProfile(user.uid, profile, { uid: user.uid, email: user.email });
    isNewProfile = true;
  }
  return { ...profile, isNewProfile };
}
