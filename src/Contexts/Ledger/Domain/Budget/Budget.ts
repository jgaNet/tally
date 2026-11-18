import { AggregateRoot, Id } from '@Architecture/Domain';

import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';

import { BudgetAmount } from './BudgetAmount';
import { BudgetPassedEvent, BudgetRemovedEvent, BudgetSetEvent } from './BudgetEvents';

/**
 * A budget as it is stored: the group and the category it is for, its amount (none once it is removed), the months it has been passed
 * in, and the version it was read at.
 */
export interface BudgetSnapshot {
  id: string;
  groupId: string;
  category: ExpenseCategory;
  amount: number | undefined;
  passedMonths: string[];
  version: number;
}

/**
 * The monthly budget of one category of one group (request 24). It keeps the months it has been passed in, so that it records
 * `BudgetPassed` once for a month: a month that goes further over, or comes back under and over again, passes it no more, and neither
 * does a budget removed and set again. Removing it keeps that memory and no amount. It carries the version it was loaded at, and its
 * repository refuses to save it over a newer one (CONC-OPTIMISTIC).
 */
export class Budget extends AggregateRoot {
  readonly #groupId: string;
  readonly #category: ExpenseCategory;
  #amount: number | undefined;
  #passedMonths: string[];

  private constructor(
    id: Id,
    version: number,
    groupId: string,
    category: ExpenseCategory,
    amount: number | undefined,
    passedMonths: string[],
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#category = category;
    this.#amount = amount;
    this.#passedMonths = passedMonths;
  }

  /** The first budget of a category of a group, its id generated here. Records `BudgetSet`. */
  static create({
    groupId,
    category,
    amount,
  }: {
    groupId: string;
    category: ExpenseCategory;
    amount: BudgetAmount;
  }): Budget {
    const budget = new Budget(Id.generate(), 0, groupId, category, undefined, []);
    budget.setAmount(amount);
    return budget;
  }

  /** Rebuilds a budget as it was stored. Records nothing, and throws on data no `create()` could have made. */
  static fromSnapshot(snapshot: BudgetSnapshot): Budget {
    const amount = snapshot.amount === undefined ? undefined : BudgetAmount.create(snapshot.amount);
    if (amount?.isFailure() || !Number.isInteger(snapshot.version) || snapshot.version < 1) {
      throw new Error(`The stored budget ${snapshot.id} is corrupted`);
    }
    return new Budget(new Id(snapshot.id), snapshot.version, snapshot.groupId, snapshot.category, amount?.data?.value, [
      ...snapshot.passedMonths,
    ]);
  }

  /** The budget is this amount from now on, whatever it was. Records `BudgetSet`; makes no notice by itself. */
  setAmount(amount: BudgetAmount): void {
    this.#amount = amount.value;
    this.record(
      BudgetSetEvent.set({
        budgetId: this._id.value,
        groupId: this.#groupId,
        category: this.#category,
        amount: amount.value,
      }),
    );
  }

  /** The budget is retired (removed by its owner): no amount from now on, the months it was passed in kept. Records `BudgetRemoved`. */
  retire(): void {
    this.#amount = undefined;
    this.record(BudgetRemovedEvent.set({ budgetId: this._id.value, groupId: this.#groupId, category: this.#category }));
  }

  /**
   * The month spent more than the budget: it is passed for that month, once. Records `BudgetPassed` with the members to tell. A budget
   * that has no amount, or has been passed in that month, is a programming error to pass.
   */
  pass({ month, spent, memberIds }: { month: string; spent: number; memberIds: readonly string[] }): void {
    if (this.#amount === undefined || this.#passedMonths.includes(month)) {
      throw new Error('A budget is passed once for a month, and only while it has an amount');
    }
    this.#passedMonths.push(month);
    this.record(
      BudgetPassedEvent.set({
        budgetId: this._id.value,
        groupId: this.#groupId,
        category: this.#category,
        month,
        budget: this.#amount,
        spent,
        memberIds,
      }),
    );
  }

  toSnapshot(): BudgetSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      category: this.#category,
      amount: this.#amount,
      passedMonths: [...this.#passedMonths],
      version: this.version,
    };
  }
}
