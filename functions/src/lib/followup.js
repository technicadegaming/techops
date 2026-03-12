function isWeakTaskDescription(task) {
  const text = `${task?.title || ''} ${task?.notes || ''}`.trim();
  return text.length < 35 || !/[a-z]{4,}/i.test(text);
}

module.exports = { isWeakTaskDescription };
