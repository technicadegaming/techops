// Centralized runtime config: inject values with window.__APP_CONFIG__ before app boot if needed.
const defaults = {
  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: ''
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
