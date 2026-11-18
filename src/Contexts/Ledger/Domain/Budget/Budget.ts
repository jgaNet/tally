import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Category, CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';
import {
  BudgetPassedEvent,
  BudgetRemovedEvent,
  BudgetSetEvent,
} from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';
import { BudgetNotSet, NotTheOwnerOfTheGroup } from '@Contexts/Ledger/Domain/Budget/BudgetExceptions';

/** What a budget is, as it is kept. `removed` budgets keep the months they were passed in. */
export interface BudgetSnapshot {
  id: string;
  groupId: string;
  category: string;
  amount: number;
  removed: boolean;
  passedMonths: string[];
  version: number;
}

/**
 * What a group's month may spend in a category (request 24): one per group and category, set and removed by the group's owner. It
 * keeps the months it has been passed in, so that a month that goes over it is told once: a month that goes further over, or comes
 * back under and over again, is not told again, and neither is one once the budget is removed and set again.
 */
export class Budget extends AggregateRoot {
  private constructor(
    id: Id,
    readonly groupId: Id,
    readonly category: Category,
    readonly amount: Amount,
    readonly removed: boolean,
    private readonly passedMonths: string[],
    version: number,
  ) {
    super(id, version);
  }

  /** Sets a first budget for the category: only the group's owner (`byOwner`, read by the handler) may. */
  static set({
    groupId,
    category,
    amount,
    byOwner,
  }: {
    groupId: Id;
    category: CategoryName;
    amount: number;
    byOwner: boolean;
  }): IResult<Budget> {
    if (!byOwner) return Result.fail(new NotTheOwnerOfTheGroup());
    const value = Amount.create(amount);
    if (value.isFailure()) return value;

    const budget = new Budget(Id.generate(), groupId, Category.restore(category), value.data, false, [], 0);
    budget.record(
      BudgetSetEvent.set({
        budgetId: budget._id.value,
        groupId: groupId.value,
        category,
        amount: value.data.value,
      }),
    );
    return Result.ok(budget);
  }

  /** Sets the budget again, with another amount (or after it was removed): the months it was passed in are kept. */
  replace({ amount, byOwner }: { amount: number; byOwner: boolean }): IResult<Budget> {
    if (!byOwner) return Result.fail(new NotTheOwnerOfTheGroup());
    const value = Amount.create(amount);
    if (value.isFailure()) return value;

    const replaced = this.with({ amount: value.data, removed: false });
    replaced.record(
      BudgetSetEvent.set({
        budgetId: this._id.value,
        groupId: this.groupId.value,
        category: this.category.value,
        amount: value.data.value,
      }),
    );
    return Result.ok(replaced);
  }

  /** Unsets the budget: only the group's owner may, and only a budget that is set. */
  unset({ byOwner }: { byOwner: boolean }): IResult<Budget> {
    if (!byOwner) return Result.fail(new NotTheOwnerOfTheGroup());
    if (this.removed) return Result.fail(new BudgetNotSet());

    const removed = this.with({ removed: true });
    removed.record(
      BudgetRemovedEvent.set({
        budgetId: this._id.value,
        groupId: this.groupId.value,
        category: this.category.value,
      }),
    );
    return Result.ok(removed);
  }

  /**
   * Decides whether `month` (YYYY-MM), which now spends `spent` in the category, has passed the budget for the first time: it did
   * when the budget is set, `spent` is more than it, and the month was not passed before. Then the budget records `BudgetPassed`, with
   * the `members` of the group to tell, and remembers the month; otherwise it changes nothing and answers itself.
   */
  pass({ month, spent, members }: { month: string; spent: number; members: Id[] }): Budget {
    if (this.removed || spent <= this.amount.value || this.passedMonths.includes(month)) return this;

    const passed = this.with({ passedMonths: [...this.passedMonths, month] });
    passed.record(
      BudgetPassedEvent.set({
        budgetId: this._id.value,
        groupId: this.groupId.value,
        category: this.category.value,
        month,
        budget: this.amount.value,
        spent,
        members: members.map(member => member.value),
      }),
    );
    return passed;
  }

  static fromSnapshot(snapshot: BudgetSnapshot): Budget {
    const amount = Amount.create(snapshot.amount);
    if (amount.isFailure()) throw new Error(`The budget ${snapshot.id} is corrupted`);
    return new Budget(
      new Id(snapshot.id),
      new Id(snapshot.groupId),
      Category.restore(snapshot.category),
      amount.data,
      snapshot.removed,
      snapshot.passedMonths,
      snapshot.version,
    );
  }

  toSnapshot(): BudgetSnapshot {
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      category: this.category.value,
      amount: this.amount.value,
      removed: this.removed,
      passedMonths: [...this.passedMonths],
      version: this.version,
    };
  }

  /** The same budget with the given changes, keeping this version: the one it was read at. */
  private with(changes: { amount?: Amount; removed?: boolean; passedMonths?: string[] }): Budget {
    return new Budget(
      this._id,
      this.groupId,
      this.category,
      changes.amount ?? this.amount,
      changes.removed ?? this.removed,
      changes.passedMonths ?? this.passedMonths,
      this.version,
    );
  }
}
