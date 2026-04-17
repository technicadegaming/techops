import { buildDocumentationApprovalPatch, buildDocumentationApprovalSelection, deriveManualStatus } from './documentationReview.js';
import { buildAssetCsv, buildAssetImportRow, enrichAssetIntakeRows, parseTitleBulkInput } from './assetIntake.js';
import {
  approveSuggestedManualSources,
  buildFollowupEnrichmentRequest,
  buildManualEnrichmentRequest
} from './assetEnrichmentPipeline.js';
import {
  buildAssetDraftContextDebug,
  doesPreviewContextMatch,
  resolveAssetDraftContext
} from './assetDraftContext.js';
import { normalizeManufacturerDisplayName } from './manufacturerNormalization.js';

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
    enrichAssetDocumentation,
    previewAssetDocumentationLookup,
    researchAssetTitles,
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
    isPermissionRelatedError
  } = deps;

  const parseReferenceList = (value = '') => `${value || ''}`
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const setAssetActionFeedback = (assetId, message, tone = 'info') => {
    state.assetUi = {
      ...(state.assetUi || {}),
      lastActionByAsset: {
        ...((state.assetUi && state.assetUi.lastActionByAsset) || {}),
        [assetId]: { message, tone }
      }
    };
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
    const hasAttachedManual = manualStatus === 'attached' || !!(manualLibraryRef || manualStoragePath || manualLinks.length);

    if (hasAttachedManual || status === 'docs_found' || status === 'verified_manual_found') {
      return {
        message: `Documentation lookup finished. ${manualLibraryRef || manualStoragePath ? 'A shared manual was attached to this asset.' : 'Manual evidence is now linked to this asset.'}`,
        tone: 'success'
      };
    }
    if (reviewableCount > 0) {
      return {
        message: `Documentation lookup finished. ${reviewableCount} reviewable manual suggestion${reviewableCount === 1 ? ' is' : 's are'} ready below.`,
        tone: 'success'
      };
    }
    if (status === 'followup_needed') {
      return {
        message: supportCount
          ? 'Documentation lookup finished. No reviewable manual was auto-linked, but support links or follow-up guidance are ready below.'
          : 'Documentation lookup finished. More detail is needed to confirm the right manual.',
        tone: 'info'
      };
    }
    if (status === 'no_match_yet') {
      return {
        message: 'Documentation lookup finished with no manual suggestion yet. The asset is no longer marked as searching.',
        tone: 'info'
      };
    }
    return {
      message: 'Documentation lookup finished.',
      tone: 'info'
    };
  };

  const actions = {
    saveAsset: async (id, payload) => {
      const name = `${payload.name || ''}`.trim();
      const manufacturer = `${payload.manufacturer || ''}`.trim();
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
        saveSecondaryFeedback: '',
        saveFeedbackTone: 'success',
        saveDebugContext: `Debug - ${buildAssetDraftContextDebug(context)}`
      };
      render();
      try {
        const desiredId = `${id || ''}`.trim() || normalizeAssetId(name);
        const current = state.assets.find((asset) => asset.id === desiredId) || {};
        const finalId = current.id ? desiredId : pickUniqueAssetId(desiredId, state.assets);
        const draft = state.assetDraft || {};
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
          notes: `${payload.notes || ''}`.trim() || `${current.notes || ''}`.trim() || (draft.notes ? `${draft.notes}`.trim() : '')
        };
        await withTimeout(
          upsertEntity('assets', finalId, withRequiredCompanyId(entityPayload, 'save an asset'), state.user),
          20000,
          'Asset save timed out. Please retry.'
        );
        state.assetDraft = { ...createEmptyAssetDraft(), saveFeedback: 'Asset saved.', saveFeedbackTone: 'success', saveDebugContext: '' };
        await refreshData();
        render();
        state.assetDraft = { ...(state.assetDraft || {}), saveSecondaryFeedback: 'Docs lookup is still pending.', saveFeedbackTone: 'success' };
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
      for (const row of rows) {
        const desiredId = `${row.assetId || ''}`.trim() || normalizeAssetId(row.name || 'asset');
        const finalId = pickUniqueAssetId(desiredId, state.assets);
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
          manualLinks: row.manualUrl ? [row.manualUrl] : [],
          manualSourceUrl: row.manualSourceUrl || '',
          supportResourcesSuggestion: normalizeSupportEntries(row.supportUrl ? [{ url: row.supportUrl, label: 'Support resource' }] : []),
          supportContactsSuggestion: supportContacts,
          enrichmentConfidence: Number(row.matchConfidence || row.confidence || 0) || null,
          manufacturerSuggestion: row.manufacturerSuggestion || '',
          categorySuggestion: row.categorySuggestion || '',
          importSource: 'bulk_title_intake',
          reviewState: row.rowStatus === 'good_match' ? 'ready' : 'pending_review',
          manualStatus: deriveManualStatus({
            manualLinks: row.manualUrl ? [row.manualUrl] : [],
            supportResourcesSuggestion: normalizeSupportEntries(row.supportUrl ? [{ url: row.supportUrl, label: 'Support resource' }] : []),
            documentationSuggestions: row.rowStatus === 'good_match' ? [] : (row.manualUrl ? [{ url: row.manualUrl, verified: true, exactTitleMatch: true, exactManualMatch: true }] : []),
          }),
          reviewReason: row.rowStatus === 'good_match' ? '' : 'bulk_title_review',
          matchNotes: row.matchNotes || ''
        }, 'bulk import assets'), state.user);
      }
      await refreshData();
      state.assetUi = { ...(state.assetUi || {}), bulkIntakeRows: [], bulkIntakeStatus: 'imported', bulkIntakeText: '' };
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
      } catch (error) {
        console.error('[asset_manual_enrichment]', error);
        const failure = await markAssetEnrichmentFailure(id, error, true);
        setAssetActionFeedback(id, failure.message, 'error');
      }
      await refreshData();
      render();
    },
    submitEnrichmentFollowup: async (id, answer) => {
      const trimmedAnswer = `${answer || ''}`.trim();
      if (!trimmedAnswer) return alert('Please enter an answer before retrying enrichment.');
      const current = state.assets.find((asset) => asset.id === id) || {};
      await upsertEntity('assets', id, {
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
        const result = await enrichAssetDocumentation(id, buildFollowupEnrichmentRequest(trimmedAnswer));
        await refreshData();
        const refreshed = state.assets.find((asset) => asset.id === id) || {};
        const feedback = buildCompletionFeedback(refreshed, result);
        setAssetActionFeedback(id, feedback.message, feedback.tone);
      } catch (error) {
        console.error('[asset_followup_enrichment]', error);
        const failure = await markAssetEnrichmentFailure(id, error, true);
        setAssetActionFeedback(id, failure.message, 'error');
      }
      await refreshData();
      render();
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
        })
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
    deleteAsset: async (id) => {
      if (!canDelete(state.permissions)) return;
      await deleteEntity('assets', id, state.user);
      await refreshData();
      render();
    },
    setLocationFilter: (locationKey) => {
      state.route = { ...state.route, locationKey: locationKey || null };
      if (typeof onLocationFilter === 'function') onLocationFilter(locationKey || null);
    }
  };
  return actions;
}
