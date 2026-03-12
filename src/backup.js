import { listEntities, upsertEntity } from './data.js';

const EXPORT_COLLECTIONS = ['assets', 'tasks', 'operations', 'manuals', 'pmSchedules', 'notes', 'appSettings', 'users'];

export async function exportBackupJson() {
  const data = {};
  for (const c of EXPORT_COLLECTIONS) data[c] = await listEntities(c).catch(() => []);
  return { exportedAt: new Date().toISOString(), version: 1, data };
}

export function validateBackup(payload) {
  if (!payload || typeof payload !== 'object' || !payload.data) return { ok: false, errors: ['Missing data root'] };
  const errors = [];
  for (const c of EXPORT_COLLECTIONS) {
    if (payload.data[c] && !Array.isArray(payload.data[c])) errors.push(`${c} must be an array`);
  }
  return { ok: errors.length === 0, errors };
}

export function dryRunBackup(payload) {
  return Object.fromEntries(Object.entries(payload.data || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
}

export async function restoreBackup(payload, user) {
  for (const [collectionName, rows] of Object.entries(payload.data || {})) {
    for (const row of rows || []) {
      if (!row.id) continue;
      await upsertEntity(collectionName, row.id, { ...row, restoredAt: new Date().toISOString() }, user);
    }
  }
}
