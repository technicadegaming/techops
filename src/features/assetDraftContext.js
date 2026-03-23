function normalizeId(value = '') {
  return `${value || ''}`.trim();
}

function normalizeText(value = '') {
  return `${value || ''}`.trim().toLowerCase();
}

export function resolveAssetDraftContext(state = {}, draft = state.assetDraft || {}) {
  const activeMembershipCompanyId = normalizeId(state.activeMembership?.companyId);
  const activeCompanyId = normalizeId(state.company?.id);
  const selectedLocationId = normalizeId(draft.locationId);
  const selectedLocationName = normalizeId(draft.locationName);
  const locationRecord = selectedLocationId
    ? (state.companyLocations || []).find((location) => normalizeId(location.id) === selectedLocationId) || null
    : null;
  const selectedLocationCompanyId = normalizeId(locationRecord?.companyId);
  const membershipResolved = activeMembershipCompanyId && activeMembershipCompanyId !== 'none';
  const companyResolved = activeCompanyId && activeCompanyId !== 'none';
  const resolvedCompanyId = activeMembershipCompanyId || activeCompanyId || '';

  if (!membershipResolved) {
    return {
      ok: false,
      reason: 'membership_unresolved',
      message: 'Cannot save yet because your company membership is still loading. Wait for the workspace context to finish resolving.',
      activeMembershipCompanyId,
      activeCompanyId,
      resolvedCompanyId,
      selectedLocationId,
      selectedLocationName,
      selectedLocationCompanyId,
      locationRecord,
      stamp: ''
    };
  }

  if (companyResolved && activeCompanyId !== activeMembershipCompanyId) {
    return {
      ok: false,
      reason: 'company_mismatch',
      message: 'Cannot save because the active workspace company does not match your resolved membership context. Refresh or re-select the correct company.',
      activeMembershipCompanyId,
      activeCompanyId,
      resolvedCompanyId,
      selectedLocationId,
      selectedLocationName,
      selectedLocationCompanyId,
      locationRecord,
      stamp: ''
    };
  }

  if (selectedLocationId && !locationRecord) {
    return {
      ok: false,
      reason: 'location_missing',
      message: 'Cannot save because the selected location is no longer available in this company workspace.',
      activeMembershipCompanyId,
      activeCompanyId,
      resolvedCompanyId,
      selectedLocationId,
      selectedLocationName,
      selectedLocationCompanyId,
      locationRecord,
      stamp: ''
    };
  }

  if (selectedLocationCompanyId && selectedLocationCompanyId !== activeMembershipCompanyId) {
    return {
      ok: false,
      reason: 'location_company_mismatch',
      message: 'Cannot save because the selected location belongs to a different company than your active workspace.',
      activeMembershipCompanyId,
      activeCompanyId,
      resolvedCompanyId,
      selectedLocationId,
      selectedLocationName,
      selectedLocationCompanyId,
      locationRecord,
      stamp: ''
    };
  }

  const resolvedLocationName = normalizeId(locationRecord?.name || selectedLocationName);
  const stamp = [resolvedCompanyId, selectedLocationId || '', normalizeText(resolvedLocationName || '')].join('|');

  return {
    ok: !!resolvedCompanyId,
    reason: resolvedCompanyId ? 'ok' : 'company_unresolved',
    message: resolvedCompanyId ? '' : 'Cannot save because no active company context is available.',
    activeMembershipCompanyId,
    activeCompanyId,
    resolvedCompanyId,
    selectedLocationId,
    selectedLocationName: resolvedLocationName,
    selectedLocationCompanyId,
    locationRecord,
    stamp
  };
}

export function doesPreviewContextMatch(currentContext = {}, previewContext = {}) {
  const currentStamp = normalizeId(currentContext?.stamp);
  const previewStamp = normalizeId(previewContext?.stamp);
  return !!currentStamp && !!previewStamp && currentStamp === previewStamp;
}

export function buildAssetDraftContextDebug(context = {}) {
  return `company: ${context.resolvedCompanyId || 'none'} | membership: ${context.activeMembershipCompanyId || 'none'} | location: ${context.selectedLocationId || context.selectedLocationName || 'none'}`;
}
