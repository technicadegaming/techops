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

module.exports = {
  getManualAttachAssetIds,
  resolveManualAttachAssetId,
  summarizeManualAttachUrl,
};
