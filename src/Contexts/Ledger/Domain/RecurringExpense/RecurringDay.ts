import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidRecurringDayException } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExceptions';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** How far from today a recurring expense may start, either way, in days (request 23). */
export const STARTS_WITHIN_DAYS = 365;

/**
 * A day of a recurring expense, written YYYY-MM-DD: a real day of the calendar whose day of the month is from 1 to 28, so that
 * every month has it (request 23). The day of `startsOn` is also kept as the day of the next expense, which moves a month on.
 */
export class RecurringDay extends ValueObject<string> {
  private constructor(day: string) {
    super(day);
  }

  /** The day `raw` names, when it is a valid day and no more than 365 days from `today` (UTC), either way. */
  static startingOn(raw: string, today: Date): IResult<RecurringDay> {
    const parsed = RecurringDay.parse(raw);
    if (parsed.isFailure()) return parsed;
    const days = (Date.parse(`${raw}T00:00:00.000Z`) - Date.parse(`${dayOf(today)}T00:00:00.000Z`)) / DAY_MS;
    if (Math.abs(days) > STARTS_WITHIN_DAYS) return Result.fail(new InvalidRecurringDayException());
    return parsed;
  }

  /** The day `raw` names, when it is a real day of the calendar whose day of the month is from 1 to 28. */
  static parse(raw: string): IResult<RecurringDay> {
    if (typeof raw !== 'string' || !DAY.test(raw)) return Result.fail(new InvalidRecurringDayException());
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
      return Result.fail(new InvalidRecurringDayException());
    }
    const dayOfMonth = Number(raw.slice(8, 10));
    if (dayOfMonth < 1 || dayOfMonth > 28) return Result.fail(new InvalidRecurringDayException());
    return Result.ok(new RecurringDay(raw));
  }

  /** Whether this day has come by `today`, the application's clock (UTC). */
  hasComeBy(today: Date): boolean {
    return this.value <= dayOf(today);
  }

  /** The same day of the month, in the month after this one. Every month has it, since the day is 1 to 28. */
  monthAfter(): RecurringDay {
    const [year, month, day] = this.value.split('-').map(Number);
    const next = new Date(Date.UTC(year, month, day));
    return new RecurringDay(next.toISOString().slice(0, 10));
  }
}

/** The UTC day of an instant, as YYYY-MM-DD. */
export function dayOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
