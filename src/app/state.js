import { buildPermissionContext } from '../roles.js';
import { parseRouteState } from '../features/workflow.js';
import { getWorkspaceReadiness } from '../features/workspaceReadiness.js';

export const ACTIVE_MEMBERSHIP_STORAGE_KEY = 'techops.activeMembership';
export const sections = ['dashboard', 'operations', 'assets', 'calendar', 'reports', 'account', 'admin'];

export function createEmptyAssetDraft() {
  return {
    name: '', serialNumber: '', manufacturer: '', id: '', status: '', ownerWorkers: '', manualLinksText: '', historyNote: '', imageRefsText: '', videoRefsText: '', evidenceRefsText: '', notes: '',
    manualLinks: [], supportResources: [], supportContacts: [], preview: null, previewStatus: 'idle', previewMeta: { inFlightQuery: '', lastCompletedQuery: '' }, draftNameNormalized: '',
    normalizedName: '', manualSourceUrl: '', supportEmail: '', supportPhone: '', supportUrl: '', matchConfidence: '', matchNotes: '', alternateNamesText: '',
    saveFeedback: '', saveSecondaryFeedback: '', saveDebugContext: '', saveFeedbackTone: 'success', saving: false
  };
}

export function buildPreviewQueryKey(payload = {}) {
  const assetName = `${payload.assetName || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const manufacturer = `${payload.manufacturer || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const serialNumber = `${payload.serialNumber || ''}`.trim().toLowerCase();
  const assetId = `${payload.assetId || ''}`.trim().toLowerCase();
  const followupAnswer = `${payload.followupAnswer || ''}`.trim().toLowerCase();
  return [assetName, manufacturer, serialNumber, assetId, followupAnswer].join('|');
}

export function setOnboardingFeedback(state, message = '', tone = 'info', extra = {}) {
  state.onboardingUi = { ...(state.onboardingUi || {}), message, tone, ...extra };
}

export function setSetupWizardFeedback(state, message = '', tone = 'info') {
  state.setupWizard = { ...(state.setupWizard || {}), message, tone };
}

export function syncSetupWizardState(state) {
  const readiness = getWorkspaceReadiness(state);
  const dismissed = !!state.settings?.workspaceReadinessDismissedAt;
  const shouldShow = !!state.company?.id && !state.onboardingRequired && readiness.needsSetupWizard && !dismissed;
  state.setupWizard = {
    ...(state.setupWizard || {}),
    active: shouldShow,
    step: state.setupWizard?.step || 1
  };
  if (!shouldShow) state.setupWizard = { ...(state.setupWizard || {}), active: false, message: '', tone: 'info' };
}

export function createInitialState() {
  return {
    user: null, profile: null, company: null, memberships: [], membershipCompanies: {}, activeMembership: null,
    permissions: buildPermissionContext(), onboardingRequired: false, tasks: [], operations: [], assets: [], pmSchedules: [], manuals: [], notes: [], users: [], companyMembers: [], workers: [], invites: [],
    companyLocations: [], importHistory: [], auditLogs: [], taskAiRuns: [], taskAiFollowups: [], troubleshootingLibrary: [], notifications: [], notificationPrefs: { enabledTypes: [] }, settings: {},
    restorePayload: null, route: parseRouteState(), assetDraft: createEmptyAssetDraft(), assetUi: { lastActionByAsset: {}, onboardingReviewQueue: [], onboardingValidationErrors: [], bulkIntakeText: '', bulkIntakeRows: [], bulkIntakeErrors: [], bulkIntakeStatus: 'idle', searchQuery: '', statusFilter: 'all', reviewFilter: 'all', enrichmentFilter: 'all' },
    adminUi: { tone: 'info', message: '', importPreview: '', importSummary: '', importTone: 'info', assetReviewFilter: 'pending_review', assetReviewSearch: '', selectedAssetReviewIds: [], selectedSuggestionsByAsset: {} },
    operationsUi: { draft: {}, moreDetailsOpen: false, expandedTaskIds: [], scrollY: 0, statusFilter: 'open', ownershipFilter: 'all', exceptionFilter: 'all', taskSearch: '', assigneeFilter: 'all', lastSaveFeedback: '', lastSaveTone: 'info', aiTaskStates: {}, evidenceUploadsByTask: {}, lastSavedTaskId: null },
    adminSection: 'company', onboardingUi: { tone: 'info', message: '', pendingAction: '', handoffStatus: 'idle' }, setupWizard: { active: false, step: 1, message: '', tone: 'info' }
  };
}
