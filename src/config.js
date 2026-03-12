// Centralized runtime config: inject values with window.__APP_CONFIG__ before app boot if needed.
const defaults = {
  firebase: {
    apiKey: 'AIzaSyAzTD9O87wTEhBlWdmDr5fbgES8o7a2Hbg',
    authDomain: 'scootbusiness-d3112.firebaseapp.com',
    projectId: 'scootbusiness-d3112',
    storageBucket: 'scootbusiness-d3112.firebasestorage.app',
    messagingSenderId: '257947502595',
    appId: '1:257947502595:web:43fc4fc28bd69bac69a636'
  },
  bootstrapAdmins: ['owner@example.com'],
  collections: {
    users: 'users', assets: 'assets', tasks: 'tasks', operations: 'operations', manuals: 'manuals',
    pmSchedules: 'pmSchedules', notes: 'notes', auditLogs: 'auditLogs', appSettings: 'appSettings',
    backups: 'backups', taskAiRuns: 'taskAiRuns', troubleshootingLibrary: 'troubleshootingLibrary'
  }
};

export const appConfig = {
  ...defaults,
  ...(window.__APP_CONFIG__ || {}),
  firebase: { ...defaults.firebase, ...((window.__APP_CONFIG__ || {}).firebase || {}) },
  collections: { ...defaults.collections, ...((window.__APP_CONFIG__ || {}).collections || {}) }
};
