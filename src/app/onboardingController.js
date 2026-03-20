import { formatActionError } from '../uiActions.js';
import { createCompanyFromOnboarding, acceptInvite, createCompanyInvite } from '../company.js';
import { getWorkspaceReadiness } from '../features/workspaceReadiness.js';
import { parseAssetCsv, parseBulkAssetList, normalizeAssetCandidate } from '../features/assetIntake.js';
import { setOnboardingFeedback, setSetupWizardFeedback, syncSetupWizardState } from './state.js';

function clampSetupStep(step) {
  return Math.max(1, Math.min(6, Number(step) || 1));
}

export function createOnboardingController({
  state,
  runAction,
  render,
  refreshData,
  bootstrapCompanyContext,
  upsertEntity,
  saveAppSettings,
  withRequiredCompanyId,
  enrichAssetDocumentation
}) {
  return {
    createCompany: async (payload) => {
      await runAction('create_company', async () => {
        setOnboardingFeedback(state, 'Creating your workspace…', 'info', { pendingAction: 'create_company', handoffStatus: 'working' });
        render();
        await createCompanyFromOnboarding(state.user, payload);
        await bootstrapCompanyContext();
        await refreshData();
        render();
      }, {
        fallbackMessage: 'Unable to create company workspace.',
        onError: (error) => {
          setOnboardingFeedback(state, formatActionError(error, 'Unable to create company workspace.'), 'error', { pendingAction: '', handoffStatus: 'error' });
          render();
        }
      });
    },
    acceptInvite: async (inviteCode) => {
      await runAction('accept_invite', async () => {
        setOnboardingFeedback(state, 'Joining company…', 'info', { pendingAction: 'accept_invite', handoffStatus: 'working' });
        render();
        await acceptInvite({ inviteCode, user: state.user });
        await bootstrapCompanyContext();
        await refreshData();
        render();
      }, {
        fallbackMessage: 'Unable to accept invite.',
        onError: (error) => {
          setOnboardingFeedback(state, formatActionError(error, 'Unable to accept invite.'), 'error', { pendingAction: '', handoffStatus: 'error' });
          render();
        }
      });
    },
    setSetupStep: (step) => {
      state.setupWizard = { ...(state.setupWizard || {}), step: clampSetupStep(step), message: '', tone: 'info' };
      render();
    },
    skipSetupStep: async (step) => {
      state.setupWizard = { ...(state.setupWizard || {}), step: clampSetupStep((Number(step) || 1) + 1), message: 'Skipped for now. You can return to Admin anytime.', tone: 'info' };
      await refreshData();
      render();
    },
    dismissReadiness: async () => {
      const readiness = getWorkspaceReadiness(state);
      if (!readiness.requiredComplete) {
        setSetupWizardFeedback(state, 'Finish required readiness items before dismissing this checklist.', 'warn');
        render();
        return;
      }
      await saveAppSettings({ ...state.settings, workspaceReadinessDismissedAt: new Date().toISOString() }, state.user);
      await refreshData();
      render();
    },
    submitSetupStep: async (step, payload) => {
      await runAction('setup_wizard_step', async () => {
        setSetupWizardFeedback(state, '');
        const currentStep = Number(step) || 1;
        if (currentStep === 1) {
          await upsertEntity('companies', state.company.id, withRequiredCompanyId({
            ...state.company,
            name: `${payload.companyName || state.company?.name || ''}`.trim(),
            primaryEmail: `${payload.primaryEmail || ''}`.trim(),
            primaryPhone: `${payload.primaryPhone || ''}`.trim(),
            timeZone: `${payload.timeZone || state.company?.timeZone || 'UTC'}`.trim()
          }, 'save company basics'), state.user);
        }
        if (currentStep === 2) {
          const firstLocation = (state.companyLocations || [])[0];
          if (firstLocation?.id) {
            await upsertEntity('companyLocations', firstLocation.id, withRequiredCompanyId({
              ...firstLocation,
              name: `${payload.locationName || firstLocation.name || ''}`.trim(),
              address: `${payload.locationAddress || firstLocation.address || ''}`.trim(),
              timeZone: `${payload.locationTimeZone || firstLocation.timeZone || state.company?.timeZone || 'UTC'}`.trim()
            }, 'save first location'), state.user);
          }
        }
        if (currentStep === 3) {
          const ownerWorker = (state.workers || []).find((worker) => `${worker.email || ''}`.toLowerCase() === `${state.user?.email || ''}`.toLowerCase());
          if (ownerWorker?.id) {
            await upsertEntity('workers', ownerWorker.id, withRequiredCompanyId({
              ...ownerWorker,
              displayName: `${payload.ownerWorkerDisplayName || ownerWorker.displayName || ''}`.trim() || ownerWorker.displayName
            }, 'update owner worker record'), state.user);
          }
          const name = `${payload.newWorkerName || ''}`.trim();
          const email = `${payload.newWorkerEmail || ''}`.trim().toLowerCase();
          if (name) {
            await upsertEntity('workers', `worker-${Date.now().toString(36)}`, withRequiredCompanyId({
              displayName: name,
              email,
              role: 'staff',
              enabled: true,
              available: true
            }, 'create first worker'), state.user);
          }
          const inviteEmail = `${payload.inviteEmail || ''}`.trim().toLowerCase();
          if (inviteEmail) await createCompanyInvite({ companyId: state.company.id, email: inviteEmail, role: payload.inviteRole || 'staff', user: state.user });
        }
        if (currentStep === 4) {
          const defaultLocationName = `${payload.assetLocation || ''}`.trim();
          const manualCandidate = normalizeAssetCandidate({
            name: `${payload.assetName || ''}`.trim(),
            manufacturer: `${payload.assetManufacturer || ''}`.trim(),
            locationName: defaultLocationName
          }, { defaultLocationName });
          const csvResult = parseAssetCsv(`${payload.assetCsvText || ''}`, { defaultLocationName });
          const bulkResult = parseBulkAssetList(`${payload.assetBulkList || ''}`, { defaultLocationName });
          const validationErrors = [...csvResult.errors, ...bulkResult.errors];
          const intakeRows = [
            ...(manualCandidate.name ? [{ ...manualCandidate, source: 'manual', sourceRow: 1 }] : []),
            ...csvResult.rows,
            ...bulkResult.rows
          ];
          if (!intakeRows.length) {
            throw new Error('Add at least one asset manually, CSV, or paste list before continuing (or click Skip for now).');
          }
          if (validationErrors.length) {
            state.assetUi = {
              ...(state.assetUi || {}),
              onboardingValidationErrors: validationErrors,
              onboardingReviewQueue: intakeRows
            };
            throw new Error(`Please fix import errors before continuing: ${validationErrors[0]}`);
          }
          state.assetUi = {
            ...(state.assetUi || {}),
            onboardingValidationErrors: [],
            onboardingReviewQueue: intakeRows
          };
          for (const [index, row] of intakeRows.entries()) {
            const requestedId = index === 0 ? `${payload.assetId || ''}`.trim() : '';
            const id = requestedId || `asset-${row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(Date.now() + index).toString(36).slice(-4)}`;
            const manufacturer = row.manufacturer || row.manufacturerSuggestion || '';
            const category = row.category || row.categorySuggestion || '';
            const shouldReview = row.reviewNeeded || !!row.manufacturerSuggestion || !!row.categorySuggestion;
            await upsertEntity('assets', id, withRequiredCompanyId({
              id,
              name: row.name,
              manufacturer,
              model: row.model || '',
              category,
              locationName: row.locationName || defaultLocationName,
              serialNumber: row.serialNumber || '',
              status: 'active',
              reviewState: shouldReview ? 'pending_review' : 'ready',
              reviewReason: shouldReview ? 'onboarding_normalization' : '',
              enrichmentStatus: state.settings.aiEnabled ? 'queued' : 'unavailable_disabled',
              enrichmentRequestedAt: state.settings.aiEnabled ? new Date().toISOString() : null,
              enrichmentLastRunAt: null,
              manufacturerSuggestion: row.manufacturerSuggestion || '',
              categorySuggestion: row.categorySuggestion || '',
              normalizationConfidence: row.normalizationConfidence || 'low',
              importSource: row.source || 'manual'
            }, 'create first asset'), state.user);
            if (state.settings.aiEnabled) {
              enrichAssetDocumentation(id, { trigger: 'onboarding_asset_step' }).catch(() => {});
            }
          }
        }
        if (currentStep === 5) {
          await saveAppSettings({ ...state.settings, aiEnabled: payload.aiEnabled === 'yes', aiConfiguredExplicitly: true }, state.user);
        }
        if (currentStep === 6) {
          await upsertEntity('companies', state.company.id, withRequiredCompanyId({
            ...state.company,
            onboardingCompleted: true,
            onboardingCompletedAt: new Date().toISOString()
          }, 'launch workspace'), state.user);
        }
        await refreshData();
        if (currentStep === 4) {
          state.route = { ...(state.route || {}), tab: 'assets', assetId: null };
          state.setupWizard = { ...(state.setupWizard || {}), step: 5, message: 'Assets added. Review normalization and documentation suggestions in Assets.', tone: 'success' };
          syncSetupWizardState(state);
          render();
          return;
        }
        state.setupWizard = { ...(state.setupWizard || {}), step: Math.min(6, currentStep + 1), message: currentStep < 6 ? 'Saved. Continue to the next step.' : 'Workspace launched.', tone: 'success' };
        syncSetupWizardState(state);
        render();
      }, {
        fallbackMessage: 'Unable to save setup step.',
        onError: (error) => {
          setSetupWizardFeedback(state, formatActionError(error, 'Unable to save setup step.'), 'error');
          render();
        }
      });
    }
  };
}
