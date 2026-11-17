import { AggregateRoot, Id } from '@Architecture/Domain';

import { ExpenseAmount } from './ExpenseAmount';
import { ExpenseDate } from './ExpenseDate';
import { ExpenseDescription } from './ExpenseDescription';
import { ExpenseRecordedEvent } from './ExpenseEvents';
import { Share, Split } from './Split';

/** An expense as it is stored: what it was for, what it cost, when, who paid, and each member's share in the order of the split. */
export interface ExpenseSnapshot {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: Share[];
}

/**
 * An amount a member paid for some members of a group, split equally, kept as it was recorded (ADR 5). Its id is born
 * here, once; its shares are the split's, which keep that they add up to the amount. One expense is one aggregate: the
 * balances of a group are read from the expenses, never held by one (feature 5).
 */
export class Expense extends AggregateRoot {
  readonly #groupId: string;
  readonly #description: ExpenseDescription;
  readonly #amount: ExpenseAmount;
  readonly #date: ExpenseDate;
  readonly #split: Split;

  private constructor(
    id: Id,
    version: number,
    groupId: string,
    description: ExpenseDescription,
    amount: ExpenseAmount,
    date: ExpenseDate,
    split: Split,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#description = description;
    this.#amount = amount;
    this.#date = date;
    this.#split = split;
  }

  /** A new expense in the group, with its id generated here, recording that it was `ExpenseRecorded`. */
  static register({
    groupId,
    description,
    amount,
    date,
    split,
  }: {
    groupId: string;
    description: ExpenseDescription;
    amount: ExpenseAmount;
    date: ExpenseDate;
    split: Split;
  }): Expense {
    const expense = new Expense(Id.generate(), 0, groupId, description, amount, date, split);
    expense.record(
      ExpenseRecordedEvent.set({
        expenseId: expense._id.value,
        groupId,
        paidBy: split.payer,
        amount: amount.value,
      }),
    );
    return expense;
  }

  toSnapshot(): ExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      description: this.#description.value,
      amount: this.#amount.value,
      date: this.#date.value,
      paidBy: this.#split.payer,
      shares: [...this.#split.shares],
    };
  }
}
