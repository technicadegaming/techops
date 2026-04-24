import { renderAdmin } from '../admin.js';
import { createAdminActions } from '../features/adminActions.js';

export function createAdminController({
  state,
  render,
  refreshData,
  runAction,
  withRequiredCompanyId,
  upsertEntity,
  clearEntitySet,
  saveAppSettings,
  exportBackupJson,
  buildAssetsCsv,
  buildTasksCsv,
  buildAuditCsv,
  buildWorkersCsv,
  buildMembersCsv,
  buildInvitesCsv,
  buildLocationsCsv,
  buildCompanyBackupBundle,
  downloadFile,
  downloadJson,
  normalizeAssetId,
  enrichAssetDocumentation,
  createCompanyInvite,
  revokeInvite
}) {
  const createActions = () => createAdminActions({
    state,
    render,
    refreshData,
    runAction,
    withRequiredCompanyId,
    upsertEntity,
    clearEntitySet,
    saveAppSettings,
    exportBackupJson,
    buildAssetsCsv,
    buildTasksCsv,
    buildAuditCsv,
    buildWorkersCsv,
    buildMembersCsv,
    buildInvitesCsv,
    buildLocationsCsv,
    buildCompanyBackupBundle,
    downloadFile,
    downloadJson,
    normalizeAssetId,
    enrichAssetDocumentation,
    createCompanyInvite,
    revokeInvite
  });

  return {
    createActions,
    renderAdminSection: (element) => renderAdmin(element, state, createActions())
  };
}
