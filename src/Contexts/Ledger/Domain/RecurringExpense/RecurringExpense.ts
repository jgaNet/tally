import { AggregateRoot, Id } from '@Architecture/Domain';

import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

import { monthAfter } from './RecurringDay';
import {
  RecurringExpenseDayCameEvent,
  RecurringExpenseEndedEvent,
  RecurringExpenseSetUpEvent,
  RecurringExpenseStoppedEvent,
} from './RecurringExpenseEvents';

/** A recurring expense as it is stored: its payer, description, amount, `startsOn`, the day of the next expense (`next`), and its split as given. */
export interface RecurringExpenseSnapshot {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  split: SplitRequest;
  /** What its expenses are for (request 24). */
  category: ExpenseCategory;
  version: number;
}

/**
 * An expense its payer pays every month (request 23): from `startsOn` on, on its day of every month, an expense of the group is
 * recorded for it by the background job. The aggregate holds the day of its next expense; `recordDay()` moves it to the same day of
 * the following month and records `RecurringExpenseDayCame`, which carries the id of the expense that day becomes.
 */
export class RecurringExpense extends AggregateRoot {
  readonly #groupId: string;
  readonly #paidBy: string;
  readonly #description: string;
  readonly #amount: number;
  readonly #startsOn: string;
  #next: string;
  readonly #split: SplitRequest;
  readonly #category: ExpenseCategory;

  private constructor(
    id: Id,
    version: number,
    groupId: string,
    paidBy: string,
    description: string,
    amount: number,
    startsOn: string,
    next: string,
    split: SplitRequest,
    category: ExpenseCategory,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#paidBy = paidBy;
    this.#description = description;
    this.#amount = amount;
    this.#startsOn = startsOn;
    this.#next = next;
    this.#split = split;
    this.#category = category;
  }

  /** A new recurring expense, its id generated here, whose first expense is on `startsOn`. Records `RecurringExpenseSetUp`. */
  static setUp({
    groupId,
    paidBy,
    description,
    amount,
    startsOn,
    split,
    category,
  }: {
    groupId: string;
    paidBy: string;
    description: string;
    amount: number;
    startsOn: string;
    split: SplitRequest;
    category: ExpenseCategory;
  }): RecurringExpense {
    const recurring = new RecurringExpense(
      Id.generate(),
      0,
      groupId,
      paidBy,
      description,
      amount,
      startsOn,
      startsOn,
      split,
      category,
    );
    recurring.record(RecurringExpenseSetUpEvent.set({ recurringId: recurring._id.value, groupId, paidBy }));
    return recurring;
  }

  /** Rebuilds a recurring expense as it was stored, at the version it was stored at. Records nothing. */
  static fromSnapshot(snapshot: RecurringExpenseSnapshot): RecurringExpense {
    return new RecurringExpense(
      new Id(snapshot.id),
      snapshot.version,
      snapshot.groupId,
      snapshot.paidBy,
      snapshot.description,
      snapshot.amount,
      snapshot.startsOn,
      snapshot.next,
      snapshot.split,
      snapshot.category,
    );
  }

  /**
   * The day of its next expense comes and is recorded: `next` moves to the same day of the following month, and the fact that a day came
   * carries the id the expense of that day is born with.
   */
  recordDay(day: string): void {
    this.#next = monthAfter(day);
    this.record(
      RecurringExpenseDayCameEvent.set({
        recurringId: this._id.value,
        expenseId: Id.generate().value,
        groupId: this.#groupId,
        paidBy: this.#paidBy,
        description: this.#description,
        amount: this.#amount,
        day,
        split: this.#split,
        category: this.#category,
      }),
    );
  }

  /** Stopped by its payer or the group's owner: it no longer exists. Records `RecurringExpenseStopped`. */
  stop(): void {
    this.record(RecurringExpenseStoppedEvent.set({ recurringId: this._id.value, groupId: this.#groupId }));
  }

  /** Ended, because a member it concerns has left the group: it no longer exists. Records `RecurringExpenseEnded`. */
  end(): void {
    this.record(RecurringExpenseEndedEvent.set({ recurringId: this._id.value, groupId: this.#groupId }));
  }

  get groupId(): string {
    return this.#groupId;
  }

  toSnapshot(): RecurringExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      paidBy: this.#paidBy,
      description: this.#description,
      amount: this.#amount,
      startsOn: this.#startsOn,
      next: this.#next,
      split: this.#split,
      category: this.#category,
      version: this.version,
    };
  }
}
