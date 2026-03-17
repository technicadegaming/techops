export function buildCompanyEvidencePath(companyId, ...segments) {
  const safeCompanyId = `${companyId || ''}`.trim();
  if (!safeCompanyId) throw new Error('companyId is required for evidence storage paths');
  return ['companies', safeCompanyId, 'evidence', ...segments.filter(Boolean)].join('/');
}

export function buildCompanyBackupPath(companyId, ...segments) {
  const safeCompanyId = `${companyId || ''}`.trim();
  if (!safeCompanyId) throw new Error('companyId is required for backup storage paths');
  return ['companies', safeCompanyId, 'backups', ...segments.filter(Boolean)].join('/');
}
