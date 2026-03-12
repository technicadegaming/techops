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

module.exports = {
  assertString,
  sanitizeFollowupAnswers,
  validateAiResultShape
};
