import {
  createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { auth } from './firebase.js';
import { appConfig } from './config.js';
import { loadUserProfile, saveUserProfile } from './data.js';

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
    const normalizedEmail = `${user?.email || ''}`.trim().toLowerCase();
    const shouldBootstrapAdmin = appConfig.bootstrapAdmins
      .map((email) => `${email || ''}`.trim().toLowerCase())
      .includes(normalizedEmail);
    profile = {
      email: user.email,
      displayName: user.displayName || user.email,
      role: shouldBootstrapAdmin ? 'admin' : 'staff',
      enabled: true,
      onboardingState: shouldBootstrapAdmin ? 'legacy_bootstrap' : 'needs_company_setup',
      legacyBootstrapEligible: shouldBootstrapAdmin,
      suppressLegacyAutoAdopt: !shouldBootstrapAdmin
    };
    await saveUserProfile(user.uid, profile, { uid: user.uid, email: user.email });
    isNewProfile = true;
  }
  return { ...profile, isNewProfile };
}
