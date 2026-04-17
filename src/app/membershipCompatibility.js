function normalizeValue(value) {
  return `${value || ''}`.trim();
}

export function normalizeMembershipRecord(raw = {}, id = '') {
  const normalizedId = normalizeValue(raw.id) || normalizeValue(id);
  const companyId = normalizeValue(raw.companyId)
    || normalizeValue(raw.workspaceId)
    || normalizeValue(raw.workspace_id)
    || normalizeValue(raw.workspacesId);
  const userId = normalizeValue(raw.userId)
    || normalizeValue(raw.uid)
    || normalizeValue(raw.userUid)
    || normalizeValue(raw.memberUid)
    || normalizeValue(raw.memberId);
  const role = normalizeValue(raw.role)
    || normalizeValue(raw.companyRole)
    || normalizeValue(raw.workspaceRole)
    || 'staff';

  const rawStatus = normalizeValue(raw.status).toLowerCase();
  const explicitEnabled = raw.enabled === false || raw.isActive === false;
  const status = rawStatus || (explicitEnabled ? 'inactive' : 'active');

  return {
    id: normalizedId,
    ...raw,
    companyId,
    userId,
    role,
    status
  };
}

export function isActiveMembershipRecord(raw = {}) {
  const status = normalizeValue(raw.status).toLowerCase();
  if (!status) return raw.enabled !== false && raw.isActive !== false;
  return status === 'active';
}

export function normalizeMembershipRecords(rows = []) {
  const seen = new Set();
  const records = [];
  for (const row of rows || []) {
    const normalized = normalizeMembershipRecord(row, row?.id);
    if (!normalized.id || !normalized.companyId || !normalized.userId) continue;
    if (!isActiveMembershipRecord(normalized)) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    records.push(normalized);
  }
  return records;
}
