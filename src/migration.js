import { upsertEntity } from './data.js';

const LEGACY_KEYS = ['assets', 'tasks', 'operations', 'manuals', 'pmSchedules', 'notes'];

function parseLegacy(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
}

export function previewLegacyImport() {
  const preview = {};
  for (const key of LEGACY_KEYS) preview[key] = parseLegacy(key).length;
  return preview;
}

export async function importLegacyData(user) {
  for (const key of LEGACY_KEYS) {
    const rows = parseLegacy(key);
    for (const row of rows) {
      const id = row.id || `${key}-${crypto.randomUUID()}`;
      await upsertEntity(key, id, { ...row, id, migratedFromLocal: true }, user);
    }
  }
}
