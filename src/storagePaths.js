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

export function buildCompanyManualPath(companyId, assetId, manualId, fileName = 'source.pdf') {
  const safeCompanyId = `${companyId || ''}`.trim();
  const safeAssetId = `${assetId || ''}`.trim();
  const safeManualId = `${manualId || ''}`.trim();
  if (!safeCompanyId) throw new Error('companyId is required for manual storage paths');
  if (!safeAssetId) throw new Error('assetId is required for manual storage paths');
  if (!safeManualId) throw new Error('manualId is required for manual storage paths');
  return ['companies', safeCompanyId, 'manuals', safeAssetId, safeManualId, `${fileName || 'source.pdf'}`.trim() || 'source.pdf'].join('/');
}

export function buildCompanyBrandingLogoPath(companyId, fileName = 'logo') {
  const safeCompanyId = `${companyId || ''}`.trim();
  const safeFileName = `${fileName || 'logo'}`.trim();
  if (!safeCompanyId) throw new Error('companyId is required for branding logo storage paths');
  return ['companies', safeCompanyId, 'branding', 'logo', safeFileName || 'logo'].join('/');
}
