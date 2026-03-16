const toList = (value) => `${value || ''}`
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function formatDateParts(date = new Date()) {
  const pad = (n) => `${n}`.padStart(2, '0');
  return {
    yyyymmdd: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    hhmm: `${pad(date.getHours())}${pad(date.getMinutes())}`
  };
}

function randomSuffix(length = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function buildAssetKey(rawAssetId = '', rawAssetName = '') {
  const source = `${rawAssetId || rawAssetName || 'asset'}`.toUpperCase();
  const clean = source.replace(/[^A-Z0-9]+/g, '');
  return (clean.slice(0, 10) || 'ASSET');
}

export function generateTaskId({ assetId = '', assetName = '', existingIds = [] } = {}) {
  const { yyyymmdd, hhmm } = formatDateParts(new Date());
  const assetKey = buildAssetKey(assetId, assetName);
  const used = new Set((existingIds || []).map((id) => `${id}`));
  let candidate = '';
  let attempts = 0;
  do {
    candidate = `OPS-${yyyymmdd}-${hhmm}-${assetKey}-${randomSuffix(4)}`;
    attempts += 1;
  } while (used.has(candidate) && attempts < 12);
  return candidate;
}

export function getCurrentOpenedDateTimeValue(date = new Date()) {
  const pad = (n) => `${n}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function summarizeIssue(description = '', maxLength = 48) {
  const clean = `${description || ''}`.replace(/\s+/g, ' ').trim();
  if (!clean) return 'new issue';
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength).trimEnd()}…`;
}

export function generateTaskTitle(assetName = '', description = '') {
  const friendlyAsset = `${assetName || ''}`.trim() || 'Unknown asset';
  return `${friendlyAsset} — ${summarizeIssue(description)}`;
}

export function normalizeTaskIntake(raw, settings = {}) {
  const nowIso = new Date().toISOString();
  const openedAt = raw.openedAt ? new Date(raw.openedAt).toISOString() : nowIso;
  const assignedWorkers = [...new Set(toList(raw.assignedWorkers || raw.assignedWorker))];
  const fields = {
    id: (raw.id || '').trim(),
    assetId: (raw.assetId || '').trim(),
    assetName: (raw.assetName || '').trim(),
    location: (raw.location || '').trim(),
    issueCategory: (raw.issueCategory || '').trim(),
    symptomTags: [...new Set([...(Array.isArray(raw.symptomTags) ? raw.symptomTags : toList(raw.symptomTags)), ...toList(raw.symptomTagsExtra)])],
    severity: (raw.severity || settings.defaultTaskSeverity || 'medium').trim(),
    customerImpact: (raw.customerImpact || '').trim(),
    errorText: (raw.errorText || '').trim(),
    startedAt: (raw.startedAt || '').trim(),
    occurrence: raw.occurrence || 'constant',
    reproducible: raw.reproducible || 'unknown',
    alreadyTried: (raw.alreadyTried || '').trim() || 'Nothing yet',
    visibleCondition: (raw.visibleCondition || '').trim(),
    assignedWorkers,
    reporter: (raw.reporter || '').trim(),
    notes: (raw.notes || '').trim(),
    title: generateTaskTitle(raw.assetName || raw.assetId, raw.description || ''),
    status: raw.status || 'open',
    openedAt,
    createdAtClient: (raw.createdAtClient || '').trim() || nowIso,
    assetKeySnapshot: buildAssetKey(raw.assetId, raw.assetName),
    reportedByUserId: (raw.reportedByUserId || '').trim(),
    reportedByEmail: (raw.reportedByEmail || '').trim()
  };

  const generatedDescription = buildStructuredDescription(fields);
  return {
    ...fields,
    description: (raw.description || '').trim() || generatedDescription,
    structuredIntakeVersion: 1,
    updatedAtClient: nowIso
  };
}

export function buildStructuredDescription(task) {
  const lines = [
    task.description ? `Issue description: ${task.description}` : '',
    `Asset: ${task.assetId || 'n/a'}`,
    `Location: ${task.location || 'n/a'}`,
    `Category: ${task.issueCategory || 'n/a'} · Severity: ${task.severity || 'n/a'}`,
    `Symptoms: ${(task.symptomTags || []).join(', ') || 'n/a'}`,
    `Customer impact: ${task.customerImpact || 'n/a'}`,
    `Error text/code: ${task.errorText || 'n/a'}`,
    `Started/discovered: ${task.startedAt || 'n/a'}`,
    `Pattern: ${task.occurrence || 'n/a'} · Reproducible: ${task.reproducible || 'n/a'}`,
    `Already tried: ${task.alreadyTried || 'n/a'}`,
    `Visible condition: ${task.visibleCondition || 'n/a'}`,
    `Reporter: ${task.reporter || 'n/a'} · Assigned: ${(task.assignedWorkers || []).join(', ') || 'unassigned'}`,
    task.notes ? `Notes: ${task.notes}` : ''
  ].filter(Boolean);
  return lines.join('\n');
}

export function validateTaskIntake(payload, requiredFields = ['assetId', 'description', 'reporter']) {
  const missing = requiredFields.filter((field) => {
    const value = payload[field];
    if (Array.isArray(value)) return value.length === 0;
    return !`${value || ''}`.trim();
  });
  return { ok: missing.length === 0, missing };
}

export function buildCloseoutEvent(taskId, closeout, actor) {
  return {
    at: new Date().toISOString(),
    type: 'task_closeout',
    taskId,
    rootCause: closeout.rootCause || '',
    fixPerformed: closeout.fixPerformed || '',
    partsUsed: toList(closeout.partsUsed),
    toolsUsed: toList(closeout.toolsUsed),
    timeSpentMinutes: Number(closeout.timeSpentMinutes || 0),
    verification: closeout.verification || '',
    fullyResolved: closeout.fullyResolved === 'yes',
    bestFixSummary: closeout.bestFixSummary || '',
    by: actor?.uid || 'unknown',
    attachments: closeout.attachments || {}
  };
}

export function detectRepeatIssues(tasks = [], threshold = 2) {
  const grouped = new Map();
  tasks.forEach((task) => {
    const key = `${task.assetId || 'none'}|${task.issueCategory || 'uncategorized'}|${(task.symptomTags || []).sort().join(',')}`;
    grouped.set(key, [...(grouped.get(key) || []), task]);
  });
  return [...grouped.values()]
    .filter((entries) => entries.length >= threshold)
    .map((entries) => ({
      count: entries.length,
      assetId: entries[0].assetId || null,
      issueCategory: entries[0].issueCategory || null,
      symptomTags: entries[0].symptomTags || [],
      latestTaskId: entries.sort((a, b) => `${b.updatedAt || ''}`.localeCompare(`${a.updatedAt || ''}`))[0]?.id
    }))
    .sort((a, b) => b.count - a.count);
}

export function parseRouteState() {
  const params = new URLSearchParams(window.location.search);
  return {
    tab: params.get('tab') || 'dashboard',
    taskId: params.get('taskId') || null,
    assetId: params.get('assetId') || null,
    locationKey: params.get('location') || null
  };
}

export function pushRouteState(next) {
  const params = new URLSearchParams(window.location.search);
  Object.entries(next).forEach(([k, v]) => {
    if (v) params.set(k, v);
    else params.delete(k);
  });
  history.pushState({ ...next }, '', `${window.location.pathname}?${params.toString()}${window.location.hash || ''}`);
}
