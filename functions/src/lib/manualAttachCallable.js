function resolveManualAttachAssetId(data = {}) {
  const primary = `${data?.assetId || ''}`.trim();
  if (primary) return primary;
  return `${data?.assetDocId || ''}`.trim();
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
  resolveManualAttachAssetId,
  summarizeManualAttachUrl,
};
