import { listAudit, listEntities, upsertEntity } from './data.js';

const EXPORT_COLLECTIONS = ['assets', 'tasks', 'operations', 'manuals', 'pmSchedules', 'notes', 'appSettings', 'users'];

function normalizeTimestamp(value) {
  if (!value) return '';
  if (typeof value?.toDate === 'function') {
    const parsed = value.toDate();
    return Number.isNaN(parsed?.getTime?.()) ? '' : parsed.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function toReadableBoolean(value) {
  return value ? 'Yes' : 'No';
}

function escapeCsvValue(value) {
  const raw = value === null || value === undefined ? '' : `${value}`;
  if (/[,"\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function buildCsv(columns = [], rows = []) {
  const header = columns.map((column) => escapeCsvValue(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => {
    const rawValue = typeof column.get === 'function' ? column.get(row) : row?.[column.key];
    return escapeCsvValue(rawValue);
  }).join(',')).join('\n');
  return [header, body].filter(Boolean).join('\n');
}

function baseExportMeta(company = {}) {
  return {
    exportedAt: new Date().toISOString(),
    companyId: company.id || company.companyId || null,
    companyName: company.name || '',
    formatVersion: 1
  };
}

export function buildAssetsCsv(assets = []) {
  const columns = [
    { label: 'Asset ID', key: 'id' },
    { label: 'Asset Name', key: 'name' },
    { label: 'Status', key: 'status' },
    { label: 'Category', key: 'category' },
    { label: 'Manufacturer', key: 'manufacturer' },
    { label: 'Model', key: 'model' },
    { label: 'Serial Number', key: 'serialNumber' },
    { label: 'Location', key: 'locationName' },
    { label: 'Zone', key: 'zone' },
    { label: 'Manual Links', get: (row) => (row.manualLinks || []).join(' | ') },
    { label: 'Notes', key: 'notes' },
    { label: 'Created At', get: (row) => normalizeTimestamp(row.createdAt || row.createdAtClient) },
    { label: 'Updated At', get: (row) => normalizeTimestamp(row.updatedAt || row.updatedAtClient) }
  ];
  return buildCsv(columns, assets);
}

export function buildTasksCsv(tasks = []) {
  const columns = [
    { label: 'Task ID', key: 'id' },
    { label: 'Title', key: 'title' },
    { label: 'Status', key: 'status' },
    { label: 'Priority', key: 'priority' },
    { label: 'Severity', key: 'severity' },
    { label: 'Asset ID', key: 'assetId' },
    { label: 'Asset Name', key: 'assetName' },
    { label: 'Location', key: 'locationName' },
    { label: 'Assigned Workers', get: (row) => (row.assignedWorkers || []).join(' | ') },
    { label: 'Reported By', key: 'reporter' },
    { label: 'Opened At', get: (row) => normalizeTimestamp(row.openedAt || row.createdAtClient || row.createdAt) },
    { label: 'Due At', get: (row) => normalizeTimestamp(row.dueDate || row.dueAt) },
    { label: 'Closed At', get: (row) => normalizeTimestamp(row.completedAt) },
    { label: 'Summary', get: (row) => row.description || row.summary || '' }
  ];
  return buildCsv(columns, tasks);
}

export function buildAuditCsv(entries = []) {
  const columns = [
    { label: 'When', get: (row) => normalizeTimestamp(row.timestamp) },
    { label: 'Action', get: (row) => row.actionType || row.action || '' },
    { label: 'Category', key: 'category' },
    { label: 'Summary', key: 'summary' },
    { label: 'Entity Type', key: 'entityType' },
    { label: 'Entity ID', key: 'entityId' },
    { label: 'Target Label', key: 'targetLabel' },
    { label: 'Actor', get: (row) => row.actorName || row.userIdentity || row.userUid || '' }
  ];
  return buildCsv(columns, entries);
}

export function buildWorkersCsv(workers = []) {
  const columns = [
    { label: 'Worker ID', key: 'id' },
    { label: 'Display Name', key: 'displayName' },
    { label: 'Email', key: 'email' },
    { label: 'Role', key: 'role' },
    { label: 'Enabled', get: (row) => toReadableBoolean(row.enabled !== false) },
    { label: 'Available', get: (row) => toReadableBoolean(row.available !== false) },
    { label: 'Location', key: 'locationName' },
    { label: 'Skills', get: (row) => (row.skills || []).join(' | ') },
    { label: 'Phone', key: 'phone' },
    { label: 'Created At', get: (row) => normalizeTimestamp(row.createdAt) },
    { label: 'Updated At', get: (row) => normalizeTimestamp(row.updatedAt) }
  ];
  return buildCsv(columns, workers);
}

export function buildMembersCsv(members = []) {
  const columns = [
    { label: 'Membership ID', key: 'id' },
    { label: 'User ID', key: 'userId' },
    { label: 'Role', key: 'role' },
    { label: 'Status', key: 'status' },
    { label: 'Invite ID', key: 'inviteId' },
    { label: 'Created At', get: (row) => normalizeTimestamp(row.createdAt) },
    { label: 'Updated At', get: (row) => normalizeTimestamp(row.updatedAt) }
  ];
  return buildCsv(columns, members);
}

export function buildInvitesCsv(invites = []) {
  const columns = [
    { label: 'Invite ID', key: 'id' },
    { label: 'Email', key: 'email' },
    { label: 'Role', key: 'role' },
    { label: 'Status', key: 'status' },
    { label: 'Created At', get: (row) => normalizeTimestamp(row.createdAt) },
    { label: 'Updated At', get: (row) => normalizeTimestamp(row.updatedAt) },
    { label: 'Accepted At', get: (row) => normalizeTimestamp(row.acceptedAt) }
  ];
  return buildCsv(columns, invites);
}

export function buildLocationsCsv(locations = []) {
  const columns = [
    { label: 'Location ID', key: 'id' },
    { label: 'Name', key: 'name' },
    { label: 'Code', key: 'code' },
    { label: 'Type', key: 'type' },
    { label: 'Address', key: 'address' },
    { label: 'City', key: 'city' },
    { label: 'State', key: 'state' },
    { label: 'Postal Code', key: 'postalCode' },
    { label: 'Time Zone', key: 'timeZone' },
    { label: 'Created At', get: (row) => normalizeTimestamp(row.createdAt) },
    { label: 'Updated At', get: (row) => normalizeTimestamp(row.updatedAt) }
  ];
  return buildCsv(columns, locations);
}

function sanitizeInvitesForBundle(invites = []) {
  return invites.map((invite) => ({
    id: invite.id,
    email: invite.email || '',
    role: invite.role || '',
    status: invite.status || '',
    acceptedAt: normalizeTimestamp(invite.acceptedAt),
    createdAt: normalizeTimestamp(invite.createdAt),
    updatedAt: normalizeTimestamp(invite.updatedAt)
  }));
}

export function buildCompanyBackupBundle({ company = {}, assets = [], tasks = [], auditEntries = [], companyMembers = [], workers = [], invites = [], locations = [] } = {}) {
  return {
    ...baseExportMeta(company),
    summary: {
      assets: assets.length,
      tasks: tasks.length,
      auditEntries: auditEntries.length,
      members: companyMembers.length,
      workers: workers.length,
      invites: invites.length,
      locations: locations.length
    },
    data: {
      company: {
        id: company.id || null,
        name: company.name || '',
        primaryEmail: company.primaryEmail || '',
        primaryPhone: company.primaryPhone || '',
        timeZone: company.timeZone || '',
        businessType: company.businessType || '',
        industry: company.industry || ''
      },
      assets,
      tasks,
      auditLog: auditEntries,
      members: companyMembers,
      workers,
      invites: sanitizeInvitesForBundle(invites),
      locations
    }
  };
}

export async function exportBackupJson() {
  const data = {};
  for (const c of EXPORT_COLLECTIONS) data[c] = await listEntities(c).catch(() => []);
  return { exportedAt: new Date().toISOString(), version: 1, data };
}

export async function exportCompanyScopedBackupJson({ company = null } = {}) {
  const [assets, tasks, workers, locations, invites, auditEntries] = await Promise.all([
    listEntities('assets').catch(() => []),
    listEntities('tasks').catch(() => []),
    listEntities('workers').catch(() => []),
    listEntities('companyLocations').catch(() => []),
    listEntities('companyInvites').catch(() => []),
    listAudit().catch(() => [])
  ]);
  return buildCompanyBackupBundle({
    company: company || {},
    assets,
    tasks,
    auditEntries,
    workers,
    invites,
    locations,
    companyMembers: []
  });
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
