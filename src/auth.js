import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import { auth } from './firebase.js';
import { isBootstrapAdminEmail } from './config.js';
import { loadUserProfile, saveUserProfile } from './data.js';

function buildProfilePersistenceError(error) {
  const detail = `${error?.message || error || ''}`.trim();
  return new Error(detail ? `Unable to save your profile. ${detail}` : 'Unable to save your profile.');
}

function isPermissionDenied(error) {
  const code = `${error?.code || ''}`.trim().toLowerCase();
  const message = `${error?.message || ''}`.trim().toLowerCase();
  return code.includes('permission-denied') || message.includes('missing or insufficient permissions');
}

async function saveUserProfileBestEffort(uid, profile, actor) {
  try {
    await saveUserProfile(uid, profile, actor);
    return true;
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    console.warn('[auth] Skipping profile persistence because Firestore denied the write.', {
      uid,
      code: error?.code || '',
      message: error?.message || String(error)
    });
    return false;
  }
}

export async function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider);
}

export async function sendForgotPasswordEmail(email) {
  if (!`${email || ''}`.trim()) throw new Error('Enter your email address first.');
  await sendPasswordResetEmail(auth, `${email}`.trim());
}

export async function resendVerificationEmail() {
  if (!auth.currentUser) throw new Error('No authenticated user found.');
  await sendEmailVerification(auth.currentUser);
}

export async function refreshAuthUser() {
  if (!auth.currentUser) return null;
  await reload(auth.currentUser);
  return auth.currentUser;
}

export async function register(email, password, profile = {}) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const fullName = `${profile.fullName || ''}`.trim();
  if (fullName) {
    await updateProfile(credential.user, { displayName: fullName });
  }
  try {
    await saveUserProfileBestEffort(credential.user.uid, {
      email: `${credential.user.email || email || ''}`.trim().toLowerCase(),
      emailLower: `${credential.user.email || email || ''}`.trim().toLowerCase(),
      fullName,
      displayName: fullName || credential.user.email,
      memberLabel: fullName ? `${fullName} <${`${credential.user.email || email || ''}`.trim().toLowerCase()}>` : `${credential.user.email || email || ''}`.trim().toLowerCase(),
      role: 'pending',
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

function summarizeProviders(user) {
  const providerIds = (user?.providerData || [])
    .map((provider) => `${provider?.providerId || ''}`.trim())
    .filter(Boolean);
  if (!providerIds.length) return ['password'];
  return Array.from(new Set(providerIds.map((providerId) => (providerId === 'google.com' ? 'google' : providerId))));
}

export async function syncSecuritySnapshot(user, profile = {}) {
  if (!user?.uid) return profile;
  const current = await loadUserProfile(user.uid);
  const base = current || profile || {};
  const history = Array.isArray(base.securityLoginHistory) ? base.securityLoginHistory : [];
  const entry = {
    at: new Date().toISOString(),
    method: summarizeProviders(user).includes('google') ? 'google' : 'password',
    providers: summarizeProviders(user)
  };
  const nextProfile = {
    ...base,
    email: `${base.email || user.email || ''}`.trim().toLowerCase(),
    emailLower: `${base.emailLower || user.email || ''}`.trim().toLowerCase(),
    emailVerified: !!user.emailVerified,
    authProviders: summarizeProviders(user),
    lastLoginAt: entry.at,
    securityMfaEnrolled: Array.isArray(user.multiFactor?.enrolledFactors) && user.multiFactor.enrolledFactors.length > 0,
    securityLoginHistory: [entry, ...history].slice(0, 10)
  };
  await saveUserProfileBestEffort(user.uid, nextProfile, { uid: user.uid, email: user.email });
  return nextProfile;
}

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function resolveProfile(user) {
  let profile = await loadUserProfile(user.uid);
  let isNewProfile = false;
  if (!profile) {
    const normalizedEmail = `${user?.email || ''}`.trim().toLowerCase();
    const shouldBootstrapAdmin = isBootstrapAdminEmail(normalizedEmail);
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
      await saveUserProfileBestEffort(user.uid, profile, { uid: user.uid, email: user.email });
    } catch (error) {
      throw buildProfilePersistenceError(error);
    }
    isNewProfile = true;
  } else {
    const hasExplicitRole = Object.prototype.hasOwnProperty.call(profile, 'role');
    const persistedRole = hasExplicitRole ? profile.role : `${profile.role || ''}`.trim() || 'pending';
    const normalizedEmail = `${profile.email || user?.email || ''}`.trim().toLowerCase();
    const fullName = `${profile.fullName || profile.displayName || user?.displayName || ''}`.trim();
    const nextProfile = {
      ...profile,
      email: normalizedEmail,
      emailLower: normalizedEmail,
      role: persistedRole,
      fullName,
      displayName: `${profile.displayName || fullName || user?.email || ''}`.trim(),
      memberLabel: fullName ? `${fullName} <${normalizedEmail}>` : normalizedEmail
    };
    if (
      nextProfile.email !== profile.email
      || nextProfile.emailLower !== profile.emailLower
      || nextProfile.role !== profile.role
      || nextProfile.fullName !== profile.fullName
      || nextProfile.displayName !== profile.displayName
      || nextProfile.memberLabel !== profile.memberLabel
    ) {
      try {
        await saveUserProfileBestEffort(user.uid, nextProfile, { uid: user.uid, email: user.email });
      } catch (error) {
        throw buildProfilePersistenceError(error);
      }
      profile = nextProfile;
    }
  }
  return { ...profile, isNewProfile };
}
