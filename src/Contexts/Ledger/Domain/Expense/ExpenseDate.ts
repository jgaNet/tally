import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { DateInTheFuture, InvalidDate } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The day an expense was spent: a real day of the calendar, written YYYY-MM-DD, not after today in UTC. */
export class ExpenseDate extends ValueObject<string> {
  private constructor(value: string) {
    super(value);
  }

  /** A day of the calendar, as it was stored: its shape and whether it exists, nothing about the time. */
  static parse(raw: string): IResult<ExpenseDate> {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : null;
    if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== raw) {
      return Result.fail(new InvalidDate());
    }
    return Result.ok(new ExpenseDate(raw));
  }

  /** A day a member records: a real day, and not after `today`, the moment the command was accepted. */
  static create(raw: string, today: Date): IResult<ExpenseDate> {
    const parsed = ExpenseDate.parse(raw);
    if (parsed.isFailure()) return parsed;
    if (raw > today.toISOString().slice(0, 10)) return Result.fail(new DateInTheFuture());
    return parsed;
  }
}
