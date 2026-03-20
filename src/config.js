// Centralized runtime config.
// Safe to commit: Firebase web client config and other non-privileged defaults required by the browser app.
// Must be supplied explicitly at runtime: any environment-specific operational overrides, including bootstrap admin emails.
const defaults = {
  firebase: {
    apiKey: 'AIzaSyAzTD9O87wTEhBlWdmDr5fbgES8o7a2Hbg',
    authDomain: 'scootbusiness-d3112.firebaseapp.com',
    projectId: 'scootbusiness-d3112',
    storageBucket: 'scootbusiness-d3112.firebasestorage.app',
    messagingSenderId: '257947502595',
    appId: '1:257947502595:web:43fc4fc28bd69bac69a636'
  },
  bootstrapAdmins: [],
  billing: {
    trialLengthDays: 21
  },
  collections: {
    users: 'users', assets: 'assets', tasks: 'tasks', operations: 'operations', manuals: 'manuals',
    pmSchedules: 'pmSchedules', notes: 'notes', auditLogs: 'auditLogs', appSettings: 'appSettings',
    backups: 'backups', taskAiRuns: 'taskAiRuns', taskAiFollowups: 'taskAiFollowups', troubleshootingLibrary: 'troubleshootingLibrary', aiWebContextCache: 'aiWebContextCache',
    companies: 'companies', companyMemberships: 'companyMemberships', companyInvites: 'companyInvites', companyLocations: 'companyLocations', workers: 'workers', importHistory: 'importHistory', notifications: 'notifications'
  }
};

function normalizeBootstrapAdmins(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((email) => `${email || ''}`.trim().toLowerCase())
      .filter(Boolean)
  ));
}

const runtimeConfig = window.__APP_CONFIG__ || {};

export const appConfig = {
  ...defaults,
  ...runtimeConfig,
  bootstrapAdmins: normalizeBootstrapAdmins(runtimeConfig.bootstrapAdmins),
  firebase: { ...defaults.firebase, ...(runtimeConfig.firebase || {}) },
  collections: { ...defaults.collections, ...(runtimeConfig.collections || {}) },
  billing: { ...defaults.billing, ...(runtimeConfig.billing || {}) }
};

export function isBootstrapAdminEmail(email) {
  const normalizedEmail = `${email || ''}`.trim().toLowerCase();
  if (!normalizedEmail) return false;
  return appConfig.bootstrapAdmins.includes(normalizedEmail);
}
