import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { DateInTheFuture, InvalidDate } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The day an expense was spent: a real day of the calendar, written YYYY-MM-DD, not after today in UTC. */
export class SpentOn extends ValueObject<string> {
  private constructor(day: string) {
    super(day);
  }

  /** `today` is the day of the application's clock in UTC, read by the handler and passed in: never a default. */
  static create(raw: string, today: string): IResult<SpentOn> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Result.fail(new InvalidDate());
    const [year, month, day] = raw.split('-').map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    const isRealDay =
      calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
    if (!isRealDay) return Result.fail(new InvalidDate());
    // ISO days compare as strings in the order of the calendar.
    if (raw > today) return Result.fail(new DateInTheFuture());
    return Result.ok(new SpentOn(raw));
  }
}
