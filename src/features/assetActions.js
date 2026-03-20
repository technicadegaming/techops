import { buildDocumentationApprovalPatch, buildDocumentationApprovalSelection } from './documentationReview.js';
import {
  approveSuggestedManualSources,
  buildFollowupEnrichmentRequest,
  buildManualEnrichmentRequest
} from './assetEnrichmentPipeline.js';

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

  const actions = {
    saveAsset: async (id, payload) => {
      const name = `${payload.name || ''}`.trim();
      const manufacturer = `${payload.manufacturer || ''}`.trim();
      if (!name) return alert('Asset name is required.');
      if (!manufacturer) return alert('Manufacturer is required.');
      state.assetDraft = { ...(state.assetDraft || {}), saving: true, saveFeedback: '', saveFeedbackTone: 'success', saveDebugContext: '' };
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
          locationId: `${payload.locationId || current.locationId || ''}`.trim(),
          locationName: `${payload.locationName || current.locationName || ''}`.trim(),
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
      const assetName = `${payload?.assetName || ''}`.trim();
      const normalizedQuery = deps.buildPreviewQueryKey(payload);
      const previewMeta = state.assetDraft?.previewMeta || { inFlightQuery: '', lastCompletedQuery: '' };
      const normalizedName = assetName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (assetName.length < 3 || !normalizedName) {
        state.assetDraft = {
          ...state.assetDraft,
          preview: null,
          previewStatus: 'idle',
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
        previewMeta: { ...previewMeta, inFlightQuery: normalizedQuery },
        draftNameNormalized: normalizedName
      };
      render();

      try {
        const preview = await previewAssetDocumentationLookup(payload);
        state.assetDraft = {
          ...state.assetDraft,
          preview,
          previewStatus: preview?.status || 'found_suggestions',
          previewMeta: { inFlightQuery: '', lastCompletedQuery: normalizedQuery },
          draftNameNormalized: normalizedName
        };
      } catch {
        state.assetDraft = {
          ...state.assetDraft,
          previewStatus: 'no_strong_match',
          previewMeta: { ...previewMeta, inFlightQuery: '' },
          draftNameNormalized: normalizedName
        };
      }
      render();
    },
    applyPreviewToDraft: (partialPayload = {}) => {
      const { triggerRefinedPreview, ...draftPatch } = partialPayload;
      state.assetDraft = { ...state.assetDraft, ...draftPatch };
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
    },
    handleDraftNameChange: (assetName) => {
      const normalizedName = `${assetName || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const previousNormalizedName = `${state.assetDraft?.draftNameNormalized || ''}`;
      const shouldClear = !normalizedName || (previousNormalizedName && normalizedName !== previousNormalizedName);
      if (!shouldClear) return;
      state.assetDraft = {
        ...state.assetDraft,
        preview: null,
        previewStatus: 'idle',
        previewMeta: { ...(state.assetDraft?.previewMeta || {}), inFlightQuery: '' },
        draftNameNormalized: normalizedName
      };
      render();
    },
    clearPreview: () => {
      state.assetDraft = {
        ...state.assetDraft,
        preview: null,
        previewStatus: 'idle',
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
        await enrichAssetDocumentation(id, buildManualEnrichmentRequest());
        setAssetActionFeedback(id, 'Documentation lookup finished. Review the suggestions below.', 'success');
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
        await enrichAssetDocumentation(id, buildFollowupEnrichmentRequest(trimmedAnswer));
        setAssetActionFeedback(id, 'Follow-up submitted. Review the refreshed suggestions.', 'success');
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
      await upsertEntity('assets', id, { ...current, ...buildDocumentationApprovalPatch(current, approvedEntries, { reviewAction: 'asset_apply_top_trusted_docs' }) }, state.user);
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
        const suggestedManufacturer = `${current.manufacturerSuggestion || ''}`.trim();
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
      await upsertEntity('assets', id, { ...current, ...patch }, state.user);
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
      await upsertEntity('assets', id, { ...current, ...buildDocumentationApprovalPatch(current, [selected], { reviewAction: 'asset_apply_single_manual' }) }, state.user);
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
      await upsertEntity('assets', id, { ...current, supportResourcesSuggestion: normalizeSupportEntries([...(current.supportResourcesSuggestion || []), { url, label }]) }, state.user);
      setAssetActionFeedback(id, 'Applied one support link.', 'success');
      await refreshData();
      render();
    },
    removeManualLink: async (id, url) => {
      if (!isAdmin(state.permissions)) return;
      const clean = `${url || ''}`.trim();
      if (!clean) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      await upsertEntity('assets', id, { ...current, manualLinks: (current.manualLinks || []).filter((entry) => `${entry}`.trim() !== clean) }, state.user);
      setAssetActionFeedback(id, 'Removed linked manual.', 'success');
      await refreshData();
      render();
    },
    removeSupportLink: async (id, url) => {
      if (!isAdmin(state.permissions)) return;
      const clean = `${url || ''}`.trim();
      if (!clean) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      await upsertEntity('assets', id, {
        ...current,
        supportResourcesSuggestion: normalizeSupportEntries((current.supportResourcesSuggestion || []).filter((entry) => `${entry?.url || entry || ''}`.trim() !== clean))
      }, state.user);
      setAssetActionFeedback(id, 'Removed linked support link.', 'success');
      await refreshData();
      render();
    },
    removeAllManualLinks: async (id) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      await upsertEntity('assets', id, { ...current, manualLinks: [] }, state.user);
      setAssetActionFeedback(id, 'Removed all linked manuals.', 'success');
      await refreshData();
      render();
    },
    removeAllSupportLinks: async (id) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      await upsertEntity('assets', id, { ...current, supportResourcesSuggestion: [] }, state.user);
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
        manualLinks: `${payload.manualLinks || ''}`.split(',').map((value) => value.trim()).filter(Boolean)
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
