import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidExpenseDateException } from './ExpenseExceptions';

/** The day it was spent: a real day of the calendar, written YYYY-MM-DD, not after `today` (the UTC day of the decision). */
export class ExpenseDate extends ValueObject<string> {
  private constructor(day: string) {
    super(day);
  }

  static create(raw: string, today: string): IResult<ExpenseDate> {
    if (!isRealDay(raw) || raw > today) return Result.fail(new InvalidExpenseDateException());
    return Result.ok(new ExpenseDate(raw));
  }
}

/** Whether `raw` is a day that exists: the calendar rolls `2026-02-30` over, so it must read back as written. */
function isRealDay(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}
