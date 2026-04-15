function isWeakTaskDescription(task) {
  const text = `${task?.title || ''} ${task?.notes || ''} ${task?.description || ''}`.trim();
  const structuredSignals = [task?.issueCategory, task?.severity, task?.assetId, ...(task?.symptomTags || [])].filter(Boolean);
  if (structuredSignals.length >= 3) return false;
  return text.length < 35 || !/[a-z]{4,}/i.test(text);
}

module.exports = { isWeakTaskDescription };
