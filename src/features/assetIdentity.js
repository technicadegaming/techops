export function getAssetRecordId(asset = {}) {
  const preferred = [asset?.firestoreDocId, asset?.docId, asset?._docId, asset?.assetRecordId]
    .map((value) => `${value || ''}`.trim())
    .find(Boolean);
  if (preferred) return preferred;
  const fallbackId = `${asset?.id || ''}`.trim();
  return fallbackId;
}

export function toCanonicalAssetRecord(asset = {}) {
  const canonicalId = `${asset?.firestoreDocId || asset?.docId || asset?._docId || asset?.id || ''}`.trim();
  const storedAssetId = `${asset?.storedAssetId || ''}`.trim() || `${asset?.id || ''}`.trim();
  return {
    ...asset,
    id: canonicalId || `${asset?.id || ''}`.trim(),
    firestoreDocId: canonicalId || `${asset?.firestoreDocId || ''}`.trim(),
    docId: canonicalId || `${asset?.docId || ''}`.trim(),
    _docId: canonicalId || `${asset?._docId || ''}`.trim(),
    assetRecordId: canonicalId || `${asset?.assetRecordId || ''}`.trim(),
    storedAssetId,
  };
}

export function findAssetByRecordId(assets = [], requestedId = '') {
  const wanted = `${requestedId || ''}`.trim();
  if (!wanted) return null;
  return (Array.isArray(assets) ? assets : []).find((asset) => getAssetRecordId(asset) === wanted) || null;
}
