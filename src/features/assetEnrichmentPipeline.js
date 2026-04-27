export function buildManualEnrichmentRequest() {
  return { trigger: 'manual' };
}

export function buildFollowupEnrichmentRequest(answer = '') {
  return {
    trigger: 'followup_answer',
    followupAnswer: `${answer || ''}`.trim()
  };
}

export function buildFollowupRetryWithoutAnswerRequest() {
  return {
    trigger: 'followup_retry_without_answer'
  };
}

export async function approveSuggestedManualSources({
  assetId,
  urls = [],
  current = {},
  metadataByUrl = {},
  approveAssetManual,
  logLabel = 'approve_asset_manual',
  limit = 2
}) {
  const uniqueUrls = Array.from(new Set((urls || []).map((url) => `${url || ''}`.trim()).filter(Boolean))).slice(0, limit);
  if (!uniqueUrls.length) return { completed: 0, failed: 0 };

  let completed = 0;
  let failed = 0;
  for (const url of uniqueUrls) {
    try {
      const meta = metadataByUrl[url] || {};
      await approveAssetManual({
        assetId,
        sourceUrl: url,
        sourceTitle: meta.title || current.name || url,
        sourceType: meta.sourceType || 'approved_doc',
        approvedSuggestionIndex: Number.isInteger(meta.index) ? meta.index : undefined
      });
      completed += 1;
    } catch (error) {
      failed += 1;
      console.error(`[${logLabel}]`, { assetId, url, error });
    }
  }

  return { completed, failed };
}
