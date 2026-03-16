function toTimestamp(value) {
  if (!value) return 0;
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatRelativeTime(value) {
  const timestamp = toTimestamp(value);
  if (!timestamp) return 'just now';
  const diff = Date.now() - timestamp;
  const minutes = Math.max(1, Math.round(Math.abs(diff) / (1000 * 60)));
  if (minutes < 60) return diff >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return diff >= 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return diff >= 0 ? `${days}d ago` : `in ${days}d`;
}

function getTaskAgeHours(task) {
  const openedAt = toTimestamp(task.openedAt || task.createdAtClient || task.updatedAt || task.updatedAtClient);
  if (!openedAt) return 0;
  return (Date.now() - openedAt) / (1000 * 60 * 60);
}

function getOverdueThresholdHours(severity = 'medium') {
  if (severity === 'critical') return 4;
  if (severity === 'high') return 24;
  if (severity === 'low') return 168;
  return 72;
}

function isOpenTask(task) {
  return (task?.status || 'open') !== 'completed';
}

function isTaskOverdue(task) {
  return isOpenTask(task) && getTaskAgeHours(task) >= getOverdueThresholdHours(task.severity || 'medium');
}

function normalizeWorkerIdentity(value = '') {
  return `${value || ''}`.trim().toLowerCase();
}

function includesAnyWorker(task = {}, identities = new Set()) {
  return (task.assignedWorkers || []).some((worker) => identities.has(normalizeWorkerIdentity(worker)));
}

function buildNotification(type, key, title, body, action = {}, happenedAt = null, level = 'info') {
  const now = new Date().toISOString();
  return {
    id: `notif-${key}`,
    type,
    eventKey: key,
    title,
    body,
    level,
    action,
    happenedAt: happenedAt || now,
    createdAtClient: now,
    updatedAtClient: now,
    readAt: null,
    dismissedAt: null,
    status: 'active'
  };
}

export function buildNotificationCandidates(state) {
  const uid = `${state.user?.uid || ''}`.trim();
  const email = `${state.user?.email || ''}`.trim().toLowerCase();
  if (!uid || !state.company?.id) return [];

  const workerIds = new Set([uid, email]);
  (state.workers || []).forEach((worker) => {
    if (`${worker.email || ''}`.trim().toLowerCase() === email) {
      workerIds.add(normalizeWorkerIdentity(worker.id));
      workerIds.add(normalizeWorkerIdentity(worker.email));
    }
  });

  const aiFollowupTaskIds = new Set((state.taskAiRuns || []).filter((run) => run.status === 'followup_required').map((run) => run.taskId));
  const aiCompletedByTask = new Map();
  (state.taskAiRuns || []).forEach((run) => {
    if (!run?.taskId || run.status !== 'completed') return;
    const current = aiCompletedByTask.get(run.taskId);
    const runAt = toTimestamp(run.updatedAt || run.completedAt || run.createdAt || run.updatedAtClient);
    if (!current || runAt > current.runAt) aiCompletedByTask.set(run.taskId, { run, runAt });
  });

  const candidates = [];
  (state.tasks || []).forEach((task) => {
    const assignedToMe = includesAnyWorker(task, workerIds);
    const title = task.title || task.id;
    if (assignedToMe && isOpenTask(task)) {
      candidates.push(buildNotification(
        'task_assigned',
        `task-assigned-${task.id}-${[...(task.assignedWorkers || [])].join('-')}`,
        'Task assigned to you',
        `${title} is now in your queue.`,
        { tab: 'operations', taskId: task.id },
        task.updatedAt || task.updatedAtClient || task.openedAt,
        'info'
      ));
    }
    if (assignedToMe && isTaskOverdue(task)) {
      candidates.push(buildNotification(
        'task_overdue',
        `task-overdue-${task.id}`,
        'Assigned task is overdue',
        `${title} has passed its expected response window.`,
        { tab: 'operations', taskId: task.id, focus: 'overdue_open' },
        task.updatedAt || task.updatedAtClient || task.openedAt,
        'warn'
      ));
    }
    if (assignedToMe && aiFollowupTaskIds.has(task.id) && isOpenTask(task)) {
      candidates.push(buildNotification(
        'followup_required',
        `followup-required-${task.id}`,
        'AI follow-up required',
        `AI needs more troubleshooting details for ${title}.`,
        { tab: 'operations', taskId: task.id, focus: 'followup' },
        task.updatedAt || task.updatedAtClient,
        'warn'
      ));
    }
    const aiCompleted = aiCompletedByTask.get(task.id);
    if (assignedToMe && aiCompleted && isOpenTask(task)) {
      candidates.push(buildNotification(
        'ai_troubleshooting_ready',
        `ai-ready-${task.id}-${aiCompleted.run.id || 'latest'}`,
        'AI troubleshooting ready',
        `Fresh troubleshooting guidance is ready for ${title}.`,
        { tab: 'operations', taskId: task.id },
        aiCompleted.run.updatedAt || aiCompleted.run.completedAt || aiCompleted.run.createdAt,
        'good'
      ));
    }
    if (assignedToMe && task.status === 'in_progress' && (task.assignedWorkers || []).length > 0 && !aiFollowupTaskIds.has(task.id)) {
      candidates.push(buildNotification(
        'task_ready_to_close',
        `task-ready-close-${task.id}`,
        'Task may be ready to close',
        `${title} is in progress and appears ready for closeout review.`,
        { tab: 'operations', taskId: task.id },
        task.updatedAt || task.updatedAtClient,
        'info'
      ));
    }
    if (assignedToMe && task.status === 'completed' && toTimestamp(task.closeout?.completedAt || task.updatedAt) >= (Date.now() - (1000 * 60 * 60 * 24))) {
      candidates.push(buildNotification(
        'task_recently_closed',
        `task-recently-closed-${task.id}`,
        'Task recently closed',
        `${title} was closed recently.`,
        { tab: 'operations', taskId: task.id },
        task.closeout?.completedAt || task.updatedAt,
        'good'
      ));
    }
  });

  (state.pmSchedules || []).forEach((pm) => {
    const due = toTimestamp(pm.dueDate);
    if (!due || pm.status === 'completed') return;
    const diffDays = (due - Date.now()) / (1000 * 60 * 60 * 24);
    if (diffDays < 0) {
      candidates.push(buildNotification(
        'pm_overdue',
        `pm-overdue-${pm.id}`,
        'PM schedule overdue',
        `${pm.title || pm.id} is overdue and needs attention.`,
        { tab: 'calendar', pmFilter: 'overdue' },
        pm.updatedAt || pm.dueDate,
        'warn'
      ));
    } else if (diffDays <= 7) {
      candidates.push(buildNotification(
        'pm_due_soon',
        `pm-due-soon-${pm.id}`,
        'PM due soon',
        `${pm.title || pm.id} is due within 7 days.`,
        { tab: 'calendar' },
        pm.dueDate,
        'info'
      ));
    }
  });

  (state.assets || []).forEach((asset) => {
    const enrichmentStatus = `${asset.enrichmentStatus || ''}`.trim();
    if (['followup_needed', 'verified_manual_found'].includes(enrichmentStatus)) {
      candidates.push(buildNotification(
        enrichmentStatus === 'followup_needed' ? 'docs_suggestions_ready' : 'doc_review_ready',
        `asset-docs-${asset.id}-${enrichmentStatus}`,
        enrichmentStatus === 'followup_needed' ? 'Docs enrichment needs review' : 'Documentation links ready',
        `${asset.name || asset.id} has new enrichment output ready for review.`,
        { tab: 'assets', assetId: asset.id },
        asset.enrichmentUpdatedAt || asset.updatedAt,
        'info'
      ));
    }
  });

  const openTasks = (state.tasks || []).filter((task) => isOpenTask(task));
  const unassignedCount = openTasks.filter((task) => !(task.assignedWorkers || []).length).length;
  if (unassignedCount > 0) {
    candidates.push(buildNotification(
      'unassigned_open_work',
      `unassigned-open-${unassignedCount}`,
      'Open work needs owners',
      `${unassignedCount} open task${unassignedCount === 1 ? '' : 's'} currently have no assignee.`,
      { tab: 'operations', focus: 'unassigned' },
      new Date().toISOString(),
      'warn'
    ));
  }

  const blockedCount = openTasks.filter((task) => {
    const missingAssignee = task.status === 'in_progress' && !(task.assignedWorkers || []).length;
    return missingAssignee || aiFollowupTaskIds.has(task.id);
  }).length;
  if (blockedCount > 0) {
    candidates.push(buildNotification(
      'blocked_work',
      `blocked-open-${blockedCount}`,
      'Blocked work detected',
      `${blockedCount} open task${blockedCount === 1 ? '' : 's'} need follow-up or assignment changes.`,
      { tab: 'operations', focus: 'blocked' },
      new Date().toISOString(),
      'warn'
    ));
  }

  (state.invites || []).forEach((invite) => {
    const inviteEmail = `${invite.email || ''}`.trim().toLowerCase();
    if (invite.status === 'pending' && inviteEmail && inviteEmail === email) {
      candidates.push(buildNotification(
        'invite_received',
        `invite-received-${invite.id}`,
        'Invite received',
        `You were invited to join ${state.company?.name || 'the company'} as ${invite.role || 'staff'}.`,
        { tab: 'admin', adminSection: 'company' },
        invite.createdAt || invite.updatedAt,
        'info'
      ));
    }
    if (invite.status === 'accepted' && `${invite.createdBy || ''}`.trim() === uid) {
      candidates.push(buildNotification(
        'invite_accepted',
        `invite-accepted-${invite.id}`,
        'Invite accepted',
        `${invite.email || 'A teammate'} accepted your invite.`,
        { tab: 'admin', adminSection: 'company' },
        invite.acceptedAt || invite.updatedAt,
        'good'
      ));
    }
  });

  return candidates;
}
