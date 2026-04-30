const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DEFAULT_DAY = { open: true, openTime: '10:00', closeTime: '22:00' };
const DEFAULT_SCHEDULE = { openingGraceMinutes: 30, closingGraceMinutes: 30, upkeepDueTime: '16:00', upkeepGraceMinutes: 60 };

export function normalizeBusinessHours(businessHours = {}) {
  return WEEKDAYS.reduce((acc, day) => {
    const row = businessHours?.[day] || {};
    acc[day] = {
      open: row.open !== false,
      openTime: `${row.openTime || DEFAULT_DAY.openTime}`,
      closeTime: `${row.closeTime || DEFAULT_DAY.closeTime}`,
    };
    return acc;
  }, {});
}

export function normalizeDailyOperationsSchedule(schedule = {}) {
  return {
    openingGraceMinutes: Number(schedule.openingGraceMinutes ?? DEFAULT_SCHEDULE.openingGraceMinutes) || DEFAULT_SCHEDULE.openingGraceMinutes,
    closingGraceMinutes: Number(schedule.closingGraceMinutes ?? DEFAULT_SCHEDULE.closingGraceMinutes) || DEFAULT_SCHEDULE.closingGraceMinutes,
    upkeepDueTime: `${schedule.upkeepDueTime || DEFAULT_SCHEDULE.upkeepDueTime}`,
    upkeepGraceMinutes: Number(schedule.upkeepGraceMinutes ?? DEFAULT_SCHEDULE.upkeepGraceMinutes) || DEFAULT_SCHEDULE.upkeepGraceMinutes
  };
}

export function computeChecklistTiming({ taskType, scheduledForDate, location, nowIso, completedAt } = {}) {
  const businessHours = normalizeBusinessHours(location?.businessHours || {});
  const schedule = normalizeDailyOperationsSchedule(location?.dailyOperationsSchedule || {});
  const dateKey = `${scheduledForDate || new Date().toISOString().slice(0, 10)}`;
  const dayName = WEEKDAYS[new Date(`${dateKey}T12:00:00Z`).getUTCDay() === 0 ? 6 : new Date(`${dateKey}T12:00:00Z`).getUTCDay() - 1];
  const dayHours = businessHours[dayName] || DEFAULT_DAY;
  if (!dayHours.open) return { isBusinessOpen: false, dueAt: null, overdueAfter: null, timingLabel: 'Location closed today', overdueStatus: 'closed_day', businessDate: dateKey };
  const dueTime = taskType === 'opening_checklist' ? dayHours.openTime : taskType === 'closing_checklist' ? dayHours.closeTime : schedule.upkeepDueTime;
  const grace = taskType === 'opening_checklist' ? schedule.openingGraceMinutes : taskType === 'closing_checklist' ? schedule.closingGraceMinutes : schedule.upkeepGraceMinutes;
  const dueAt = `${dateKey}T${dueTime}:00`;
  const overdueAfterDate = new Date(dueAt);
  overdueAfterDate.setMinutes(overdueAfterDate.getMinutes() + grace);
  const overdueAfter = overdueAfterDate.toISOString();
  const now = new Date(nowIso || new Date().toISOString());
  const completed = completedAt ? new Date(completedAt) : null;
  const dueDate = new Date(dueAt);
  const status = completed ? (completed > overdueAfterDate ? 'completed_late' : 'completed_on_time') : (now > overdueAfterDate ? 'overdue' : (now >= dueDate ? 'due_today' : 'not_due'));
  const label = status === 'overdue' ? `Overdue since ${overdueAfterDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `Due by ${dueDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return { isBusinessOpen: true, dueAt, overdueAfter, timingLabel: label, overdueStatus: status, businessDate: dateKey, businessHoursSnapshot: businessHours };
}
