export function createAssetActions(deps) {
  const {
    state,
    onLocationFilter,
    render,
    refreshData,
    runAction,
    withRequiredCompanyId,
    upsertEntity,
    deleteEntity,
    enrichAssetDocumentation,
    previewAssetDocumentationLookup,
    markAssetEnrichmentFailure,
    normalizeAssetId,
    pickUniqueAssetId,
    createEmptyAssetDraft,
    withTimeout,
    dedupeUrls,
    normalizeSupportEntries,
    canDelete,
    isAdmin,
    isManager,
    buildAssetSaveErrorMessage,
    buildAssetSaveDebugContext,
    isPermissionRelatedError
  } = deps;

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
          history: payload.historyNote ? [...(current.history || []), { at: new Date().toISOString(), note: payload.historyNote }] : (current.history || []),
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
      await upsertEntity('assets', id, {
        ...current,
        enrichmentStatus: 'in_progress',
        enrichmentRequestedAt: new Date().toISOString(),
        enrichmentErrorCode: '',
        enrichmentErrorMessage: '',
        enrichmentFailedAt: null
      }, state.user);
      await refreshData();
      render();
      try {
        await enrichAssetDocumentation(id, { trigger: 'manual' });
      } catch (error) {
        console.error('[asset_manual_enrichment]', error);
        const failure = await markAssetEnrichmentFailure(id, error, true);
        alert(failure.message);
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
        enrichmentErrorCode: '',
        enrichmentErrorMessage: '',
        enrichmentFailedAt: null
      }, state.user);
      await refreshData();
      render();
      try {
        await enrichAssetDocumentation(id, { trigger: 'followup_answer', followupAnswer: trimmedAnswer });
      } catch (error) {
        console.error('[asset_followup_enrichment]', error);
        const failure = await markAssetEnrichmentFailure(id, error, true);
        alert(failure.message);
      }
      await refreshData();
      render();
    },
    applyDocSuggestions: async (id) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const suggestions = Array.isArray(current.documentationSuggestions) ? current.documentationSuggestions : [];
      const strongSuggestions = suggestions
        .filter((entry) => {
          const score = Number(entry?.matchScore || 0);
          const isStrong = score >= 70 || (entry?.isOfficial && score >= 62) || (entry?.sourceType === 'manufacturer' && score >= 60);
          return isStrong && !!entry?.verified;
        })
        .sort((a, b) => Number(b?.matchScore || 0) - Number(a?.matchScore || 0));
      const links = strongSuggestions.slice(0, 2).map((entry) => entry.url).filter(Boolean);
      if (!links.length) {
        const weakQuestion = current.enrichmentFollowupQuestion || 'Can you confirm cabinet type/version from the manufacturer plate?';
        await upsertEntity('assets', id, { ...current, enrichmentStatus: 'followup_needed', enrichmentFollowupQuestion: weakQuestion }, state.user);
        await refreshData();
        render();
        return;
      }
      await upsertEntity('assets', id, { ...current, manualLinks: dedupeUrls([...(current.manualLinks || []), ...links]), enrichmentStatus: 'verified_manual_found', enrichmentFollowupQuestion: '' }, state.user);
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
        const strongManuals = (Array.isArray(current.documentationSuggestions) ? current.documentationSuggestions : [])
          .filter((entry) => !!entry?.verified)
          .sort((a, b) => Number(b?.matchScore || 0) - Number(a?.matchScore || 0))
          .map((entry) => entry?.url)
          .filter(Boolean)
          .slice(0, 2);
        if (strongManuals.length) patch.manualLinks = dedupeUrls([...(current.manualLinks || []), ...strongManuals]);
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
      await upsertEntity('assets', id, { ...current, ...patch }, state.user);
      await refreshData();
      render();
    },
    applySingleDocSuggestion: async (id, index) => {
      if (!isAdmin(state.permissions)) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      const suggestions = Array.isArray(current.documentationSuggestions) ? current.documentationSuggestions : [];
      const selected = suggestions[index];
      const url = `${selected?.url || ''}`.trim();
      if (!url) return;
      await upsertEntity('assets', id, { ...current, manualLinks: dedupeUrls([...(current.manualLinks || []), url]), enrichmentStatus: 'verified_manual_found' }, state.user);
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
      await refreshData();
      render();
    },
    removeManualLink: async (id, url) => {
      if (!isAdmin(state.permissions)) return;
      const clean = `${url || ''}`.trim();
      if (!clean) return;
      const current = state.assets.find((asset) => asset.id === id) || {};
      await upsertEntity('assets', id, { ...current, manualLinks: (current.manualLinks || []).filter((entry) => `${entry}`.trim() !== clean) }, state.user);
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
