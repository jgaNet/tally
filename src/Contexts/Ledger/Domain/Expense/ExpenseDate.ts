import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidExpenseDateException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day an expense was spent: a real day of the calendar, written YYYY-MM-DD, not after the day `today` names in UTC.
 * `today` is the application's clock, given by the caller: there is no default (DOMAIN-ONE-CLOCK).
 */
export class ExpenseDate extends ValueObject<string> {
  private constructor(day: string) {
    super(day);
  }

  static create(raw: string, today: Date): IResult<ExpenseDate> {
    if (typeof raw !== 'string' || !DAY.test(raw)) return Result.fail(new InvalidExpenseDateException());

    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
      return Result.fail(new InvalidExpenseDateException());
    }
    if (raw > today.toISOString().slice(0, 10)) return Result.fail(new InvalidExpenseDateException());

    return Result.ok(new ExpenseDate(raw));
  }
}
