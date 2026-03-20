function normalizeAssetEnrichmentTriggerSource(triggerSource) {
  const normalized = `${triggerSource || ''}`.trim().toLowerCase();
  if (!normalized) return 'manual';
  if (normalized === 'bulk_admin_review') return 'manual';
  if (normalized === 'onboarding_asset_step') return 'manual';
  if (['manual', 'post_save', 'followup_answer', 'auto_create'].includes(normalized)) return normalized;
  return 'manual';
}

module.exports = {
  normalizeAssetEnrichmentTriggerSource,
};
