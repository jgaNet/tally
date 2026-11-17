import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';

import { Share, Split } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  InvalidExpenseAmountException,
  InvalidExpenseDateException,
  InvalidExpenseDescriptionException,
  SplitMemberNotInGroupException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What a member asks to record: the expense as the request carries it, its payer being the caller. */
export interface ExpenseDraft {
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly payerId: string;
  readonly splitBetween: readonly string[];
}

/** An expense as the store keeps it: its shares included, in the order they were decided. */
export interface ExpenseSnapshot {
  readonly id: string;
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly paidBy: string;
  readonly shares: readonly Share[];
}

/**
 * An expense a member paid for some members of a group, as the ledger keeps it (conventions/domain.yaml, the storm's Expense):
 * its description, its amount in the group's currency, the day it was spent, its payer, and its shares. It is an aggregate
 * root because `RecordExpense` records it and `ExpenseRecorded` announces it (the storm, decided before the code); nothing
 * changes an expense once it is recorded.
 */
export class Expense extends AggregateRoot {
  static readonly MAX_AMOUNT = 100_000_000;
  static readonly MAX_DESCRIPTION_LENGTH = 100;

  readonly #groupId: string;
  readonly #description: string;
  readonly #amount: number;
  readonly #date: string;
  readonly #paidBy: string;
  readonly #split: Split;

  private constructor(
    id: Id,
    groupId: string,
    description: string,
    amount: number,
    date: string,
    paidBy: string,
    split: Split,
  ) {
    super(id);
    this.#groupId = groupId;
    this.#description = description;
    this.#amount = amount;
    this.#date = date;
    this.#paidBy = paidBy;
    this.#split = split;
  }

  /**
   * A recording: the description is 1 to 100 characters and not only spaces, the amount a whole number from 1 to 100 000 000,
   * the date a real day of the calendar not after today in UTC (`now`), and the split one the members of the group
   * (`members`, the group's current members) may be in, each once, the payer among them. The shares are the `Split`'s, equal
   * with the remainder to the payer. The identity is generated here (DOMAIN-IDENTITY), and the recording records
   * `ExpenseRecorded`. Pure: the members and the time are given, nothing is read.
   */
  static register(
    { groupId, description, amount, date, payerId, splitBetween }: ExpenseDraft,
    members: readonly string[],
    now: Date,
  ): IResult<Expense> {
    if (!isDescription(description)) return Result.fail(new InvalidExpenseDescriptionException());
    if (!isAmount(amount)) return Result.fail(new InvalidExpenseAmountException());
    if (!isSpentBy(date, now)) return Result.fail(new InvalidExpenseDateException());
    if (!splitBetween.every(memberId => members.includes(memberId))) {
      return Result.fail(new SplitMemberNotInGroupException());
    }

    const split = Split.equally({ amount, payerId, memberIds: splitBetween });
    if (split.isFailure()) return Result.fail(split.error);

    const id = Id.generate();
    const expense = new Expense(id, groupId, description, amount, date, payerId, split.data);
    expense.record(
      ExpenseRecordedEvent.set({
        expenseId: id.value,
        groupId,
        paidBy: payerId,
        amount,
        at: now.toISOString(),
      }),
    );
    return Result.ok(expense);
  }

  toSnapshot(): ExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      description: this.#description,
      amount: this.#amount,
      date: this.#date,
      paidBy: this.#paidBy,
      shares: this.#split.shares,
    };
  }
}

/** The description is 1 to 100 characters (counted as characters, not bytes), and not only spaces. */
const isDescription = (raw: string): boolean => {
  const length = [...raw].length;
  return raw.trim() !== '' && length >= 1 && length <= Expense.MAX_DESCRIPTION_LENGTH;
};

/** A whole number of units from 1 to 100 000 000. */
const isAmount = (raw: number): boolean => Number.isInteger(raw) && raw >= 1 && raw <= Expense.MAX_AMOUNT;

/** A real day of the calendar (`YYYY-MM-DD`, round-tripped so that 2026-02-30 is refused), not after today in UTC. */
const isSpentBy = (raw: string, now: Date): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const day = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== raw) return false;
  return raw <= now.toISOString().slice(0, 10);
};

export type ExpenseRecordedPayload = { expenseId: string; groupId: string; paidBy: string; amount: number; at: string };

/**
 * The fact of a recording: which expense, of which group, paid by whom, for how much, and when it was recorded. It is made
 * durable with the expense and published after the commit; nothing subscribes to it yet (the storm lists no policy).
 */
export class ExpenseRecordedEvent extends DomainEvent<ExpenseRecordedPayload> {}
