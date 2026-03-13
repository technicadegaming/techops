const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { requestTroubleshootingPlan } = require('./openaiService');

function extractSuggestions(aiResult) {
  const citations = Array.isArray(aiResult?.citations) ? aiResult.citations : [];
  return citations
    .filter((url) => /^https?:\/\//.test(`${url}`))
    .slice(0, 5)
    .map((url, idx) => ({ title: `Candidate documentation ${idx + 1}`, url, confidence: Math.max(0.35, Number(aiResult?.confidence) || 0) }));
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

  const context = {
    task: {
      title: asset.name || asset.id,
      details: [
        `Asset ID: ${asset.id || assetId}`,
        `Manufacturer: ${asset.manufacturer || 'unknown'}`,
        `Serial Number: ${asset.serialNumber || 'unknown'}`,
        'Find likely manufacturer/model and documentation links. Return low confidence when uncertain.'
      ].join('\n')
    },
    asset,
    followupAnswers: []
  };

  const { parsed } = await requestTroubleshootingPlan({
    model: settings.aiModel || 'gpt-4.1-mini',
    traceId,
    settings,
    context
  });

  const confidence = Number(parsed?.confidence || 0);
  const suggestions = extractSuggestions(parsed);
  const normalizedName = parsed?.conciseIssueSummary ? `${parsed.conciseIssueSummary}`.slice(0, 140) : (asset.name || '');
  const inferredManufacturer = parsed?.probableCauses?.[0]?.split(':')[0]?.slice(0, 80) || asset.manufacturer || '';
  const hasConfidentSingleMatch = confidence >= (settings.aiConfidenceThreshold || 0.45) && suggestions.length <= 1;
  const followupQuestion = hasConfidentSingleMatch ? '' : (parsed?.diagnosticSteps?.[0] || 'Can you confirm the manufacturer and exact model on the nameplate?');

  await assetRef.set({
    normalizedName,
    manufacturer: asset.manufacturer || inferredManufacturer,
    documentationSuggestions: suggestions,
    enrichmentConfidence: confidence,
    enrichmentFollowupQuestion: followupQuestion,
    enrichmentStatus: suggestions.length ? (hasConfidentSingleMatch ? 'docs_found' : 'needs_follow_up') : 'no_match_yet',
    enrichmentCandidates: (parsed?.probableCauses || []).slice(0, 5),
    enrichmentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId
  }, { merge: true });

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
    status: suggestions.length ? (hasConfidentSingleMatch ? 'docs_found' : 'needs_follow_up') : 'no_match_yet',
    followupQuestion,
    suggestions
  };
}

module.exports = {
  enrichAssetDocumentation
};
