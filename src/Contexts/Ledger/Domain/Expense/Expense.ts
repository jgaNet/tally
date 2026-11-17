import { AggregateRoot, Id } from '@Architecture/Domain';

import { ExpenseAmount } from './ExpenseAmount';
import { ExpenseDate } from './ExpenseDate';
import { ExpenseDescription } from './ExpenseDescription';
import { ExpenseDeletedEvent, ExpenseEditedEvent, ExpenseRecordedEvent } from './ExpenseEvents';
import { Share, Split, SplitKind } from './Split';

/**
 * An expense as it is stored: what it was for, what it cost, when, who paid, each member's share in the order of the split,
 * and the version it was read at (1 when it is recorded, one more at each edit, feature 6).
 */
export interface ExpenseSnapshot {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  splitKind: SplitKind;
  shares: Share[];
  version: number;
}

/**
 * An amount a member paid for some members of a group, split one of the three ways, kept as it was recorded (ADR 5,
 * request 7). Its id is born
 * here, once; its shares are the split's, which keep that they add up to the amount. It is given again, whole, by an edit
 * (`revise`), and removed by a deletion (`delete`); its payer never changes. It carries the version it was loaded at, and
 * its repository refuses to save it over a newer one (CONC-OPTIMISTIC). The balances of a group are read from the
 * expenses, never held by one (feature 5).
 */
export class Expense extends AggregateRoot {
  readonly #groupId: string;
  #description: ExpenseDescription;
  #amount: ExpenseAmount;
  #date: ExpenseDate;
  #split: Split;

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
        splitKind: split.kind,
      }),
    );
    return expense;
  }

  /**
   * Rebuilds an expense as it was stored, at the version it was stored at. Records nothing, and throws on data no
   * `register()` or `revise()` could have made: a split whose kind and amounts are not one the split could have given.
   */
  static fromSnapshot(snapshot: ExpenseSnapshot): Expense {
    const description = ExpenseDescription.create(snapshot.description);
    const amount = ExpenseAmount.create(snapshot.amount);
    const date = ExpenseDate.restore(snapshot.date);
    const corrupted =
      description.isFailure() ||
      amount.isFailure() ||
      date.isFailure() ||
      !Number.isInteger(snapshot.version) ||
      snapshot.version < 1;
    if (corrupted) throw new Error(`The stored expense ${snapshot.id} is corrupted`);
    const split = Split.restore({
      amount: amount.data!.value,
      payer: snapshot.paidBy,
      kind: snapshot.splitKind,
      shares: snapshot.shares,
    });
    if (!split) throw new Error(`The stored expense ${snapshot.id} is corrupted`);
    return new Expense(
      new Id(snapshot.id),
      snapshot.version,
      snapshot.groupId,
      description.data!,
      amount.data!,
      date.data!,
      split,
    );
  }

  /**
   * The expense given again, whole: its description, amount, date and split, as the decision allowed them. Its payer stays
   * the one who paid, so the split is the payer's; recorded as `ExpenseEdited`. The version is not changed here: it is
   * stored one more on save.
   */
  revise({
    description,
    amount,
    date,
    split,
  }: {
    description: ExpenseDescription;
    amount: ExpenseAmount;
    date: ExpenseDate;
    split: Split;
  }): void {
    if (split.payer !== this.#split.payer) throw new Error('An edit never changes the payer of an expense');
    this.#description = description;
    this.#amount = amount;
    this.#date = date;
    this.#split = split;
    this.record(
      ExpenseEditedEvent.set({
        expenseId: this._id.value,
        groupId: this.#groupId,
        paidBy: split.payer,
        amount: amount.value,
        splitKind: split.kind,
      }),
    );
  }

  /** The expense is deleted: recorded as `ExpenseDeleted`, and removed from storage with its shares on save. */
  delete(): void {
    this.record(
      ExpenseDeletedEvent.set({
        expenseId: this._id.value,
        groupId: this.#groupId,
        paidBy: this.#split.payer,
        amount: this.#amount.value,
      }),
    );
  }

  toSnapshot(): ExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      description: this.#description.value,
      amount: this.#amount.value,
      date: this.#date.value,
      paidBy: this.#split.payer,
      splitKind: this.#split.kind,
      shares: [...this.#split.shares],
      version: this.version,
    };
  }
}
