const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { requestAssetDocumentationLookup } = require('./openaiService');

function normalizeDocumentationSuggestions(links, confidence) {
  if (!Array.isArray(links)) return [];
  const fallbackConfidence = Math.max(0.35, Number(confidence) || 0);
  return links
    .filter((row) => row && /^https?:\/\//.test(`${row.url || ''}`))
    .slice(0, 5)
    .map((row, idx) => ({
      title: row.title || `Candidate documentation ${idx + 1}`,
      url: row.url,
      confidence: fallbackConfidence,
      sourceType: row.sourceType || 'other'
    }));
}

function buildLookupContext(asset, assetId) {
  return {
    assetName: asset.name || '',
    manufacturer: asset.manufacturer || '',
    serialNumber: asset.serialNumber || '',
    assetId: asset.id || assetId,
    lookupTargets: [
      'arcade game manual',
      'operator manual',
      'service manual',
      'parts manual',
      'manufacturer documentation'
    ],
    notes: 'Identify likely manufacturer/model/category and provide documentation links. Ask one short follow-up question only if needed.'
  };
}

async function enrichAssetDocumentation({ db, assetId, userId, settings, triggerSource, traceId }) {
  const assetRef = db.collection('assets').doc(assetId);
  const assetSnap = await assetRef.get();
  if (!assetSnap.exists) throw new HttpsError('not-found', 'Asset not found');
  const asset = assetSnap.data() || {};

  await assetRef.set({
    enrichmentStatus: triggerSource === 'post_save' ? 'searching_docs' : 'in_progress',
    enrichmentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId
  }, { merge: true });

  const context = buildLookupContext(asset, assetId);
  const { parsed } = await requestAssetDocumentationLookup({
    model: settings.aiModel || 'gpt-4.1-mini',
    traceId,
    context
  });

  const confidence = Number(parsed?.confidence || 0);
  const suggestions = normalizeDocumentationSuggestions(parsed?.documentationLinks, confidence);
  const normalizedName = parsed?.normalizedName || asset.name || '';
  const manufacturerSuggestion = parsed?.likelyManufacturer || '';
  const confidenceThreshold = settings.aiConfidenceThreshold || 0.45;

  const hasConfidentSingleMatch = confidence >= confidenceThreshold && suggestions.length <= 1;
  const followupQuestion = hasConfidentSingleMatch ? '' : (parsed?.oneFollowupQuestion || 'Can you confirm the manufacturer and exact model from the nameplate?');
  const shouldSetManufacturer = !asset.manufacturer && confidence >= Math.max(0.75, confidenceThreshold) && manufacturerSuggestion;

  const status = suggestions.length ? (hasConfidentSingleMatch ? 'docs_found' : 'needs_follow_up') : 'no_match_yet';

  const updatePayload = {
    normalizedName,
    documentationSuggestions: suggestions,
    enrichmentConfidence: confidence,
    enrichmentFollowupQuestion: followupQuestion,
    enrichmentStatus: status,
    enrichmentCandidates: [
      manufacturerSuggestion,
      parsed?.likelyCategory,
      parsed?.normalizedName
    ].filter(Boolean).slice(0, 5),
    enrichmentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId
  };

  if (manufacturerSuggestion) updatePayload.manufacturerSuggestion = manufacturerSuggestion;
  if (shouldSetManufacturer) updatePayload.manufacturer = manufacturerSuggestion;

  await assetRef.set(updatePayload, { merge: true });

  await db.collection('auditLogs').add({
    action: 'asset_enrichment_run',
    entityType: 'assets',
    entityId: assetId,
    summary: `Asset enrichment ${triggerSource || 'manual'} for ${assetId}`,
    userUid: userId,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    confidence,
    suggestions: suggestions.length
  });

  return {
    ok: true,
    assetId,
    confidence,
    status,
    followupQuestion,
    suggestions
  };
}

module.exports = {
  enrichAssetDocumentation
};
