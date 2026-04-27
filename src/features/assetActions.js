import { buildDocumentationApprovalPatch, buildDocumentationApprovalSelection, deriveManualStatus } from './documentationReview.js';
import { buildAssetCsv, buildAssetImportRow, enrichAssetIntakeRows, parseTitleBulkInput } from './assetIntake.js';
import {
  approveSuggestedManualSources,
  buildFollowupEnrichmentRequest,
  buildFollowupRetryWithoutAnswerRequest,
  buildManualEnrichmentRequest
} from './assetEnrichmentPipeline.js';
import {
  buildAssetDraftContextDebug,
  doesPreviewContextMatch,
  resolveAssetDraftContext
} from './assetDraftContext.js';
import { normalizeManufacturerDisplayName } from './manufacturerNormalization.js';
import { findAssetByRecordId, getAssetRecordId } from './assetIdentity.js';

export function createAssetActions(deps) {
  const {
    state,
    onLocationFilter,
    render,
    refreshData,
    withRequiredCompanyId,
    upsertEntity,
    deleteEntity,
    approveAssetManual,
    attachAssetManualFromUrl,
    attachAssetManualFromStoragePath,
    repairAssetDocumentationState,
    enrichAssetDocumentation,
    previewAssetDocumentationLookup,
    researchAssetTitles,
    storage,
    storageRef,
    uploadBytes,
    markAssetEnrichmentFailure,
    normalizeAssetId,
    pickUniqueAssetId,
    createEmptyAssetDraft,
    withTimeout,
    normalizeSupportEntries,
    canDelete,
    isAdmin,
    isManager,
    buildAssetSaveErrorMessage,
    buildAssetSaveDebugContext,
    isPermissionRelatedError,
    withGlobalBusy
  } = deps;
  const safeWithGlobalBusy = typeof withGlobalBusy === 'function'
    ? withGlobalBusy
    : async (_title, _detail, fn) => fn();

  const parseReferenceList = (value = '') => `${value || ''}`
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const parseMaintenanceChecklist = (value = '') => `${value || ''}`
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
  const parseMaintenanceIntervalDays = (value) => {
    const parsed = Number.parseInt(`${value ?? ''}`.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.min(parsed, 3650);
  };
  const parseMaintenancePlanPatch = (payload = {}, current = {}) => {
    const intervalDays = parseMaintenanceIntervalDays(payload.maintenanceIntervalDays ?? current?.maintenancePlan?.intervalDays);
    const checklist = parseMaintenanceChecklist(payload.maintenanceChecklist ?? current?.maintenancePlan?.checklist?.join('\n'));
    const jobPlanSummary = `${payload.maintenanceJobPlan || current?.maintenancePlan?.jobPlanSummary || ''}`.trim();
    return {
      intervalDays,
      checklist,
      jobPlanSummary,
      updatedAt: new Date().toISOString(),
      ...(current?.maintenancePlan?.lastCompletedAt ? { lastCompletedAt: current.maintenancePlan.lastCompletedAt } : {}),
      ...(current?.maintenancePlan?.nextDueAt ? { nextDueAt: current.maintenancePlan.nextDueAt } : {})
    };
  };
  const ACTIVE_ENRICHMENT_STATUSES = new Set(['searching_docs', 'in_progress']);
  const IN_PROGRESS_ENRICHMENT_STATUSES = new Set(['queued', 'searching_docs', 'in_progress']);
  const LOWER_STATUS_LABELS = {
    queued: 'queued',
    searching_docs: 'searching',
    in_progress: 'searching',
    docs_found: 'docs found / attached',
    verified_manual_found: 'docs found / attached',
    followup_needed: 'follow-up needed',
    no_match_yet: 'no match yet',
    deterministic_search_no_results: 'no match yet',
    deterministic_search_no_results_found: 'no match yet',
    deterministic_search_no_results_terminal: 'no match yet',
    title_page_found_manual_probe_failed: 'follow-up needed',
    no_candidate_selected: 'follow-up needed',
    idle: 'not started'
  };
  const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  const MAX_MANUAL_UPLOAD_BYTES = 25 * 1024 * 1024;
  const ALLOWED_MANUAL_FILE_EXTENSIONS = new Set(['pdf', 'txt', 'html', 'htm', 'doc', 'docx']);

  const normalizeStatusKey = (value = '') => `${value || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const buildAssetLookupMaps = (assets = []) => {
    const byId = new Map();
    const byStableKey = new Map();
    (Array.isArray(assets) ? assets : []).forEach((asset) => {
      const recordId = getAssetRecordId(asset);
      if (recordId) byId.set(recordId, asset);
      const key = `${asset?.name || ''}|${asset?.manufacturer || ''}`.trim().toLowerCase();
      if (key && !byStableKey.has(key)) byStableKey.set(key, asset);
    });
    return { byId, byStableKey };
  };
  const findLinkedAssetForRow = (row = {}, maps = buildAssetLookupMaps([])) => {
    if (row.assetId && maps.byId.has(row.assetId)) return maps.byId.get(row.assetId);
    const stableKey = `${row?.name || ''}|${row?.manufacturer || row?.manufacturerSuggestion || ''}`.trim().toLowerCase();
    if (stableKey && maps.byStableKey.has(stableKey)) return maps.byStableKey.get(stableKey);
    return null;
  };
  const mapLowerRowStatus = (asset = {}) => {
    const rawStatus = normalizeStatusKey(asset?.enrichmentStatus || 'idle') || 'idle';
    const manualReviewState = normalizeStatusKey(asset?.manualReviewState || '');
    const reviewState = normalizeStatusKey(asset?.reviewState || '');
    let statusKey = rawStatus;
    if (!IN_PROGRESS_ENRICHMENT_STATUSES.has(rawStatus) && rawStatus !== 'idle') statusKey = rawStatus;
    if (manualReviewState === 'queued_for_review' || reviewState === 'pending_review') statusKey = 'followup_needed';
    if ((asset?.manualLibraryRef || asset?.manualStoragePath || (Array.isArray(asset?.manualLinks) && asset.manualLinks.length)) && IN_PROGRESS_ENRICHMENT_STATUSES.has(statusKey)) {
      statusKey = 'docs_found';
    }
    return {
      linkedAssetId: getAssetRecordId(asset) || '',
      enrichmentStatus: asset?.enrichmentStatus || 'idle',
      intakeStatusBadge: IN_PROGRESS_ENRICHMENT_STATUSES.has(statusKey) ? (statusKey === 'queued' ? 'queued' : 'searching') : statusKey,
      intakeStatusLabel: LOWER_STATUS_LABELS[statusKey] || statusKey.replace(/_/g, ' '),
      reviewState: asset?.reviewState || '',
      manualReviewState: asset?.manualReviewState || ''
    };
  };
  const reconcileIntakeRowsFromAssets = (rows = [], assets = []) => {
    const maps = buildAssetLookupMaps(assets);
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const linked = findLinkedAssetForRow(row, maps);
      if (!linked) return row;
      return { ...row, assetId: getAssetRecordId(linked), ...mapLowerRowStatus(linked) };
    });
  };

  const setAssetActionFeedback = (assetId, message, tone = 'info') => {
    state.assetUi = {
      ...(state.assetUi || {}),
      lastActionByAsset: {
        ...((state.assetUi && state.assetUi.lastActionByAsset) || {}),
        [assetId]: { message, tone }
      }
    };
  };
  const setFollowupUiState = (assetId, next = {}) => {
    const key = `${assetId || ''}`.trim();
    if (!key) return;
    state.assetUi = {
      ...(state.assetUi || {}),
      followupByAsset: {
        ...((state.assetUi && state.assetUi.followupByAsset) || {}),
        [key]: {
          ...(((state.assetUi && state.assetUi.followupByAsset) || {})[key] || {}),
          ...next,
        }
      }
    };
  };
  const setManualAttachUi = (assetId, next = {}) => {
    state.assetUi = {
      ...(state.assetUi || {}),
      manualAttachByAsset: {
        ...((state.assetUi && state.assetUi.manualAttachByAsset) || {}),
        [assetId]: {
          ...(((state.assetUi && state.assetUi.manualAttachByAsset) || {})[assetId] || {}),
          ...next,
        }
      }
    };
  };
  const sanitizeStorageSegment = (value, fallback = 'manual') => {
    const normalized = `${value || ''}`.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return normalized || fallback;
  };

  const MANUAL_ATTACH_ASSET_RESOLUTION_ERROR = 'Cannot attach manual because the asset record could not be identified. Refresh and try again.';
  const resolveManualAttachAsset = (requestedAssetId) => {
    const assetId = `${requestedAssetId || ''}`.trim();
    if (!assetId) {
      return { ok: false, assetId: '', assetDocId: '', storedAssetId: '', asset: null, message: MANUAL_ATTACH_ASSET_RESOLUTION_ERROR };
    }
    const asset = findAssetByRecordId(state.assets, assetId);
    const canonicalAssetId = getAssetRecordId(asset || {});
    const assetDocId = `${asset?.firestoreDocId || asset?.docId || asset?._docId || canonicalAssetId || ''}`.trim();
    const storedAssetId = `${asset?.storedAssetId || ''}`.trim();
    if (!canonicalAssetId || !assetDocId) {
      return { ok: false, assetId, assetDocId: '', storedAssetId, asset: null, message: MANUAL_ATTACH_ASSET_RESOLUTION_ERROR };
    }
    return { ok: true, assetId: canonicalAssetId, assetDocId, storedAssetId, asset, message: '' };
  };
  const isHttpUrl = (value = '') => /^https?:\/\//i.test(`${value || ''}`.trim());
  const summarizeManualAttachUrl = (manualUrl = '') => {
    const value = `${manualUrl || ''}`.trim();
    if (!value) return { host: '' };
    try {
      return { host: new URL(value).hostname || '' };
    } catch {
      return { host: '' };
    }
  };
  const mapManualAttachErrorMessage = (error) => {
    const raw = `${error?.message || error || 'unknown error'}`.trim();
    if (/manual attachment failed unexpectedly\. check function logs for details\./i.test(raw)) return 'Manual attachment failed unexpectedly. Check function logs for details.';
    if (/manual url is required for manual attachment/i.test(raw)) return 'Manual URL is required for manual attachment.';
    if (/manual file upload did not produce a storage path/i.test(raw)) return 'Manual file upload did not produce a storage path.';
    if (/asset not found for manual attachment/i.test(raw)) return 'Asset not found for manual attachment. Refresh the asset list and try again.';
    if (/asset resolved but missing company context for manual attachment/i.test(raw)) return 'Asset resolved but missing company context for manual attachment.';
    if (/asset\/company mismatch for manual attachment/i.test(raw)) return 'Asset/company mismatch for manual attachment.';
    if (/unsupported_file_type/i.test(raw)) return 'Attachment failed: unsupported file type.';
    if (/download_timeout/i.test(raw)) return 'Attachment failed: download timed out.';
    if (/download_failed/i.test(raw)) return 'Attachment failed: could not download the manual URL.';
    return `Attachment failed: ${raw.slice(0, 140)}`;
  };
  const pollManualAttachStatus = async (assetId, {
    timeoutMs = 120000,
    intervalMs = 4000,
  } = {}) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await refreshData();
      const latest = findAssetByRecordId(state.assets, assetId) || {};
      const status = `${latest.manualAttachStatus || ''}`.trim().toLowerCase();
      if (status === 'completed' || status === 'failed') return latest;
      await pause(intervalMs);
    }
    return findAssetByRecordId(state.assets, assetId) || {};
  };

  const approveManualSources = (assetId, urls = [], current = {}, metadataByUrl = {}) => approveSuggestedManualSources({
    assetId,
    urls,
    current,
    metadataByUrl,
    approveAssetManual,
    logLabel: 'approve_asset_manual'
  });

  const countReviewableSuggestions = (asset = {}) => (Array.isArray(asset.documentationSuggestions) ? asset.documentationSuggestions : [])
    .filter((entry) => !!`${entry?.url || ''}`.trim() && !entry?.deadPage && !entry?.unreachable && entry?.verified)
    .length;

  const buildManualRepairFeedback = (result = {}, { dryRun = false } = {}) => {
    const entry = Array.isArray(result?.manualMaterialization?.entries) ? result.manualMaterialization.entries[0] : null;
    if (!entry) return dryRun ? 'Manual text check completed.' : 'Manual text re-extraction completed.';
    const chunkCount = Number(entry?.newChunkCount ?? entry?.priorChunkCount ?? 0) || 0;
    if (entry?.action === 'already_has_chunks') {
      return `Manual already has extracted text: ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}.`;
    }
    if (entry?.action === 'no_manual_storage_path' || entry?.reason === 'no_manual_storage_path') {
      return 'No attached manual storage path found.';
    }
    if (entry?.newExtractionStatus === 'no_text_extracted') {
      return 'Manual attached, but no readable text was extracted.';
    }
    if (entry?.newChunkCount > 0 && ['reextracted', 'materialized', 'would_reextract', 'would_materialize'].includes(`${entry?.action || ''}`)) {
      return dryRun
        ? `Manual text check: ${chunkCount} chunk${chunkCount === 1 ? '' : 's'} would be available after re-extraction.`
        : `Manual text extracted: ${chunkCount} chunks created.`;
    }
    if (entry?.action === 'extraction_failed' || entry?.newExtractionStatus === 'failed') {
      const reason = `${entry?.reason || ''}`.trim() || 'unknown error';
      return `Extraction failed: ${reason.slice(0, 120)}.`;
    }
    return dryRun ? 'Manual text check completed.' : 'Manual text re-extraction completed.';
  };

  const getDraftContext = (draft = state.assetDraft || {}) => resolveAssetDraftContext(state, draft);

  const invalidatePreviewForContext = (contextMessage = '') => {
    state.assetDraft = {
      ...(state.assetDraft || {}),
      preview: null,
      previewContext: null,
      previewStatus: 'idle',
      previewFeedback: contextMessage,
      previewMeta: { ...(state.assetDraft?.previewMeta || {}), inFlightQuery: '', lastCompletedQuery: '' },
      draftContextStamp: ''
    };
  };

  const syncDraftContextState = ({ clearPreview = false, contextMessage = '' } = {}) => {
    const context = getDraftContext();
    const currentPreviewContext = state.assetDraft?.previewContext || null;
    const previewStale = !!(state.assetDraft?.preview && currentPreviewContext && !doesPreviewContextMatch(context, currentPreviewContext));

    if (clearPreview || previewStale) {
      invalidatePreviewForContext(contextMessage || (previewStale
        ? 'Preview was cleared because the active company or location context changed.'
        : 'Preview was cleared because the asset location changed.'));
    }

    state.assetDraft = {
      ...(state.assetDraft || {}),
      draftContextStamp: context.ok ? context.stamp : '',
      saveDebugContext: buildAssetDraftContextDebug(context)
    };
    return context;
  };

  const blockDraftAction = (message, { preview = false, debugContext = null } = {}) => {
    state.assetDraft = {
      ...(state.assetDraft || {}),
      saving: false,
      saveFeedback: preview ? (state.assetDraft?.saveFeedback || '') : message,
      saveSecondaryFeedback: '',
      saveFeedbackTone: preview ? (state.assetDraft?.saveFeedbackTone || 'success') : 'error',
      saveDebugContext: debugContext ? `Debug - ${buildAssetDraftContextDebug(debugContext)}` : (state.assetDraft?.saveDebugContext || ''),
      previewFeedback: preview ? message : (state.assetDraft?.previewFeedback || '')
    };
    render();
  };

  const buildCompletionFeedback = (asset = {}, result = {}) => {
    const status = `${result?.status || asset?.enrichmentStatus || 'idle'}`.trim() || 'idle';
    const manualLibraryRef = `${asset?.manualLibraryRef || ''}`.trim();
    const manualStoragePath = `${asset?.manualStoragePath || ''}`.trim();
    const manualLinks = Array.isArray(asset?.manualLinks) ? asset.manualLinks.filter(Boolean) : [];
    const supportCount = (Array.isArray(asset?.supportResourcesSuggestion) ? asset.supportResourcesSuggestion : [])
      .filter((entry) => !entry?.deadPage && !entry?.unreachable && `${entry?.url || entry || ''}`.trim())
      .length;
    const reviewableCount = countReviewableSuggestions(asset);
    const manualStatus = deriveManualStatus(asset);
    const hasStoredManualLink = manualLinks.some((value) => {
      const normalized = `${value || ''}`.trim().toLowerCase();
      return normalized.startsWith('manual-library/') || normalized.startsWith('companies/');
    });
    const hasAttachedManual = manualStatus === 'manual_attached' || manualStatus === 'attached' || !!(manualLibraryRef || manualStoragePath || hasStoredManualLink);

    if (hasAttachedManual || status === 'docs_found' || status === 'verified_manual_found') {
      return {
        message: 'Manual attached.',
        tone: 'success'
      };
    }
    if (reviewableCount > 0) {
      return {
        message: 'Manual suggestions ready.',
        tone: 'success'
      };
    }
    if (status === 'followup_needed') {
      return {
        message: supportCount
          ? 'No matching manual found yet. Support resources are linked.'
          : 'More info needed.',
        tone: 'info'
      };
    }
    if (status === 'no_match_yet') {
      return {
        message: 'No matching manual found yet. Support resources are linked.',
        tone: 'info'
      };
    }
    return {
      message: 'Documentation lookup completed with your answer.',
      tone: 'info'
    };
  };

  const actions = {
    saveAsset: async (id, payload) => {
      const name = `${payload.name || ''}`.trim();
      const manufacturer = `${payload.manufacturer || ''}`.trim();
      const normalizedNameTokens = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
      const normalizedManufacturerTokens = manufacturer.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
      const weakLookupWarning = (name.length < 4 || normalizedNameTokens.length <= 1 || manufacturer.length < 3 || normalizedManufacturerTokens.length <= 1)
        ? 'Warning: title/manufacturer look weak for manual lookup. Add model/version or full manufacturer family to improve match quality.'
        : '';
      if (!name) return alert('Asset name is required.');
      if (!manufacturer) return alert('Manufacturer is required.');
      const context = syncDraftContextState();
      if (!context.ok) {
        blockDraftAction(context.message, { debugContext: context });
        return;
      }
      if (state.assetDraft?.preview && !doesPreviewContextMatch(context, state.assetDraft.previewContext)) {
        blockDraftAction('Cannot save because the preview suggestions were generated for a different company or location context. Run research again before saving.', { debugContext: context });
        return;
      }
      state.assetDraft = {
        ...(state.assetDraft || {}),
        saving: true,
        saveFeedback: '',
        saveSecondaryFeedback: weakLookupWarning,
        saveFeedbackTone: 'success',
        saveDebugContext: `Debug - ${buildAssetDraftContextDebug(context)}`
      };
      render();
      try {
        const desiredId = `${id || ''}`.trim() || normalizeAssetId(name);
        const current = state.assets.find((asset) => asset.id === desiredId) || {};
        const finalId = current.id ? desiredId : pickUniqueAssetId(desiredId, state.assets);
        const draft = state.assetDraft || {};
        const maintenancePlan = parseMaintenancePlanPatch(payload, current);
        const entityPayload = {
          ...current,
          ...payload,
          id: finalId,
          name,
          companyId: context.resolvedCompanyId,
          locationId: `${payload.locationId || current.locationId || ''}`.trim(),
          locationName: `${context.selectedLocationName || payload.locationName || current.locationName || ''}`.trim(),
          serialNumber: `${payload.serialNumber || current.serialNumber || ''}`.trim(),
          manufacturer: `${manufacturer || draft.manufacturer || current.manufacturer || ''}`.trim(),
          ownerWorkers: `${payload.ownerWorkers || ''}`.split(',').map((value) => value.trim()).filter(Boolean),
          manualLinks: `${payload.manualLinks || ''}`.split(',').map((value) => value.trim()).filter(Boolean)
            .concat(Array.isArray(draft.manualLinks) ? draft.manualLinks : [])
            .filter(Boolean)
            .filter((value, index, list) => list.indexOf(value) === index)
            .slice(0, 5),
          enrichmentStatus: (payload.manualLinks || current.manualLinks?.length) ? (current.enrichmentStatus || 'idle') : 'searching_docs',
          enrichmentRequestedAt: (payload.manualLinks || current.manualLinks?.length) ? (current.enrichmentRequestedAt || null) : new Date().toISOString(),
          enrichmentLastRunAt: (payload.manualLinks || current.manualLinks?.length) ? (current.enrichmentLastRunAt || null) : new Date().toISOString(),
          history: payload.historyNote ? [...(current.history || []), {
            at: new Date().toISOString(),
            note: payload.historyNote,
            type: 'update',
            attachments: {
              images: parseReferenceList(payload.imageRefsText),
              videos: parseReferenceList(payload.videoRefsText),
              evidence: parseReferenceList(payload.evidenceRefsText)
            }
          }] : (current.history || []),
          attachmentRefs: {
            images: parseReferenceList(payload.imageRefsText).length ? parseReferenceList(payload.imageRefsText) : ((current.attachmentRefs && current.attachmentRefs.images) || []),
            videos: parseReferenceList(payload.videoRefsText).length ? parseReferenceList(payload.videoRefsText) : ((current.attachmentRefs && current.attachmentRefs.videos) || []),
            evidence: parseReferenceList(payload.evidenceRefsText).length ? parseReferenceList(payload.evidenceRefsText) : ((current.attachmentRefs && current.attachmentRefs.evidence) || [])
          },
          supportResourcesSuggestion: Array.isArray(draft.supportResources) && draft.supportResources.length ? draft.supportResources : (current.supportResourcesSuggestion || []),
          manualStatus: deriveManualStatus({
            ...current,
            manualLinks: `${payload.manualLinks || ''}`.split(',').map((value) => value.trim()).filter(Boolean)
              .concat(Array.isArray(draft.manualLinks) ? draft.manualLinks : [])
              .filter(Boolean)
              .filter((value, index, list) => list.indexOf(value) === index)
              .slice(0, 5),
            supportResourcesSuggestion: Array.isArray(draft.supportResources) && draft.supportResources.length ? draft.supportResources : (current.supportResourcesSuggestion || []),
          }),
          supportContactsSuggestion: Array.isArray(draft.supportContacts) && draft.supportContacts.length ? draft.supportContacts : (current.supportContactsSuggestion || []),
          notes: `${payload.notes || ''}`.trim() || `${current.notes || ''}`.trim() || (draft.notes ? `${draft.notes}`.trim() : ''),
          maintenancePlan
        };
        await withTimeout(
          upsertEntity('assets', finalId, withRequiredCompanyId(entityPayload, 'save an asset'), state.user),
          20000,
          'Asset save timed out. Please retry.'
        );
        state.assetDraft = { ...createEmptyAssetDraft(), saveFeedback: 'Asset saved.', saveFeedbackTone: 'success', saveDebugContext: '' };
        await refreshData();
        render();
        const existingSecondary = `${state.assetDraft?.saveSecondaryFeedback || weakLookupWarning || ''}`.trim();
        const pendingMessage = 'Docs lookup is still pending.';
        state.assetDraft = {
          ...(state.assetDraft || {}),
          saveSecondaryFeedback: existingSecondary ? `${existingSecondary} ${pendingMessage}` : pendingMessage,
          saveFeedbackTone: 'success'
        };
        render();
        enrichAssetDocumentation(finalId, { trigger: 'post_save' })
          .then(async () => {
            await refreshData();
            state.assetDraft = { ...(state.assetDraft || {}), saveFeedback: 'Asset saved.', saveSecondaryFeedback: '', saveFeedbackTone: 'success' };
            render();
          })
          .catch(async (error) => {
            console.error('[asset_post_save_enrichment]', error);
            const failure = await markAssetEnrichmentFailure(finalId, error);
            await refreshData();
            state.assetDraft = { ...(state.assetDraft || {}), saveFeedback: 'Asset saved.', saveSecondaryFeedback: failure.message, saveFeedbackTone: 'success' };
            render();
          });
        return;
      } catch (error) {
        console.error('[save_asset]', error);
        const role = `${state.permissions?.companyRole || ''}`.toLowerCase();
        const showDebugContext = isPermissionRelatedError(error) && (isAdmin(state.permissions) || isManager(state.permissions) || role === 'owner');
        const debug = showDebugContext ? buildAssetSaveDebugContext() : null;
        state.assetDraft = {
          ...(state.assetDraft || {}),
          saving: false,
          saveFeedback: buildAssetSaveErrorMessage(error),
          saveSecondaryFeedback: '',
          saveFeedbackTone: 'error',
          saveDebugContext: debug ? `Debug - company: ${debug.companyId} | role: ${debug.companyRole}` : ''
        };
        render();
        return;
      } finally {
        if (state.assetDraft?.saving) {
          state.assetDraft = { ...(state.assetDraft || {}), saving: false };
          render();
        }
      }
    },
    previewAssetLookup: async (payload) => {
      const context = syncDraftContextState();
      if (!context.ok) {
        blockDraftAction(context.message, { preview: true, debugContext: context });
        return;
      }
      const assetName = `${payload?.assetName || ''}`.trim();
      const normalizedQuery = deps.buildPreviewQueryKey(payload);
      const previewMeta = state.assetDraft?.previewMeta || { inFlightQuery: '', lastCompletedQuery: '' };
      const normalizedName = assetName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (assetName.length < 3 || !normalizedName) {
        state.assetDraft = {
          ...state.assetDraft,
          preview: null,
          previewContext: null,
          previewStatus: 'idle',
          previewFeedback: '',
          previewMeta: { ...previewMeta, inFlightQuery: '' },
          draftNameNormalized: normalizedName
        };
        render();
        return;
      }
      if (previewMeta.inFlightQuery === normalizedQuery || previewMeta.lastCompletedQuery === normalizedQuery) return;

      state.assetDraft = {
        ...state.assetDraft,
        previewStatus: payload?.reason === 'manufacturer_refine' ? 'searching_refined' : 'searching',
        previewFeedback: '',
        previewMeta: { ...previewMeta, inFlightQuery: normalizedQuery },
        draftNameNormalized: normalizedName
      };
      render();

      const [enrichedRow] = await enrichAssetIntakeRows([{
        name: assetName,
        assetId: `${payload?.assetId || ''}`.trim(),
        manufacturer: `${payload?.manufacturer || ''}`.trim(),
        serialNumber: `${payload?.serialNumber || ''}`.trim(),
        locationName: `${state.assetDraft?.locationName || ''}`.trim()
      }], { lookup: previewAssetDocumentationLookup });

      if (enrichedRow?.preview) {
        state.assetDraft = {
          ...state.assetDraft,
          preview: enrichedRow.preview,
          previewContext: context,
          previewStatus: enrichedRow.preview?.status || 'found_suggestions',
          previewFeedback: '',
          previewMeta: { inFlightQuery: '', lastCompletedQuery: normalizedQuery },
          draftContextStamp: context.stamp,
          draftNameNormalized: normalizedName,
          normalizedName: enrichedRow.normalizedName || '',
          manualSourceUrl: enrichedRow.manualSourceUrl || '',
          supportEmail: enrichedRow.supportEmail || '',
          supportPhone: enrichedRow.supportPhone || '',
          supportUrl: enrichedRow.supportUrl || '',
          matchConfidence: enrichedRow.matchConfidence || '',
          matchNotes: enrichedRow.matchNotes || ''
        };
      } else {
        state.assetDraft = {
          ...state.assetDraft,
          previewStatus: 'no_strong_match',
          previewContext: context,
          previewFeedback: '',
          previewMeta: { ...previewMeta, inFlightQuery: '' },
          draftContextStamp: context.stamp,
          draftNameNormalized: normalizedName
        };
      }
      render();
    },
    applyPreviewToDraft: (partialPayload = {}) => {
      const context = syncDraftContextState();
      if (!context.ok) {
        blockDraftAction(context.message, { preview: true, debugContext: context });
        return;
      }
      if (state.assetDraft?.preview && !doesPreviewContextMatch(context, state.assetDraft.previewContext)) {
        invalidatePreviewForContext('Preview was cleared because the active company or location context changed. Run research again before applying suggestions.');
        render();
        return;
      }
      const { triggerRefinedPreview, ...draftPatch } = partialPayload;
      state.assetDraft = { ...state.assetDraft, ...draftPatch, previewFeedback: '' };
      render();
      if (triggerRefinedPreview) {
        const draft = state.assetDraft || {};
        const name = `${draft.name || ''}`.trim();
        if (name.length >= 3) {
          const followupAnswer = draft.preview?.followupAnswer || '';
          actions.previewAssetLookup({
            assetName: name,
            manufacturer: `${draft.manufacturer || ''}`.trim(),
            serialNumber: `${draft.serialNumber || ''}`.trim(),
            assetId: `${draft.id || ''}`.trim(),
            followupAnswer,
            reason: 'manufacturer_refine'
          });
        }
      }
    },
    startBulkAssetIntake: async (text, options = {}) => {
      const parsed = parseTitleBulkInput(text, { defaultLocationName: options.defaultLocationName || '' });
      state.assetUi = {
        ...(state.assetUi || {}),
        bulkIntakeText: text,
        bulkIntakeErrors: parsed.errors || [],
        bulkIntakeRows: parsed.rows || [],
        bulkIntakeStatus: parsed.rows.length ? 'parsed' : 'idle'
      };
      render();
    },
    enrichBulkIntakeRows: async (options = {}) => {
      const existingRows = Array.isArray(state.assetUi?.bulkIntakeRows) ? state.assetUi.bulkIntakeRows : [];
      if (!existingRows.length) return;
      const context = getDraftContext({ locationId: options.locationId || state.assetDraft?.locationId, locationName: options.defaultLocationName || state.assetDraft?.locationName });
      if (!context.ok) {
        state.assetDraft = { ...(state.assetDraft || {}), saveFeedback: context.message, saveFeedbackTone: 'error', saveDebugContext: `Debug - ${buildAssetDraftContextDebug(context)}` };
        render();
        return;
      }
      state.assetUi = { ...(state.assetUi || {}), bulkIntakeStatus: 'enriching', bulkIntakeErrors: [] };
      render();
      const companyId = context.resolvedCompanyId;
      const lookupRows = existingRows.map((row) => ({ ...row, locationName: row.locationName || options.defaultLocationName || '' }));
      const enrichedRows = await enrichAssetIntakeRows(lookupRows, {
        lookup: async (payload) => {
          if (companyId && typeof researchAssetTitles === 'function') {
            const preview = (await researchAssetTitles({
              companyId,
              locationId: `${options.locationId || ''}`.trim(),
              titles: [{
                originalTitle: payload.assetName,
                manufacturerHint: payload.manufacturer || '',
                assetId: payload.assetId || '',
              }],
              includeInternalDocs: true,
              maxWebSources: 5,
            }))?.results?.[0];
            if (preview) return { ok: true, ...preview, assetResearchSummary: preview.manualMatchSummary || preview };
          }
          return previewAssetDocumentationLookup(payload);
        }
      });
      state.assetUi = { ...(state.assetUi || {}), bulkIntakeRows: enrichedRows, bulkIntakeStatus: 'review' };
      render();
    },
    updateBulkIntakeRow: (index, payload = {}) => {
      const rows = Array.isArray(state.assetUi?.bulkIntakeRows) ? [...state.assetUi.bulkIntakeRows] : [];
      const current = rows[index];
      if (!current) return;
      const next = { ...current, ...payload };
      if ('alternateNames' in payload && typeof payload.alternateNames === 'string') next.alternateNames = payload.alternateNames.split(/[|,;]+/).map((value) => value.trim()).filter(Boolean);
      next.reviewNeeded = ['needs_review', 'unresolved'].includes(next.rowStatus);
      rows[index] = next;
      state.assetUi = { ...(state.assetUi || {}), bulkIntakeRows: rows };
    },
    setBulkRowStatus: (index, rowStatus) => {
      const rows = Array.isArray(state.assetUi?.bulkIntakeRows) ? [...state.assetUi.bulkIntakeRows] : [];
      const current = rows[index];
      if (!current) return;
      rows[index] = { ...current, rowStatus, reviewNeeded: rowStatus !== 'good_match' };
      state.assetUi = { ...(state.assetUi || {}), bulkIntakeRows: rows };
      render();
    },
    exportBulkIntakeCsv: () => buildAssetCsv((state.assetUi?.bulkIntakeRows || []).filter((row) => row.rowStatus !== 'skipped').map((row) => buildAssetImportRow(row))),
    importBulkIntakeRows: async () => {
      const rows = (state.assetUi?.bulkIntakeRows || []).filter((row) => !['skipped', 'unresolved'].includes(row.rowStatus));
      if (!rows.length) return;
      const context = syncDraftContextState();
      if (!context.ok) {
        blockDraftAction(context.message, { debugContext: context });
        return;
      }
      const importedRows = [];
      for (const row of rows) {
        const desiredId = `${row.assetId || ''}`.trim() || normalizeAssetId(row.name || 'asset');
        const finalId = pickUniqueAssetId(desiredId, state.assets);
        const manualHintUrl = `${row.manualHintUrl || row.manualUrl || ''}`.trim();
        const manualSourceHintUrl = `${row.manualSourceHintUrl || row.manualSourceUrl || ''}`.trim();
        const supportHintUrl = `${row.supportHintUrl || row.supportUrl || ''}`.trim();
        const documentationSuggestions = manualHintUrl
          ? [{
            title: 'Bulk intake manual hint',
            url: manualHintUrl,
            sourcePageUrl: manualSourceHintUrl || supportHintUrl,
            sourceType: 'intake_hint',
            verified: false,
            trustedSource: false,
            exactTitleMatch: false,
            exactManualMatch: false
          }]
          : [];
        const supportContacts = [];
        if (row.supportEmail) supportContacts.push({ contactType: 'email', label: 'Support email', value: row.supportEmail });
        if (row.supportPhone) supportContacts.push({ contactType: 'phone', label: 'Support phone', value: row.supportPhone });
        await upsertEntity('assets', finalId, withRequiredCompanyId({
          id: finalId,
          companyId: context.resolvedCompanyId,
          name: row.name,
          manufacturer: row.manufacturer || row.manufacturerSuggestion || '',
          model: row.model || '',
          serialNumber: row.serialNumber || '',
          locationName: row.locationName || '',
          zone: row.zone || '',
          notes: row.notes || row.matchNotes || '',
          category: row.category || row.categorySuggestion || '',
          status: row.status || 'active',
          alternateNames: Array.isArray(row.alternateNames) ? row.alternateNames : [],
          normalizedName: row.normalizedName || row.name,
          subtitleOrVersion: row.subtitleOrVersion || '',
          playerCount: row.playerCount || '',
          cabinetType: row.cabinetType || '',
          vendorOrDistributor: row.vendorOrDistributor || '',
          manufacturerWebsite: row.manufacturerWebsite || '',
          externalAssetKey: row.externalAssetKey || '',
          manualHintUrl,
          manualSourceHintUrl,
          supportHintUrl,
          documentationSuggestions,
          supportResourcesSuggestion: normalizeSupportEntries(supportHintUrl ? [{ url: supportHintUrl, label: 'Bulk intake support hint', sourceType: 'intake_hint', trustedSource: false }] : []),
          supportContactsSuggestion: supportContacts,
          enrichmentConfidence: Number(row.matchConfidence || row.confidence || 0) || null,
          manufacturerSuggestion: row.manufacturerSuggestion || '',
          categorySuggestion: row.categorySuggestion || '',
          importSource: 'bulk_title_intake',
          reviewState: row.rowStatus === 'good_match' ? 'ready' : 'pending_review',
          manualStatus: deriveManualStatus({ manualLinks: [], supportResourcesSuggestion: normalizeSupportEntries(supportHintUrl ? [{ url: supportHintUrl, label: 'Bulk intake support hint' }] : []), documentationSuggestions }),
          enrichmentStatus: 'searching_docs',
          enrichmentRequestedAt: new Date().toISOString(),
          reviewReason: row.rowStatus === 'good_match' ? '' : 'bulk_title_review',
          matchNotes: row.matchNotes || ''
        }, 'bulk import assets'), state.user);
        importedRows.push({ ...row, assetId: finalId, intakeStatusBadge: 'searching', intakeStatusLabel: 'searching' });
      }
      await refreshData();
      const reconciledImportedRows = reconcileIntakeRowsFromAssets(importedRows, state.assets || []);
      state.assetUi = {
        ...(state.assetUi || {}),
        bulkIntakeRows: [],
        bulkIntakeStatus: 'imported',
        bulkIntakeText: '',
        recentIntakeRows: reconcileIntakeRowsFromAssets([
          ...(Array.isArray(state.assetUi?.recentIntakeRows) ? state.assetUi.recentIntakeRows : []),
          ...reconciledImportedRows
        ], state.assets || [])
      };
      render();
    },
    applyOnboardingReviewEdit: async (index, payload) => {
      const queue = Array.isArray(state.assetUi?.onboardingReviewQueue) ? state.assetUi.onboardingReviewQueue : [];
      const current = queue[index];
      if (!current) return;
      const next = {
        ...current,
        name: `${payload.name || current.name || ''}`.trim(),
        manufacturer: `${payload.manufacturer || current.manufacturer || ''}`.trim(),
        locationName: `${payload.locationName || current.locationName || ''}`.trim(),
        category: `${payload.category || current.category || ''}`.trim(),
        model: `${payload.model || current.model || ''}`.trim(),
        serialNumber: `${payload.serialNumber || current.serialNumber || ''}`.trim(),
        reviewNeeded: false
      };
      queue[index] = next;
      state.assetUi = { ...(state.assetUi || {}), onboardingReviewQueue: [...queue] };
      const target = (state.assets || []).find((asset) => (asset.name || '').toLowerCase() === (current.name || '').toLowerCase());
      if (target?.id) {
        await upsertEntity('assets', target.id, {
          ...target,
          name: next.name,
          manufacturer: next.manufacturer,
          locationName: next.locationName,
          category: next.category,
          model: next.model,
          serialNumber: next.serialNumber,
          reviewState: 'ready',
          reviewReason: ''
        }, state.user);
        await refreshData();
      }
      render();
    },
    updateAssetDraftField: (field, value) => {
      state.assetDraft = { ...state.assetDraft, [field]: value };
      if (field === 'locationId' || field === 'locationName') {
        syncDraftContextState({ clearPreview: true });
      }
    },
    handleDraftNameChange: (assetName) => {
      const normalizedName = `${assetName || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const previousNormalizedName = `${state.assetDraft?.draftNameNormalized || ''}`;
      const shouldClear = !normalizedName || (previousNormalizedName && normalizedName !== previousNormalizedName);
      if (!shouldClear) return;
      state.assetDraft = {
        ...state.assetDraft,
        preview: null,
        previewContext: null,
        previewStatus: 'idle',
        previewFeedback: '',
        previewMeta: { ...(state.assetDraft?.previewMeta || {}), inFlightQuery: '' },
        draftNameNormalized: normalizedName
      };
      render();
    },
    clearPreview: () => {
      state.assetDraft = {
        ...state.assetDraft,
        preview: null,
        previewContext: null,
        previewStatus: 'idle',
        previewFeedback: '',
        previewMeta: { ...(state.assetDraft?.previewMeta || {}), inFlightQuery: '' }
      };
      render();
    },
    runAssetEnrichment: async (id) => {
      const current = state.assets.find((asset) => asset.id === id) || {};
      setAssetActionFeedback(id, 'Documentation lookup started.', 'info');
      await upsertEntity('assets', id, {
        ...current,
        enrichmentStatus: 'in_progress',
        enrichmentRequestedAt: new Date().toISOString(),
        enrichmentLastRunAt: new Date().toISOString(),
        enrichmentErrorCode: '',
        enrichmentErrorMessage: '',
        enrichmentFailedAt: null
      }, state.user);
      await refreshData();
      render();
      try {
        const result = await enrichAssetDocumentation(id, buildManualEnrichmentRequest());
        await refreshData();
        const refreshed = state.assets.find((asset) => asset.id === id) || {};
        const feedback = buildCompletionFeedback(refreshed, result);
        setAssetActionFeedback(id, feedback.message, feedback.tone);
        await refreshData();
        render();
        return { ok: true, assetId: id };
      } catch (error) {
        console.error('[asset_manual_enrichment]', error);
        const failure = await markAssetEnrichmentFailure(id, error, true);
        setAssetActionFeedback(id, failure.message, 'error');
        await refreshData();
        render();
        return { ok: false, assetId: id, error };
      }
    },
    repairAssetManualText: async (id, options = {}) => safeWithGlobalBusy(options?.dryRun ? 'Checking manual text…' : 'Extracting manual text…', 'This can take a few seconds. Please do not refresh.', async () => {
      if (!isManager(state.permissions) || typeof repairAssetDocumentationState !== 'function') return;
      const dryRun = options?.dryRun === true;
      const current = findAssetByRecordId(state.assets, id) || {};
      const canonicalId = getAssetRecordId(current) || `${id || ''}`.trim();
      setAssetActionFeedback(canonicalId, dryRun ? 'Checking manual text extraction state…' : 'Re-extracting manual text…', 'info');
      render();
      try {
        const result = await repairAssetDocumentationState({ assetId: canonicalId, assetDocId: canonicalId, dryRun });
        const message = buildManualRepairFeedback(result, { dryRun });
        setAssetActionFeedback(canonicalId, message, message.startsWith('Extraction failed') ? 'error' : 'success');
        await refreshData();
        render();
        return result;
      } catch (error) {
        const reason = `${error?.message || error || 'unknown error'}`.trim().slice(0, 120);
        setAssetActionFeedback(canonicalId, `Extraction failed: ${reason}.`, 'error');
        await refreshData();
        render();
        return null;
      }
    }),
    runBulkAssetEnrichment: async (assetIds = [], options = {}) => {
      if (state.assetUi?.bulkDocRerunStatus === 'running') return;
      const visibleIds = Array.from(new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => `${id || ''}`.trim()).filter(Boolean)));
      if (!visibleIds.length) {
        state.assetUi = {
          ...(state.assetUi || {}),
          bulkDocRerunStatus: 'idle',
          bulkDocRerunProgress: null,
          bulkDocRerunSummary: 'No visible assets to process.'
        };
        render();
        return;
      }
      const confirmStart = options?.confirmStart !== false;
      if (confirmStart && typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const proceed = window.confirm(`Re-search docs for ${visibleIds.length} visible asset${visibleIds.length === 1 ? '' : 's'}?`);
        if (!proceed) return;
      }
      const requestDelayMs = Number(options?.requestDelayMs ?? 250);
      const initialProgress = {
        totalTargeted: visibleIds.length,
        completed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        currentAssetId: '',
        currentAssetName: ''
      };
      state.assetUi = {
        ...(state.assetUi || {}),
        bulkDocRerunStatus: 'running',
        bulkDocRerunProgress: initialProgress,
        bulkDocRerunSummary: ''
      };
      render();

      const progress = { ...initialProgress };
      for (let index = 0; index < visibleIds.length; index += 1) {
        const assetId = visibleIds[index];
        const current = state.assets.find((asset) => asset.id === assetId) || {};
        progress.currentAssetId = assetId;
        progress.currentAssetName = `${current?.name || ''}`.trim();
        state.assetUi = { ...(state.assetUi || {}), bulkDocRerunProgress: { ...progress } };
        render();

        const status = `${current?.enrichmentStatus || ''}`.trim();
        if (ACTIVE_ENRICHMENT_STATUSES.has(status)) {
          progress.skipped += 1;
          progress.completed += 1;
          state.assetUi = { ...(state.assetUi || {}), bulkDocRerunProgress: { ...progress } };
          render();
          continue;
        }
        try {
          const result = await actions.runAssetEnrichment(assetId);
          if (result?.ok === false) progress.failed += 1;
          else progress.succeeded += 1;
        } catch (error) {
          console.error('[asset_bulk_manual_enrichment]', { assetId, error });
          progress.failed += 1;
          setAssetActionFeedback(assetId, 'Bulk documentation re-search failed. Retry this asset manually.', 'error');
        } finally {
          progress.completed += 1;
          state.assetUi = { ...(state.assetUi || {}), bulkDocRerunProgress: { ...progress } };
          render();
        }
        if (requestDelayMs > 0 && index < visibleIds.length - 1) await pause(requestDelayMs);
      }
      const summary = `Bulk documentation re-search complete. Succeeded ${progress.succeeded}, failed ${progress.failed}, skipped ${progress.skipped}.`;
      state.assetUi = {
        ...(state.assetUi || {}),
        bulkDocRerunStatus: 'idle',
        bulkDocRerunProgress: { ...progress, currentAssetId: '', currentAssetName: '' },
        bulkDocRerunSummary: summary
      };
      render();
    },
    submitEnrichmentFollowup: async (id, answer) => safeWithGlobalBusy('Retrying documentation lookup…', 'Using your follow-up answer to search for better documentation.', async () => {
      const trimmedAnswer = `${answer || ''}`.trim();
      if (!trimmedAnswer) return alert('Please enter an answer before retrying enrichment.');
      const current = findAssetByRecordId(state.assets, id) || {};
      const canonicalAssetId = getAssetRecordId(current) || `${id || ''}`.trim();
      if (!canonicalAssetId) return alert('Unable to resolve this asset. Refresh and try again.');
      if (isHttpUrl(trimmedAnswer)) {
        setFollowupUiState(canonicalAssetId, {
          followupSubmitting: false,
          followupAnswer: '',
          followupMessage: 'This looks like a manual URL. Attaching it to this asset.',
          followupError: '',
        });
        render();
        await actions.attachManualFromUrl(canonicalAssetId, {
          manualUrl: trimmedAnswer,
          sourceTitle: `${current?.name || ''}`.trim(),
        });
        setFollowupUiState(canonicalAssetId, {
          followupSubmitting: false,
          followupAnswer: '',
          followupMessage: '',
          followupError: '',
        });
        render();
        return;
      }
      setFollowupUiState(canonicalAssetId, {
        followupSubmitting: true,
        followupMessage: 'Retrying documentation lookup with your answer…',
        followupError: '',
      });
      setAssetActionFeedback(canonicalAssetId, 'Retrying documentation lookup with your answer…', 'info');
      await upsertEntity('assets', canonicalAssetId, {
        ...current,
        enrichmentFollowupAnswer: trimmedAnswer,
        enrichmentFollowupAnsweredAt: new Date().toISOString(),
        enrichmentStatus: 'in_progress',
        enrichmentRequestedAt: new Date().toISOString(),
        enrichmentLastRunAt: new Date().toISOString(),
        enrichmentErrorCode: '',
        enrichmentErrorMessage: '',
        enrichmentFailedAt: null
      }, state.user);
      await refreshData();
      render();
      try {
        const result = await enrichAssetDocumentation(canonicalAssetId, withRequiredCompanyId({
          ...buildFollowupEnrichmentRequest(trimmedAnswer),
          followupQuestion: `${current.enrichmentFollowupQuestion || ''}`.trim(),
          followupQuestionKey: `${current.enrichmentFollowupQuestionKey || ''}`.trim(),
          companyId: `${current.companyId || state.activeMembership?.companyId || state.company?.id || ''}`.trim(),
        }, 'retry asset documentation follow-up'));
        await refreshData();
        const refreshed = findAssetByRecordId(state.assets, canonicalAssetId) || {};
        const feedback = buildCompletionFeedback(refreshed, result);
        setFollowupUiState(canonicalAssetId, {
          followupSubmitting: false,
          followupAnswer: '',
          followupMessage: '',
          followupError: '',
        });
        setAssetActionFeedback(canonicalAssetId, feedback.message, feedback.tone);
      } catch (error) {
        console.error('[asset_followup_enrichment]', error);
        const failure = await markAssetEnrichmentFailure(canonicalAssetId, error, true);
        setFollowupUiState(canonicalAssetId, {
          followupSubmitting: false,
          followupError: failure.message,
        });
        setAssetActionFeedback(canonicalAssetId, failure.message, 'error');
      }
      await refreshData();
      render();
    }),
    retryEnrichmentWithoutFollowupAnswer: async (id) => safeWithGlobalBusy('Retrying documentation lookup…', 'Searching again without a follow-up answer.', async () => {
      const current = findAssetByRecordId(state.assets, id) || {};
      const canonicalAssetId = getAssetRecordId(current) || `${id || ''}`.trim();
      if (!canonicalAssetId) return;
      setFollowupUiState(canonicalAssetId, {
        followupSubmitting: true,
        followupMessage: 'Retrying documentation lookup…',
        followupError: '',
        followupAnswer: '',
      });
      await upsertEntity('assets', canonicalAssetId, {
        ...current,
        enrichmentFollowupAnswer: '',
        enrichmentStatus: 'in_progress',
        enrichmentRequestedAt: new Date().toISOString(),
        enrichmentLastRunAt: new Date().toISOString(),
        enrichmentErrorCode: '',
        enrichmentErrorMessage: '',
        enrichmentFailedAt: null
      }, state.user);
      await refreshData();
      render();
      try {
        const result = await enrichAssetDocumentation(canonicalAssetId, withRequiredCompanyId({
          ...buildFollowupRetryWithoutAnswerRequest(),
          followupQuestion: `${current.enrichmentFollowupQuestion || ''}`.trim(),
          followupQuestionKey: `${current.enrichmentFollowupQuestionKey || ''}`.trim(),
          companyId: `${current.companyId || state.activeMembership?.companyId || state.company?.id || ''}`.trim(),
        }, 'retry asset documentation without follow-up answer'));
        await refreshData();
        const refreshed = findAssetByRecordId(state.assets, canonicalAssetId) || {};
        const feedback = buildCompletionFeedback(refreshed, result);
        setAssetActionFeedback(canonicalAssetId, feedback.message, feedback.tone);
      } catch (error) {
        const failure = await markAssetEnrichmentFailure(canonicalAssetId, error, true);
        setAssetActionFeedback(canonicalAssetId, failure.message, 'error');
      } finally {
        setFollowupUiState(canonicalAssetId, {
          followupSubmitting: false,
          followupAnswer: '',
          followupMessage: '',
        });
      }
      await refreshData();
      render();
    }),
    attachFollowupManualUrl: async (id, answer) => {
      const trimmedAnswer = `${answer || ''}`.trim();
      if (!isHttpUrl(trimmedAnswer)) return;
      await actions.submitEnrichmentFollowup(id, trimmedAnswer);
    },
    applyDocSuggestions: async (id) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const originalSuggestions = Array.isArray(current.documentationSuggestions) ? current.documentationSuggestions : [];
      const approvedEntries = buildDocumentationApprovalSelection(current, { mode: 'top_trusted' });
      const links = approvedEntries.map((entry) => entry.url).filter(Boolean);
      const metadataByUrl = Object.fromEntries(approvedEntries.map((entry, index) => [entry.url, { title: entry.title, sourceType: entry.sourceType, index: originalSuggestions.indexOf(entry) >= 0 ? originalSuggestions.indexOf(entry) : index }]));
      if (!links.length) {
        const weakQuestion = current.enrichmentFollowupQuestion || 'Can you confirm cabinet type/version from the manufacturer plate?';
        await upsertEntity('assets', id, { ...current, enrichmentStatus: 'followup_needed', enrichmentFollowupQuestion: weakQuestion }, state.user);
        setAssetActionFeedback(id, 'No trusted documentation was applied. Added a follow-up prompt instead.', 'info');
        await refreshData();
        render();
        return;
      }
      const approvalPatch = buildDocumentationApprovalPatch(current, approvedEntries, { reviewAction: 'asset_apply_top_trusted_docs' });
      await upsertEntity('assets', id, { ...current, ...approvalPatch, manualStatus: deriveManualStatus({ ...current, ...approvalPatch }) }, state.user);
      const approval = await approveManualSources(id, links, current, metadataByUrl);
      setAssetActionFeedback(id, `Applied ${links.length} trusted documentation link${links.length === 1 ? '' : 's'}${approval.completed ? ` and ingested ${approval.completed}` : ''}${approval.failed ? ` (${approval.failed} ingestion failed)` : ''}.`, approval.failed ? 'info' : 'success');
      await refreshData();
      render();
    },
    applyEnrichmentSuggestions: async (id, mode) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const patch = {};
      if (mode === 'manufacturer' || mode === 'all') {
        const suggestedManufacturer = normalizeManufacturerDisplayName(current.manufacturerSuggestion || '');
        if (suggestedManufacturer) patch.manufacturer = suggestedManufacturer;
      }
      if (mode === 'manuals' || mode === 'all') {
        const originalSuggestions = Array.isArray(current.documentationSuggestions) ? current.documentationSuggestions : [];
        const approvedEntries = buildDocumentationApprovalSelection(current, { mode: 'best' });
        const manualUrls = approvedEntries.map((entry) => entry?.url).filter(Boolean);
        patch.__manualApproval = {
          urls: manualUrls,
          metadataByUrl: Object.fromEntries(approvedEntries.map((entry, index) => [entry.url, { title: entry.title, sourceType: entry.sourceType, index: originalSuggestions.indexOf(entry) >= 0 ? originalSuggestions.indexOf(entry) : index }]))
        };
        if (manualUrls.length) Object.assign(patch, buildDocumentationApprovalPatch(current, approvedEntries, { reviewAction: 'asset_apply_best_verified_manual' }));
      }
      if (mode === 'support' || mode === 'all') {
        const supportLinks = (Array.isArray(current.supportResourcesSuggestion) ? current.supportResourcesSuggestion : [])
          .map((entry) => entry?.url)
          .filter(Boolean)
          .slice(0, 3);
        if (supportLinks.length) patch.supportResourcesSuggestion = normalizeSupportEntries([...(current.supportResourcesSuggestion || []), ...supportLinks.map((url) => ({ url }))]);
      }
      if (mode === 'contacts' || mode === 'all') {
        const contacts = Array.isArray(current.supportContactsSuggestion) ? current.supportContactsSuggestion : [];
        if (contacts.length) {
          patch.supportContactsSuggestion = contacts;
          const contactSummary = contacts.map((entry) => `${entry.label || entry.contactType || 'contact'}: ${entry.value || ''}`).filter(Boolean).join(' | ');
          patch.notes = [current.notes, contactSummary].filter(Boolean).join(' | ');
        }
      }
      if (!Object.keys(patch).length) return;
      const manualApproval = patch.__manualApproval || null;
      if (manualApproval) delete patch.__manualApproval;
      await upsertEntity('assets', id, { ...current, ...patch, manualStatus: deriveManualStatus({ ...current, ...patch }) }, state.user);
      const approval = manualApproval ? await approveManualSources(id, manualApproval.urls, current, manualApproval.metadataByUrl) : { completed: 0, failed: 0 };
      setAssetActionFeedback(id, `Applied ${mode === 'all' ? 'documentation suggestions' : mode}${approval.completed ? ` and ingested ${approval.completed} manual${approval.completed === 1 ? '' : 's'}` : ''}${approval.failed ? ` (${approval.failed} ingestion failed)` : ''}.`, approval.failed ? 'info' : 'success');
      await refreshData();
      render();
    },
    applySingleDocSuggestion: async (id, index) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const originalSuggestions = Array.isArray(current.documentationSuggestions) ? current.documentationSuggestions : [];
      const approvedEntries = buildDocumentationApprovalSelection(current, { mode: 'top_trusted' });
      const selected = approvedEntries[index];
      const url = `${selected?.url || ''}`.trim();
      if (!url) return;
      const approvedSuggestionIndex = originalSuggestions.indexOf(selected);
      const approvalPatch = buildDocumentationApprovalPatch(current, [selected], { reviewAction: 'asset_apply_single_manual' });
      await upsertEntity('assets', id, { ...current, ...approvalPatch, manualStatus: deriveManualStatus({ ...current, ...approvalPatch }) }, state.user);
      const approval = await approveManualSources(id, [url], current, { [url]: { title: selected?.title, sourceType: selected?.sourceType, index: approvedSuggestionIndex >= 0 ? approvedSuggestionIndex : index } });
      setAssetActionFeedback(id, `Applied one documentation link${approval.completed ? ' and ingested it' : ''}${approval.failed ? ' (ingestion failed)' : ''}.`, approval.failed ? 'info' : 'success');
      await refreshData();
      render();
    },
    rejectManualCandidate: async (id, index) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const suggestions = Array.isArray(current.documentationSuggestions) ? current.documentationSuggestions : [];
      const selected = suggestions[index];
      const url = `${selected?.url || ''}`.trim();
      if (!url) return;
      const rejected = Array.from(new Set([...(current.reviewRejectedSuggestionUrls || []), url]));
      const selectedUrls = (current.reviewSelectedSuggestionUrls || []).filter((entry) => `${entry || ''}`.trim() !== url);
      const approvedUrls = (current.reviewApprovedSuggestionUrls || []).filter((entry) => `${entry || ''}`.trim() !== url);
      const patch = {
        reviewRejectedSuggestionUrls: rejected,
        reviewSelectedSuggestionUrls: selectedUrls,
        reviewApprovedSuggestionUrls: approvedUrls,
        reviewState: 'pending_review',
        reviewLastAction: 'asset_reject_single_manual_candidate',
        manualReviewState: 'queued_for_review'
      };
      await upsertEntity('assets', id, { ...current, ...patch, manualStatus: deriveManualStatus({ ...current, ...patch }) }, state.user);
      setAssetActionFeedback(id, 'Marked candidate as rejected for this asset review.', 'info');
      await refreshData();
      render();
    },
    setManualReviewState: async (id, manualReviewState, notes = '') => {
      if (!isManager(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const normalizedState = `${manualReviewState || ''}`.trim();
      if (!normalizedState) return;
      const patch = {
        manualReviewState: normalizedState,
        reviewState: normalizedState === 'queued_for_review' ? 'pending_review' : (current.reviewState || 'pending_review'),
        reviewReason: `${notes || current.reviewReason || ''}`.trim()
      };
      await upsertEntity('assets', id, { ...current, ...patch, manualStatus: deriveManualStatus({ ...current, ...patch }) }, state.user);
      setAssetActionFeedback(id, `Manual review state updated to ${normalizedState.replace(/_/g, ' ')}.`, 'success');
      await refreshData();
      render();
    },
    flagManualLibraryRow: async (id) => {
      if (!isManager(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const patch = {
        manualLibraryFlagged: true,
        manualLibraryFlaggedAt: new Date().toISOString(),
        manualLibraryFlagReason: 'operator_flagged_suspect_manual_library_row',
        manualReviewState: 'queued_for_review',
        reviewState: 'pending_review'
      };
      await upsertEntity('assets', id, { ...current, ...patch }, state.user);
      setAssetActionFeedback(id, 'Flagged this manual-library linkage for follow-up.', 'warn');
      await refreshData();
      render();
    },
    applySingleSupportSuggestion: async (id, index) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const suggestions = Array.isArray(current.supportResourcesSuggestion) ? current.supportResourcesSuggestion : [];
      const selected = suggestions[index];
      const url = `${selected?.url || selected || ''}`.trim();
      if (!url) return;
      const label = selected?.label || selected?.title || url;
      const patch = { supportResourcesSuggestion: normalizeSupportEntries([...(current.supportResourcesSuggestion || []), { url, label }]) };
      await upsertEntity('assets', id, { ...current, ...patch, manualStatus: deriveManualStatus({ ...current, ...patch }) }, state.user);
      setAssetActionFeedback(id, 'Applied one support link.', 'success');
      await refreshData();
      render();
    },
    removeManualLink: async (id, url) => {
      if (!isAdmin(state.permissions)) return;
      const clean = `${url || ''}`.trim();
      if (!clean) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const patch = {
        manualLinks: (current.manualLinks || []).filter((entry) => `${entry}`.trim() !== clean),
        ...(current.manualStoragePath && `${current.manualStoragePath}`.trim() === clean ? { manualStoragePath: '', manualLibraryRef: '' } : {})
      };
      if (!patch.manualLinks.length && !`${patch.manualStoragePath || current.manualStoragePath || ''}`.trim()) {
        patch.manualLibraryRef = '';
        patch.manualStoragePath = '';
      }
      await upsertEntity('assets', id, { ...current, ...patch, manualStatus: deriveManualStatus({ ...current, ...patch }) }, state.user);
      setAssetActionFeedback(id, 'Removed linked manual.', 'success');
      await refreshData();
      render();
    },
    removeSupportLink: async (id, url) => {
      if (!isAdmin(state.permissions)) return;
      const clean = `${url || ''}`.trim();
      if (!clean) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const patch = {
        supportResourcesSuggestion: normalizeSupportEntries((current.supportResourcesSuggestion || []).filter((entry) => `${entry?.url || entry || ''}`.trim() !== clean))
      };
      await upsertEntity('assets', id, { ...current, ...patch, manualStatus: deriveManualStatus({ ...current, ...patch }) }, state.user);
      setAssetActionFeedback(id, 'Removed linked support link.', 'success');
      await refreshData();
      render();
    },
    removeAllManualLinks: async (id) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const patch = { manualLinks: [], manualLibraryRef: '', manualStoragePath: '' };
      await upsertEntity('assets', id, { ...current, ...patch, manualStatus: deriveManualStatus({ ...current, ...patch }) }, state.user);
      setAssetActionFeedback(id, 'Removed all linked manuals.', 'success');
      await refreshData();
      render();
    },
    removeAllSupportLinks: async (id) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const patch = { supportResourcesSuggestion: [] };
      await upsertEntity('assets', id, { ...current, ...patch, manualStatus: deriveManualStatus({ ...current, ...patch }) }, state.user);
      setAssetActionFeedback(id, 'Removed all linked support links.', 'success');
      await refreshData();
      render();
    },
    attachManualFromUrl: async (id, payload = {}) => safeWithGlobalBusy('Attaching manual…', 'Downloading and extracting manual text. This can take up to a minute.', async () => {
      if (!isManager(state.permissions) || typeof attachAssetManualFromUrl !== 'function') return;
      const resolution = resolveManualAttachAsset(id);
      if (!resolution.ok) {
        setManualAttachUi(resolution.assetId || `${id || ''}`.trim() || 'unknown', { tone: 'error', message: resolution.message });
        console.warn('attach_manual_from_url:missing_asset_context', { requestedAssetId: `${id || ''}`.trim() || null });
        render();
        return;
      }
      const manualUrl = `${payload.manualUrl || ''}`.trim();
      if (!manualUrl) {
        setManualAttachUi(resolution.assetId, { tone: 'error', message: 'Manual URL is required.' });
        render();
        return;
      }
      if (!isHttpUrl(manualUrl)) {
        setManualAttachUi(resolution.assetId, { tone: 'error', message: 'Enter a valid http(s) manual URL.' });
        render();
        return;
      }
      const activeCompanyId = `${state.company?.id || state.activeMembership?.companyId || resolution.asset?.companyId || ''}`.trim();
      if (!resolution.assetId || !resolution.assetDocId) {
        setManualAttachUi(resolution.assetId || `${id || ''}`.trim() || 'unknown', { tone: 'error', message: MANUAL_ATTACH_ASSET_RESOLUTION_ERROR });
        render();
        return;
      }
      if (!activeCompanyId) {
        setManualAttachUi(resolution.assetId, { tone: 'error', message: 'Cannot attach manual because company context is missing. Refresh and try again.' });
        render();
        return;
      }
      const debugPayload = {
        assetId: resolution.assetId,
        assetDocId: resolution.assetDocId,
        storedAssetId: resolution.storedAssetId || '',
        companyId: activeCompanyId,
        manualUrlPresent: !!manualUrl,
        manualUrlHost: summarizeManualAttachUrl(manualUrl).host || '',
        sourceTitlePresent: !!`${payload.sourceTitle || ''}`.trim(),
      };
      setManualAttachUi(resolution.assetId, { pending: true, phase: 'attaching', tone: 'info', message: 'Attaching manual…' });
      console.debug('attach_manual_from_url:start', debugPayload);
      render();
      try {
        const result = await attachAssetManualFromUrl({
          assetId: resolution.assetId,
          assetDocId: resolution.assetDocId,
          assetName: `${resolution.asset?.name || ''}`.trim(),
          storedAssetId: resolution.storedAssetId || '',
          manualUrl,
          sourceTitle: `${payload.sourceTitle || ''}`.trim(),
          sourcePageUrl: `${payload.sourcePageUrl || ''}`.trim(),
          companyId: activeCompanyId,
        });
        if (result?.queued) {
          setManualAttachUi(resolution.assetId, { pending: true, phase: 'extracting', tone: 'info', message: 'Manual attachment queued. Extracting text…' });
          render();
          const latest = await pollManualAttachStatus(resolution.assetId);
          const latestStatus = `${latest.manualAttachStatus || ''}`.trim().toLowerCase();
          if (latestStatus === 'completed') {
            const chunkCount = Number(latest?.manualChunkCount || 0) || 0;
            const codeCount = Number(latest?.extractedCodeCount || 0) || 0;
            setManualAttachUi(resolution.assetId, {
              pending: false,
              phase: 'idle',
              tone: 'success',
              message: `Manual attached and text extracted: ${chunkCount} chunks${codeCount ? `, ${codeCount} codes` : ''}.`,
            });
          } else if (latestStatus === 'failed') {
            setManualAttachUi(resolution.assetId, { pending: false, phase: 'idle', tone: 'error', message: 'Manual attachment failed. Please verify the URL and try again.' });
          } else {
            setManualAttachUi(resolution.assetId, { pending: false, phase: 'idle', tone: 'info', message: 'Manual attachment is still processing. Refresh in a moment for final status.' });
          }
        } else {
          const chunkCount = Number(result?.chunkCount || 0) || 0;
          const message = result?.warning || (chunkCount > 0 ? `Manual attached and text extracted: ${chunkCount} chunks.` : 'Manual attached.');
          setManualAttachUi(resolution.assetId, { pending: false, phase: 'idle', tone: result?.warning ? 'warn' : 'success', message });
        }
        await refreshData();
      } catch (error) {
        setManualAttachUi(resolution.assetId, { pending: false, phase: 'idle', tone: 'error', message: mapManualAttachErrorMessage(error) });
      }
      render();
    }),
    uploadAndAttachManualFile: async (id, file = null) => safeWithGlobalBusy('Attaching manual…', 'Downloading and extracting manual text. This can take up to a minute.', async () => {
      if (!isManager(state.permissions) || typeof attachAssetManualFromStoragePath !== 'function') return;
      const resolution = resolveManualAttachAsset(id);
      if (!resolution.ok) {
        setManualAttachUi(resolution.assetId || `${id || ''}`.trim() || 'unknown', { tone: 'error', message: resolution.message });
        console.warn('upload_manual_attach:missing_asset_context', { requestedAssetId: `${id || ''}`.trim() || null });
        render();
        return;
      }
      if (!file) {
        setManualAttachUi(resolution.assetId, { tone: 'error', message: 'Choose a manual file first.' });
        render();
        return;
      }
      const extension = `${file?.name || ''}`.split('.').pop().toLowerCase();
      if (!ALLOWED_MANUAL_FILE_EXTENSIONS.has(extension)) {
        setManualAttachUi(resolution.assetId, { tone: 'error', message: 'Attachment failed: supported file types are PDF, TXT, HTML, DOC, and DOCX.' });
        render();
        return;
      }
      if (Number(file.size || 0) > MAX_MANUAL_UPLOAD_BYTES) {
        setManualAttachUi(resolution.assetId, { tone: 'error', message: 'Attachment failed: file must be 25 MB or smaller.' });
        render();
        return;
      }
      const asset = resolution.asset || {};
      const companyId = `${state.company?.id || state.activeMembership?.companyId || asset.companyId || ''}`.trim();
      if (!resolution.assetId || !resolution.assetDocId) {
        setManualAttachUi(resolution.assetId || `${id || ''}`.trim() || 'unknown', { tone: 'error', message: MANUAL_ATTACH_ASSET_RESOLUTION_ERROR });
        render();
        return;
      }
      if (!companyId || !storage || typeof storageRef !== 'function' || typeof uploadBytes !== 'function') {
        setManualAttachUi(resolution.assetId, { tone: 'error', message: !companyId ? 'Cannot attach manual because company context is missing. Refresh and try again.' : 'Attachment failed: missing company/storage context.' });
        render();
        return;
      }
      const safeName = sanitizeStorageSegment(file.name || 'manual');
      const storagePath = `companies/${companyId}/manuals/${resolution.assetDocId}/manual-uploads/${Date.now()}-${safeName}`;
      try {
        console.debug('upload_manual_attach:start', { assetId: resolution.assetId });
        setManualAttachUi(resolution.assetId, { pending: true, phase: 'uploading', tone: 'info', message: 'Uploading manual…' });
        render();
        await uploadBytes(storageRef(storage, storagePath), file, { contentType: file.type || 'application/octet-stream' });
        console.debug('attach_manual_from_storage_path:start', {
          assetId: resolution.assetId,
          assetDocId: resolution.assetDocId,
          storedAssetId: resolution.storedAssetId || '',
          companyId,
          storagePathPresent: !!storagePath,
          storagePathPrefix: storagePath.split('/').slice(0, 4).join('/'),
          contentType: `${file.type || ''}`.trim(),
          originalFileName: `${file.name || ''}`.trim(),
        });
        setManualAttachUi(resolution.assetId, { pending: true, phase: 'extracting', tone: 'info', message: 'Extracting manual text…' });
        render();
        const result = await attachAssetManualFromStoragePath({
          assetId: resolution.assetId,
          assetDocId: resolution.assetDocId,
          assetName: `${asset?.name || ''}`.trim(),
          storedAssetId: resolution.storedAssetId || '',
          storagePath,
          sourceTitle: `${asset.name || ''}`.trim(),
          originalFileName: `${file.name || ''}`.trim(),
          contentType: `${file.type || ''}`.trim(),
          companyId,
        });
        if (result?.queued) {
          setManualAttachUi(resolution.assetId, { pending: true, phase: 'extracting', tone: 'info', message: 'Manual attachment queued. Extracting text…' });
          render();
          const latest = await pollManualAttachStatus(resolution.assetId);
          const latestStatus = `${latest.manualAttachStatus || ''}`.trim().toLowerCase();
          if (latestStatus === 'completed') {
            const chunkCount = Number(latest?.manualChunkCount || 0) || 0;
            const codeCount = Number(latest?.extractedCodeCount || 0) || 0;
            setManualAttachUi(resolution.assetId, {
              pending: false,
              phase: 'idle',
              tone: 'success',
              message: `Manual attached and text extracted: ${chunkCount} chunks${codeCount ? `, ${codeCount} codes` : ''}.`,
            });
          } else if (latestStatus === 'failed') {
            setManualAttachUi(resolution.assetId, { pending: false, phase: 'idle', tone: 'error', message: 'Manual attachment failed. Please verify the file and try again.' });
          } else {
            setManualAttachUi(resolution.assetId, { pending: false, phase: 'idle', tone: 'info', message: 'Manual attachment is still processing. Refresh in a moment for final status.' });
          }
        } else {
          const chunkCount = Number(result?.chunkCount || 0) || 0;
          const message = result?.warning || (chunkCount > 0 ? `Manual attached and text extracted: ${chunkCount} chunks.` : 'Manual attached.');
          setManualAttachUi(resolution.assetId, { pending: false, phase: 'idle', tone: result?.warning ? 'warn' : 'success', message });
        }
        await refreshData();
      } catch (error) {
        setManualAttachUi(resolution.assetId, { pending: false, phase: 'idle', tone: 'error', message: mapManualAttachErrorMessage(error) });
      }
      render();
    }),
    editAsset: async (currentId, payload) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === currentId) || {};
      const nextId = `${payload.id || currentId}`.trim() || currentId;
      await upsertEntity('assets', nextId, {
        ...current,
        ...payload,
        id: nextId,
        name: `${payload.name || current.name || ''}`.trim(),
        locationId: `${payload.locationId || current.locationId || ''}`.trim(),
        locationName: `${payload.locationName || current.locationName || ''}`.trim(),
        serialNumber: `${payload.serialNumber || current.serialNumber || ''}`.trim(),
        manufacturer: `${payload.manufacturer || current.manufacturer || ''}`.trim(),
        manualLinks: `${payload.manualLinks || ''}`.split(',').map((value) => value.trim()).filter(Boolean),
        ...(`${payload.manualLinks || ''}`.trim() ? {} : { manualLibraryRef: '', manualStoragePath: '' }),
        manualStatus: deriveManualStatus({
          ...current,
          manualLinks: `${payload.manualLinks || ''}`.split(',').map((value) => value.trim()).filter(Boolean),
          ...(`${payload.manualLinks || ''}`.trim() ? {} : { manualLibraryRef: '', manualStoragePath: '' })
        }),
        maintenancePlan: parseMaintenancePlanPatch(payload, current)
      }, state.user);
      if (nextId !== currentId) await deleteEntity('assets', currentId, state.user);
      await refreshData();
      render();
    },
    markDocsReviewed: async (id) => {
      const current = state.assets.find((asset) => asset.id === id) || {};
      await upsertEntity('assets', id, { ...current, docsLastReviewedAt: new Date().toISOString() }, state.user);
      setAssetActionFeedback(id, 'Documentation review date updated.', 'success');
      await refreshData();
      render();
    },
    clearAssetEnrichmentState: async (id) => {
      if (!isManager(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      await upsertEntity('assets', id, {
        ...current,
        enrichmentStatus: 'idle',
        enrichmentFollowupQuestion: '',
        enrichmentFollowupAnswer: '',
        enrichmentRequestedAt: null
      }, state.user);
      setAssetActionFeedback(id, 'Cleared stuck documentation lookup state.', 'success');
      await refreshData();
      render();
    },
    deleteAsset: async (id) => safeWithGlobalBusy('Deleting asset…', 'This can take a few seconds. Please do not refresh.', async () => {
      if (!canDelete(state.permissions)) return;
      await deleteEntity('assets', id, state.user);
      await refreshData();
      render();
    }),
    setLocationFilter: (locationKey) => {
      state.route = { ...state.route, locationKey: locationKey || null };
      if (typeof onLocationFilter === 'function') onLocationFilter(locationKey || null);
    }
  };
  return actions;
}
