import { buildLocationOptions, buildLocationSummary } from './locationContext.js';
import { detectRepeatIssues } from './workflow.js';

export const PM_DUE_SOON_DAYS = 7;
const ONE_DAY_MS = 1000 * 60 * 60 * 24;

export function toValidDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isPmOverdue(schedule, now = new Date()) {
  if (!schedule?.dueDate || schedule.status === 'completed') return false;
  const due = toValidDate(schedule.dueDate);
  return !!due && due < now;
}

export function isPmDueSoon(schedule, now = new Date(), days = PM_DUE_SOON_DAYS) {
  if (!schedule?.dueDate || schedule.status === 'completed') return false;
  const due = toValidDate(schedule.dueDate);
  if (!due) return false;
  const diffDays = (due.getTime() - now.getTime()) / ONE_DAY_MS;
  return diffDays >= 0 && diffDays <= days;
}

export function buildPmHealthSummary(schedules = [], now = new Date()) {
  const completed = schedules.filter((schedule) => schedule.status === 'completed').length;
  const open = schedules.filter((schedule) => schedule.status !== 'completed');
  const overdue = open.filter((schedule) => isPmOverdue(schedule, now));
  const dueSoon = open.filter((schedule) => isPmDueSoon(schedule, now));
  const totalWithStatus = completed + open.length;
  const compliance = totalWithStatus ? Math.round((completed / totalWithStatus) * 100) : 0;
  return {
    open,
    overdue,
    dueSoon,
    completed,
    totalWithStatus,
    compliance
  };
}

export function summarizePmByField(schedules = [], resolveGroup = () => 'Unassigned', now = new Date()) {
  const grouped = new Map();
  schedules.forEach((schedule) => {
    const label = `${resolveGroup(schedule) || 'Unassigned'}`.trim() || 'Unassigned';
    const row = grouped.get(label) || { label, open: 0, overdue: 0, dueSoon: 0, total: 0, completed: 0 };
    row.total += 1;
    if (schedule.status === 'completed') {
      row.completed += 1;
    } else {
      row.open += 1;
      if (isPmOverdue(schedule, now)) row.overdue += 1;
      if (isPmDueSoon(schedule, now)) row.dueSoon += 1;
    }
    grouped.set(label, row);
  });
  return [...grouped.values()]
    .map((row) => ({ ...row, compliance: row.total ? Math.round((row.completed / row.total) * 100) : 0 }))
    .sort((a, b) => (b.overdue - a.overdue) || (b.open - a.open) || a.label.localeCompare(b.label));
}

function getTaskAgeHours(task, nowMs = Date.now()) {
  const opened = toValidDate(task.openedAt || task.createdAtClient || task.updatedAt || task.updatedAtClient);
  if (!opened) return 0;
  return (nowMs - opened.getTime()) / (1000 * 60 * 60);
}

function getOverdueThresholdHours(severity = 'medium') {
  if (severity === 'critical') return 4;
  if (severity === 'high') return 24;
  if (severity === 'low') return 168;
  return 72;
}

function isTaskOverdue(task, nowMs = Date.now()) {
  if (task.status === 'completed') return false;
  return getTaskAgeHours(task, nowMs) >= getOverdueThresholdHours(task.severity || 'medium');
}

export function buildAssigneeWorkloadSummary(tasks = [], users = [], now = new Date()) {
  const nowMs = now.getTime();
  const weekAgoMs = nowMs - (7 * ONE_DAY_MS);
  const userMap = new Map((users || []).map((user) => [user.id || user.email, user]));
  const rows = new Map();
  const putRow = (key) => {
    if (!rows.has(key)) {
      const user = userMap.get(key);
      rows.set(key, {
        key,
        label: user?.memberLabel || user?.displayName || user?.fullName || user?.email || key || 'Unassigned',
        open: 0,
        overdue: 0,
        closedRecently: 0,
        criticalOpen: 0
      });
    }
    return rows.get(key);
  };

  tasks.forEach((task) => {
    const assigned = (task.assignedWorkers || []).length ? task.assignedWorkers : ['__unassigned__'];
    assigned.forEach((worker) => {
      const row = putRow(worker || '__unassigned__');
      if (task.status === 'completed') {
        const closedAt = toValidDate(task.closedAt || task.updatedAt || task.updatedAtClient);
        if (closedAt && closedAt.getTime() >= weekAgoMs) row.closedRecently += 1;
        return;
      }
      row.open += 1;
      if ((task.severity || 'medium') === 'critical') row.criticalOpen += 1;
      if (isTaskOverdue(task, nowMs)) row.overdue += 1;
    });
  });

  return [...rows.values()]
    .sort((a, b) => (b.overdue - a.overdue) || (b.open - a.open) || a.label.localeCompare(b.label));
}

export function buildAssetAttentionSummary(tasks = [], assets = []) {
  const assetById = new Map((assets || []).map((asset) => [asset.id, asset]));
  const repeat = detectRepeatIssues(tasks, 2);
  const repeatByAsset = repeat.reduce((acc, row) => {
    const key = row.assetId || '__unknown__';
    acc.set(key, (acc.get(key) || 0) + row.count);
    return acc;
  }, new Map());

  const rows = new Map();
  tasks.forEach((task) => {
    const key = task.assetId || '__unknown__';
    const row = rows.get(key) || {
      assetId: key === '__unknown__' ? '' : key,
      assetName: assetById.get(key)?.name || task.assetName || key || 'Unknown asset',
      openTasks: 0,
      recurringTasks: repeatByAsset.get(key) || 0,
      estimatedDowntimeHours: 0,
      recentCategories: new Map()
    };
    if (task.status !== 'completed') row.openTasks += 1;
    const timeSpentMinutes = Number(task.closeout?.timeSpentMinutes || 0);
    const ageHours = getTaskAgeHours(task);
    row.estimatedDowntimeHours += task.status === 'completed' ? (timeSpentMinutes / 60) : Math.max(0, Math.min(ageHours, 336));
    const category = task.issueCategory || 'uncategorized';
    row.recentCategories.set(category, (row.recentCategories.get(category) || 0) + 1);
    rows.set(key, row);
  });

  return [...rows.values()]
    .map((row) => ({
      ...row,
      estimatedDowntimeHours: Math.round(row.estimatedDowntimeHours * 10) / 10,
      topCategories: [...row.recentCategories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name)
    }))
    .sort((a, b) => ((b.recurringTasks + b.openTasks) - (a.recurringTasks + a.openTasks)) || (b.estimatedDowntimeHours - a.estimatedDowntimeHours));
}

export function buildLocationComparisonSummary(state, now = new Date()) {
  return buildLocationOptions(state)
    .filter((option) => !['__all_locations__', '__unassigned_location__'].includes(option.key))
    .map((option) => {
      const scope = buildLocationSummary(state, option);
      const pm = summarizePmByField(state.pmSchedules || [], (schedule) => schedule.locationName || schedule.location || 'Unassigned', now)
        .find((entry) => entry.label.toLowerCase() === `${option.name || ''}`.trim().toLowerCase())
        || { overdue: 0 };
      const repeat = detectRepeatIssues(scope.scopedTasks || [], 2);
      const recurringConcentration = repeat.reduce((sum, row) => sum + row.count, 0);
      return {
        key: option.key,
        label: option.name,
        openWork: scope.openTasks.length,
        overduePm: pm.overdue,
        missingDocs: (scope.assetsWithoutDocs || []).length,
        recurringConcentration
      };
    })
    .sort((a, b) => (b.openWork - a.openWork) || (b.overduePm - a.overduePm) || (b.recurringConcentration - a.recurringConcentration));
}
