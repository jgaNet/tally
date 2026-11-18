import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { InvalidStartsOn } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExceptions';

const DAY_MS = 86_400_000;
const WITHIN_DAYS = 365;

/**
 * The day a recurring expense starts on (request 23): a real day of the calendar, from the 1st to the 28th of its month (so
 * that every month has it), no more than 365 days before today nor more than 365 days after, in UTC.
 */
export class StartsOn extends ValueObject<string> {
  private constructor(value: string) {
    super(value);
  }

  static create(raw: string, today: Date): IResult<StartsOn> {
    const parsed = ExpenseDate.parse(raw);
    if (parsed.isFailure()) return Result.fail(new InvalidStartsOn());
    if (Number(raw.slice(8, 10)) > 28) return Result.fail(new InvalidStartsOn());
    const day = today.toISOString().slice(0, 10);
    if (raw < shiftDays(day, -WITHIN_DAYS) || raw > shiftDays(day, WITHIN_DAYS)) {
      return Result.fail(new InvalidStartsOn());
    }
    return Result.ok(new StartsOn(raw));
  }
}

/** The day of the next month with the same day of the month: every day here is from the 1st to the 28th, so it exists. */
export function nextMonthDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  // Date.UTC takes the month from 0, so month (1-based) is the month after this one.
  return new Date(Date.UTC(year, month, date)).toISOString().slice(0, 10);
}

function shiftDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
