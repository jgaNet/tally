import { IResult, Result, ValueObject } from '@Architecture/Domain';

import {
  InvalidStartsOn,
  StartsOnOutOfRange,
} from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpenseExceptions';

const DAY_MS = 86_400_000;

/** How many days before or after today a recurring expense may start (request 23). */
export const STARTS_ON_WINDOW_DAYS = 365;

/**
 * The day a recurring expense starts on: a real day of the calendar, written YYYY-MM-DD, on the 1st to the 28th of its month so
 * that every month has it, and no more than 365 days before or after today.
 */
export class StartsOn extends ValueObject<string> {
  private constructor(day: string) {
    super(day);
  }

  /** `today` is the day of the application's clock in UTC, read by the handler and passed in: never a default. */
  static create(raw: string, today: string): IResult<StartsOn> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Result.fail(new InvalidStartsOn());
    const [year, month, day] = raw.split('-').map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    const isRealDay =
      calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
    if (!isRealDay || day > 28) return Result.fail(new InvalidStartsOn());

    const daysFromToday = (Date.parse(`${raw}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS;
    if (Math.abs(daysFromToday) > STARTS_ON_WINDOW_DAYS) return Result.fail(new StartsOnOutOfRange());
    return Result.ok(new StartsOn(raw));
  }
}
