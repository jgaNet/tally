import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { ExpenseSnapshot, ShareSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { ExpenseDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseDescription';
import { InvalidAmountException, InvalidDateException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';

/** The largest amount of an expense, in whole units of the group's currency. */
export const MAX_EXPENSE_AMOUNT = 100_000_000;

/**
 * An amount a member of a group paid for some of its members, split equally between them (conventions/domain.yaml, the
 * Ledger context; docs/adr/0004). One aggregate per expense: it keeps that its shares add up to its amount, and nothing
 * else of the group is in it. The balances are not here (request 5).
 *
 * `register()` is the creation, named as Group's is: it validates the description, the amount, the date and the split,
 * generates the id, and records ExpenseRecorded for the store to make durable with it. The date is a real day of the
 * calendar, not after today in UTC, today being the one clock's now. `members` are the group's current members, which the
 * use case asked Groups for. `fromSnapshot()` reads what the store kept, records nothing, and throws on corrupted data.
 */
export class Expense extends AggregateRoot {
  readonly #groupId: string;
  readonly #description: ExpenseDescription;
  readonly #amount: number;
  readonly #date: string;
  readonly #paidBy: string;
  readonly #split: Split;

  private constructor(
    id: Id,
    groupId: string,
    description: ExpenseDescription,
    amount: number,
    date: string,
    paidBy: string,
    split: Split,
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#description = description;
    this.#amount = amount;
    this.#date = date;
    this.#paidBy = paidBy;
    this.#split = split;
  }

  static register({
    groupId,
    description,
    amount,
    date,
    paidBy,
    splitBetween,
    members,
    at,
  }: {
    groupId: string;
    description: string;
    amount: number;
    date: string;
    paidBy: string;
    splitBetween: string[];
    members: string[];
    at: Date;
  }): IResult<Expense> {
    const text = ExpenseDescription.create(description);
    if (text.isFailure()) return text;
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_EXPENSE_AMOUNT) {
      return Result.fail(new InvalidAmountException());
    }
    if (!isRealDay(date) || date > dayOf(at)) {
      return Result.fail(new InvalidDateException());
    }
    const split = Split.equally({ amount, between: splitBetween, payerId: paidBy, members });
    if (split.isFailure()) return split;

    const id = Id.generate();
    const expense = new Expense(id, groupId, text.data, amount, date, paidBy, split.data, 0);
    expense.record(ExpenseRecordedEvent.set({ expenseId: id.value, groupId, amount, paidBy }));
    return Result.ok(expense);
  }

  static fromSnapshot(snapshot: ExpenseSnapshot): Expense {
    const description = ExpenseDescription.create(snapshot.description);
    const split = Split.fromShares(snapshot.shares);
    if (
      description.isFailure() ||
      !isRealDay(snapshot.date) ||
      split.total !== snapshot.amount ||
      snapshot.shares.length === 0
    ) {
      throw new Error(`The expense ${snapshot.id} is corrupted in the store`);
    }
    return new Expense(
      new Id(snapshot.id),
      snapshot.groupId,
      description.data,
      snapshot.amount,
      snapshot.date,
      snapshot.paidBy,
      split,
      snapshot.version,
    );
  }

  toSnapshot(): ExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      description: this.#description.value,
      amount: this.#amount,
      date: this.#date,
      paidBy: this.#paidBy,
      shares: this.#split.shares,
      version: this.version,
    };
  }

  get id(): string {
    return this._id.value;
  }

  get groupId(): string {
    return this.#groupId;
  }

  get paidBy(): string {
    return this.#paidBy;
  }

  get shares(): ShareSnapshot[] {
    return this.#split.shares;
  }
}

/** Whether `raw` is a day of the calendar written `YYYY-MM-DD`: `2026-02-30` is not one. */
function isRealDay(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const day = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && dayOf(day) === raw;
}

/** The day of an instant, in UTC, written `YYYY-MM-DD`. */
const dayOf = (instant: Date): string => instant.toISOString().slice(0, 10);
