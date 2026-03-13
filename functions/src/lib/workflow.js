function splitList(value) {
  return `${value || ''}`.split(',').map((x) => x.trim()).filter(Boolean);
}

function normalizeStructuredTask(raw, settings = {}) {
  const task = {
    id: raw.id,
    title: raw.title || '',
    assetId: raw.assetId || '',
    issueCategory: raw.issueCategory || '',
    severity: raw.severity || settings.defaultTaskSeverity || 'medium',
    symptomTags: [...new Set([...(raw.symptomTags || []), ...splitList(raw.symptomTagsText)])],
    assignedWorkers: [...new Set(splitList(raw.assignedWorkers))],
    description: raw.description || ''
  };
  if (!task.description) task.description = `Asset ${task.assetId} ${task.issueCategory} ${task.symptomTags.join(' ')}`.trim();
  return task;
}

function buildAssetHistoryCloseout(taskId, closeout) {
  return {
    type: 'task_closeout',
    taskId,
    rootCause: closeout.rootCause || '',
    fixPerformed: closeout.fixPerformed || '',
    timeSpentMinutes: Number(closeout.timeSpentMinutes || 0)
  };
}

function detectRepeatIssues(tasks = [], threshold = 2) {
  const groups = new Map();
  for (const t of tasks) {
    const key = `${t.assetId || ''}|${t.issueCategory || ''}|${(t.symptomTags || []).join(',')}`;
    groups.set(key, [...(groups.get(key) || []), t]);
  }
  return [...groups.values()].filter((x) => x.length >= threshold).map((items) => ({
    count: items.length,
    assetId: items[0].assetId,
    issueCategory: items[0].issueCategory
  }));
}


function parseDeepLink(url) {
  const parsed = new URL(url, 'https://example.local');
  return {
    tab: parsed.searchParams.get('tab') || 'dashboard',
    taskId: parsed.searchParams.get('taskId') || null,
    assetId: parsed.searchParams.get('assetId') || null
  };
}

module.exports = { normalizeStructuredTask, buildAssetHistoryCloseout, detectRepeatIssues, parseDeepLink };
