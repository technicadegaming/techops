const { HttpsError } = require('firebase-functions/v2/https');

function getManualAttachAssetIds(data = {}) {
  const assetDocId = `${data?.assetDocId || ''}`.trim();
  const assetId = `${data?.assetId || ''}`.trim();
  return { assetDocId, assetId };
}

function resolveManualAttachAssetId(data = {}) {
  const ids = getManualAttachAssetIds(data);
  if (ids.assetDocId) return ids.assetDocId;
  return ids.assetId;
}

function summarizeManualAttachUrl(manualUrl = '') {
  const value = `${manualUrl || ''}`.trim();
  if (!value) return { host: '', pathLength: 0 };
  try {
    const parsed = new URL(value);
    return { host: parsed.hostname || '', pathLength: `${parsed.pathname || ''}`.length };
  } catch (error) {
    void error;
    return { host: '', pathLength: value.length };
  }
}

function normalizeCompanyId(value = '') {
  return `${value || ''}`.trim();
}

function buildNormalizedAssetRecord(docId = '', data = {}) {
  const assetData = data || {};
  return {
    ...assetData,
    id: docId,
    firestoreDocId: docId,
    storedAssetId: `${assetData.id || assetData.storedAssetId || ''}`.trim(),
  };
}

async function resolveManualAttachAsset({
  db,
  requestedAssetId = '',
  requestedAssetDocId = '',
  requestedCompanyId = '',
  uid = '',
  getUserRole,
  authorizeAssetEnrichment,
  authorizeCompanyMember,
  canRunAssetEnrichment,
} = {}) {
  const normalizedAssetId = `${requestedAssetId || ''}`.trim();
  const normalizedAssetDocId = `${requestedAssetDocId || ''}`.trim();
  const normalizedCompanyId = normalizeCompanyId(requestedCompanyId);

  const candidateDocIds = [];
  if (normalizedAssetDocId) candidateDocIds.push(normalizedAssetDocId);
  if (normalizedAssetId && normalizedAssetId !== normalizedAssetDocId) candidateDocIds.push(normalizedAssetId);

  for (const candidateDocId of candidateDocIds) {
    const authz = await authorizeAssetEnrichment({
      db,
      assetId: candidateDocId,
      uid,
      getUserRole,
    });

    if (!authz.allowed) {
      if (authz.scope === 'asset_not_found') continue;
      throw new HttpsError('permission-denied', 'Insufficient role for manual attachment');
    }

    const rawAsset = authz.asset || {};
    const resolvedCompanyId = normalizeCompanyId(rawAsset.companyId || authz.companyId || normalizedCompanyId);
    if (normalizedCompanyId && resolvedCompanyId && normalizedCompanyId !== resolvedCompanyId) {
      throw new HttpsError('permission-denied', 'Asset/company mismatch for manual attachment.');
    }
    const storedAssetId = `${rawAsset.storedAssetId || rawAsset.id || ''}`.trim();
    return {
      assetDocId: candidateDocId,
      assetRef: db.collection('assets').doc(candidateDocId),
      asset: buildNormalizedAssetRecord(candidateDocId, rawAsset),
      storedAssetId,
      companyId: resolvedCompanyId,
      resolutionSource: candidateDocId === normalizedAssetDocId ? 'docId_assetDocId' : 'docId_assetId',
      authzScope: authz.scope || 'unknown',
      status: 'found',
    };
  }

  if (!normalizedCompanyId || !normalizedAssetId) {
    return { status: 'missing' };
  }

  const companyAuthz = await authorizeCompanyMember({
    uid,
    companyId: normalizedCompanyId,
    checkAccess: canRunAssetEnrichment,
  });
  if (!companyAuthz.allowed) {
    throw new HttpsError('permission-denied', 'Insufficient role for manual attachment');
  }

  const legacyIdQuerySnap = await db.collection('assets')
    .where('companyId', '==', normalizedCompanyId)
    .where('id', '==', normalizedAssetId)
    .get();

  if (legacyIdQuerySnap.size > 1) {
    throw new HttpsError('failed-precondition', 'Multiple asset records matched this legacy id. Open the asset record and try again.');
  }

  if (legacyIdQuerySnap.size === 1) {
    const doc = legacyIdQuerySnap.docs[0];
    const rawAsset = doc.data() || {};
    const resolvedCompanyId = normalizeCompanyId(rawAsset.companyId || normalizedCompanyId);
    if (resolvedCompanyId !== normalizedCompanyId) {
      throw new HttpsError('permission-denied', 'Asset/company mismatch for manual attachment.');
    }
    const storedAssetId = `${rawAsset.storedAssetId || rawAsset.id || ''}`.trim();
    return {
      assetDocId: doc.id,
      assetRef: doc.ref,
      asset: buildNormalizedAssetRecord(doc.id, rawAsset),
      storedAssetId,
      companyId: resolvedCompanyId,
      resolutionSource: 'legacy_id_field',
      authzScope: companyAuthz.scope || 'unknown',
      status: 'found',
    };
  }

  const storedAssetIdQuerySnap = await db.collection('assets')
    .where('companyId', '==', normalizedCompanyId)
    .where('storedAssetId', '==', normalizedAssetId)
    .get();

  if (storedAssetIdQuerySnap.size > 1) {
    throw new HttpsError('failed-precondition', 'Multiple asset records matched this legacy id. Open the asset record and try again.');
  }

  if (storedAssetIdQuerySnap.size === 1) {
    const doc = storedAssetIdQuerySnap.docs[0];
    const rawAsset = doc.data() || {};
    const resolvedCompanyId = normalizeCompanyId(rawAsset.companyId || normalizedCompanyId);
    if (resolvedCompanyId !== normalizedCompanyId) {
      throw new HttpsError('permission-denied', 'Asset/company mismatch for manual attachment.');
    }
    const storedAssetId = `${rawAsset.storedAssetId || rawAsset.id || ''}`.trim();
    return {
      assetDocId: doc.id,
      assetRef: doc.ref,
      asset: buildNormalizedAssetRecord(doc.id, rawAsset),
      storedAssetId,
      companyId: resolvedCompanyId,
      resolutionSource: 'storedAssetId_field',
      authzScope: companyAuthz.scope || 'unknown',
      status: 'found',
    };
  }

  return { status: 'missing', authzScope: companyAuthz.scope || 'unknown' };
}

function normalizeManualAttachRequestContext({
  requestData = {},
  resolution = null,
} = {}) {
  const requestedAssetId = `${requestData?.assetId || ''}`.trim();
  const requestedAssetDocId = `${requestData?.assetDocId || ''}`.trim();
  const requestedCompanyId = normalizeCompanyId(requestData?.companyId);
  const manualUrl = `${requestData?.manualUrl || ''}`.trim();
  const sourceTitle = `${requestData?.sourceTitle || ''}`.trim();
  const resolvedAssetDocId = `${resolution?.assetDocId || ''}`.trim();
  const resolvedAsset = resolution?.asset
    ? buildNormalizedAssetRecord(resolvedAssetDocId || `${resolution.asset.id || ''}`.trim(), resolution.asset)
    : null;
  return {
    requestedAssetId,
    requestedAssetDocId,
    requestedCompanyId,
    manualUrl,
    sourceTitle,
    resolvedAssetDocId,
    resolvedAsset,
    resolutionSource: `${resolution?.resolutionSource || ''}`.trim(),
  };
}

module.exports = {
  getManualAttachAssetIds,
  resolveManualAttachAssetId,
  summarizeManualAttachUrl,
  resolveManualAttachAsset,
  normalizeManualAttachRequestContext,
};
