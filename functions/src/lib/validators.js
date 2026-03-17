function assertString(value, field) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${field} is required`);
  }
}

function sanitizeFollowupAnswers(answers) {
  if (!Array.isArray(answers)) throw new Error('answers must be an array');
  return answers
    .filter((row) => row && typeof row.question === 'string' && typeof row.answer === 'string')
    .map((row) => ({ question: row.question.trim().slice(0, 300), answer: row.answer.trim().slice(0, 2000) }))
    .filter((row) => row.question && row.answer);
}

function validateAiResultShape(result) {
  if (!result || typeof result !== 'object') throw new Error('AI response is not an object');
  const requiredArrays = ['probableCauses', 'immediateChecks', 'diagnosticSteps', 'recommendedFixes', 'toolsNeeded', 'partsPossiblyNeeded', 'safetyNotes', 'escalationSignals'];
  requiredArrays.forEach((k) => {
    if (!Array.isArray(result[k])) throw new Error(`Missing array field ${k}`);
  });
  if (typeof result.conciseIssueSummary !== 'string') throw new Error('Missing conciseIssueSummary');
  if (typeof result.shortFrontlineVersion !== 'string') throw new Error('Missing shortFrontlineVersion');
  if (typeof result.detailedManagerVersion !== 'string') throw new Error('Missing detailedManagerVersion');
  if (typeof result.confidence !== 'number') throw new Error('Missing confidence');
  return {
    conciseIssueSummary: result.conciseIssueSummary,
    probableCauses: result.probableCauses,
    immediateChecks: result.immediateChecks,
    diagnosticSteps: result.diagnosticSteps,
    recommendedFixes: result.recommendedFixes,
    toolsNeeded: result.toolsNeeded,
    partsPossiblyNeeded: result.partsPossiblyNeeded,
    safetyNotes: result.safetyNotes,
    escalationSignals: result.escalationSignals,
    confidence: Math.max(0, Math.min(1, result.confidence)),
    shortFrontlineVersion: result.shortFrontlineVersion,
    detailedManagerVersion: result.detailedManagerVersion,
    citations: Array.isArray(result.citations) ? result.citations : []
  };
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(`${value || ''}`);
    return /^https?:$/.test(parsed.protocol);
  } catch {
    return false;
  }
}

function validateAssetLookupResultShape(result) {
  if (!result || typeof result !== 'object') throw new Error('Asset lookup response is not an object');
  if (typeof result.normalizedName !== 'string') throw new Error('Missing normalizedName');
  if (typeof result.likelyManufacturer !== 'string') throw new Error('Missing likelyManufacturer');
  if (typeof result.likelyCategory !== 'string') throw new Error('Missing likelyCategory');
  if (typeof result.confidence !== 'number') throw new Error('Missing confidence');

  const docs = Array.isArray(result.documentationLinks) ? result.documentationLinks : [];
  const resources = Array.isArray(result.supportResources) ? result.supportResources : [];
  const contacts = Array.isArray(result.supportContacts) ? result.supportContacts : [];
  const alternateNames = Array.isArray(result.alternateNames) ? result.alternateNames : [];
  const searchHints = Array.isArray(result.searchHints) ? result.searchHints : [];
  return {
    normalizedName: result.normalizedName.trim().slice(0, 140),
    likelyManufacturer: result.likelyManufacturer.trim().slice(0, 80),
    likelyCategory: result.likelyCategory.trim().slice(0, 60),
    confidence: Math.max(0, Math.min(1, result.confidence)),
    oneFollowupQuestion: typeof result.oneFollowupQuestion === 'string' ? result.oneFollowupQuestion.trim().slice(0, 220) : '',
    documentationLinks: docs
      .filter((row) => row && typeof row.url === 'string' && isHttpUrl(row.url))
      .map((row) => ({
        title: typeof row.title === 'string' ? row.title.trim().slice(0, 120) : '',
        url: row.url.trim(),
        sourceType: typeof row.sourceType === 'string' ? row.sourceType.trim().slice(0, 40) : ''
      })),
    supportResources: resources
      .filter((row) => row && typeof row.url === 'string' && isHttpUrl(row.url))
      .map((row) => ({
        label: typeof row.label === 'string' ? row.label.trim().slice(0, 120) : '',
        url: row.url.trim(),
        resourceType: typeof row.resourceType === 'string' ? row.resourceType.trim().slice(0, 40) : 'other'
      })),
    supportContacts: contacts
      .filter((row) => row && typeof row.value === 'string' && row.value.trim())
      .map((row) => ({
        label: typeof row.label === 'string' ? row.label.trim().slice(0, 80) : '',
        value: row.value.trim().slice(0, 180),
        contactType: typeof row.contactType === 'string' ? row.contactType.trim().slice(0, 20) : 'other'
      })),
    alternateNames: alternateNames
      .map((v) => `${v || ''}`.trim().slice(0, 100))
      .filter(Boolean)
      .slice(0, 10),
    searchHints: searchHints
      .map((v) => `${v || ''}`.trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 10),
    topMatchReason: typeof result.topMatchReason === 'string' ? result.topMatchReason.trim().slice(0, 320) : ''
  };
}

module.exports = {
  assertString,
  sanitizeFollowupAnswers,
  validateAiResultShape,
  validateAssetLookupResultShape
};
