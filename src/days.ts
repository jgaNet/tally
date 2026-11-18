const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `date` names a day of the calendar, as `YYYY-MM-DD`. */
export function isRealDay(date: string): boolean {
  if (!DATE_SHAPE.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  return instant.getUTCFullYear() === year && instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day;
}

/** Today's day in UTC, as `YYYY-MM-DD`. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
