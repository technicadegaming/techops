import {
  createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut, updateProfile
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { auth } from './firebase.js';
import { appConfig } from './config.js';
import { loadUserProfile, saveUserProfile } from './data.js';

function buildProfilePersistenceError(error) {
  const detail = `${error?.message || error || ''}`.trim();
  return new Error(detail ? `Unable to save your profile. ${detail}` : 'Unable to save your profile.');
}

export async function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export async function register(email, password, profile = {}) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const fullName = `${profile.fullName || ''}`.trim();
  if (fullName) {
    await updateProfile(credential.user, { displayName: fullName });
  }
  try {
    await saveUserProfile(credential.user.uid, {
      email: `${credential.user.email || email || ''}`.trim().toLowerCase(),
      emailLower: `${credential.user.email || email || ''}`.trim().toLowerCase(),
      fullName,
      displayName: fullName || credential.user.email,
      memberLabel: fullName ? `${fullName} <${`${credential.user.email || email || ''}`.trim().toLowerCase()}>` : `${credential.user.email || email || ''}`.trim().toLowerCase(),
      enabled: true,
      onboardingState: 'needs_company_setup',
      suppressLegacyAutoAdopt: true
    }, { uid: credential.user.uid, email: credential.user.email || email });
  } catch (error) {
    throw buildProfilePersistenceError(error);
  }
  return credential;
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
      email: normalizedEmail,
      emailLower: normalizedEmail,
      fullName: user.displayName || '',
      displayName: user.displayName || user.email,
      memberLabel: user.displayName ? `${user.displayName} <${normalizedEmail}>` : normalizedEmail,
      role: shouldBootstrapAdmin ? 'admin' : 'pending',
      enabled: true,
      onboardingState: shouldBootstrapAdmin ? 'legacy_bootstrap' : 'needs_company_setup',
      legacyBootstrapEligible: shouldBootstrapAdmin,
      suppressLegacyAutoAdopt: !shouldBootstrapAdmin
    };
    try {
      await saveUserProfile(user.uid, profile, { uid: user.uid, email: user.email });
    } catch (error) {
      throw buildProfilePersistenceError(error);
    }
    isNewProfile = true;
  } else {
    const normalizedEmail = `${profile.email || user?.email || ''}`.trim().toLowerCase();
    const fullName = `${profile.fullName || profile.displayName || user?.displayName || ''}`.trim();
    const nextProfile = {
      ...profile,
      email: normalizedEmail,
      emailLower: normalizedEmail,
      fullName,
      displayName: `${profile.displayName || fullName || user?.email || ''}`.trim(),
      memberLabel: fullName ? `${fullName} <${normalizedEmail}>` : normalizedEmail
    };
    if (
      nextProfile.email !== profile.email
      || nextProfile.emailLower !== profile.emailLower
      || nextProfile.fullName !== profile.fullName
      || nextProfile.displayName !== profile.displayName
      || nextProfile.memberLabel !== profile.memberLabel
    ) {
      try {
        await saveUserProfile(user.uid, nextProfile, { uid: user.uid, email: user.email });
      } catch (error) {
        throw buildProfilePersistenceError(error);
      }
      profile = nextProfile;
    }
  }
  return { ...profile, isNewProfile };
}
