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
  repairAssetDocumentationState,
  bootstrapAttachAssetManualFromCsvHint,
  createCompanyInvite,
  revokeInvite,
  withGlobalBusy
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
    repairAssetDocumentationState,
    bootstrapAttachAssetManualFromCsvHint,
    createCompanyInvite,
    revokeInvite,
    withGlobalBusy
  });

  return {
    createActions,
    renderAdminSection: (element) => renderAdmin(element, state, createActions())
  };
}
