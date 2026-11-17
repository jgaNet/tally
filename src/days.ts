const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `text` is a real day of the calendar, written `YYYY-MM-DD`. */
export function isCalendarDay(text: string): boolean {
  if (!DATE_SHAPE.test(text)) return false;
  const instant = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === text;
}

/** Today's day in UTC, `YYYY-MM-DD`. */
export function todayInUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
