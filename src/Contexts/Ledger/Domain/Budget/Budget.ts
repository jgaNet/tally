import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { GroupArchived } from '@SharedKernel/Domain';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import {
  BudgetPassedEvent,
  BudgetRemovedEvent,
  BudgetSetEvent,
} from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';
import { InvalidBudgetAmount, NotAllowedToChangeBudget } from '@Contexts/Ledger/Domain/Budget/BudgetExceptions';

/** The largest budget a category may have, in the group's currency (request 24). */
export const MAX_BUDGET = 100_000_000;

/** A budget as it is stored and reconstituted: plain values, its version included. */
export interface BudgetSnapshot {
  id: string;
  groupId: string;
  category: Category;
  amount: number;
  active: boolean;
  passedMonths: string[];
  version: number;
}

/**
 * The monthly budget of one category of a group (request 24). The owner of the group sets it, and removes it; a removed
 * budget keeps the months it was passed in, so that a month is told once whatever is set or removed after it. `set()` and
 * `remove()` are the owner's, and refuse any other member (NotAllowedToChangeBudget). `judge()` is asked for each month an
 * expense is recorded or edited in: when the month's spending is more than the budget, and this month was not yet passed,
 * the month is recorded as passed and BudgetPassed is recorded, once. Every operation answers a new instance at the version
 * this one was read at, and returns this one when nothing changes.
 */
export class Budget extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly groupId: Id,
    readonly category: Category,
    readonly amount: number,
    readonly active: boolean,
    readonly passedMonths: readonly string[],
  ) {
    super(id, version);
  }

  /** Establishes the first budget of a category: validates the amount and records BudgetSet. */
  static establish({
    groupId,
    category,
    amount,
    byOwner,
    groupArchived,
    at,
  }: {
    groupId: Id;
    category: Category;
    amount: number;
    byOwner: boolean;
    groupArchived: boolean;
    at: Date;
  }): IResult<Budget> {
    if (groupArchived) return Result.fail(new GroupArchived());
    if (!byOwner) return Result.fail(new NotAllowedToChangeBudget());
    if (!isAmount(amount)) return Result.fail(new InvalidBudgetAmount());

    const budget = new Budget(Id.generate(), 0, groupId, category, amount, true, []);
    budget.record(
      BudgetSetEvent.set({
        budgetId: budget._id.value,
        groupId: groupId.value,
        category,
        amount,
        setAt: at.toISOString(),
      }),
    );
    return Result.ok(budget);
  }

  /** Sets the budget again, or sets it again after it was removed (its passed months are kept). Records BudgetSet. */
  amend({
    byOwner,
    groupArchived,
    amount,
    at,
  }: {
    byOwner: boolean;
    groupArchived: boolean;
    amount: number;
    at: Date;
  }): IResult<Budget> {
    if (groupArchived) return Result.fail(new GroupArchived());
    if (!byOwner) return Result.fail(new NotAllowedToChangeBudget());
    if (!isAmount(amount)) return Result.fail(new InvalidBudgetAmount());

    const set = this.moved({ amount, active: true });
    set.record(
      BudgetSetEvent.set({
        budgetId: this._id.value,
        groupId: this.groupId.value,
        category: this.category,
        amount,
        setAt: at.toISOString(),
      }),
    );
    return Result.ok(set);
  }

  /** Removes the budget: only the owner may. A budget already removed is answered as it is. Records BudgetRemoved. */
  lift({ byOwner, groupArchived, at }: { byOwner: boolean; groupArchived: boolean; at: Date }): IResult<Budget> {
    if (groupArchived) return Result.fail(new GroupArchived());
    if (!byOwner) return Result.fail(new NotAllowedToChangeBudget());
    if (!this.active) return Result.ok(this);

    const removed = this.moved({ active: false });
    removed.record(
      BudgetRemovedEvent.set({
        budgetId: this._id.value,
        groupId: this.groupId.value,
        category: this.category,
        removedAt: at.toISOString(),
      }),
    );
    return Result.ok(removed);
  }

  /**
   * Judges a month of the category, once its spending is known: `spent` is what the month spends in the category, and
   * `memberIds` the members of the group to tell. Passed when `spent` is more than the budget and the month was not yet
   * passed; otherwise this is answered as it is.
   */
  judge({ month, spent, memberIds, at }: { month: string; spent: number; memberIds: readonly Id[]; at: Date }): Budget {
    if (!this.active || spent <= this.amount || this.passedMonths.includes(month)) return this;

    const passed = this.moved({ passedMonths: [...this.passedMonths, month] });
    passed.record(
      BudgetPassedEvent.set({
        budgetId: this._id.value,
        groupId: this.groupId.value,
        category: this.category,
        month,
        budget: this.amount,
        spent,
        memberIds: memberIds.map(member => member.value),
        passedAt: at.toISOString(),
      }),
    );
    return passed;
  }

  private moved({
    amount = this.amount,
    active = this.active,
    passedMonths = [...this.passedMonths],
  }: {
    amount?: number;
    active?: boolean;
    passedMonths?: string[];
  }): Budget {
    return new Budget(this._id, this.version, this.groupId, this.category, amount, active, passedMonths);
  }

  /** Reconstitutes a stored budget. It records nothing. */
  static fromSnapshot(snapshot: BudgetSnapshot): Budget {
    return new Budget(
      new Id(snapshot.id),
      snapshot.version,
      new Id(snapshot.groupId),
      snapshot.category,
      snapshot.amount,
      snapshot.active,
      snapshot.passedMonths,
    );
  }

  toSnapshot(): BudgetSnapshot {
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      category: this.category,
      amount: this.amount,
      active: this.active,
      passedMonths: [...this.passedMonths],
      version: this.version,
    };
  }
}

function isAmount(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount >= 1 && amount <= MAX_BUDGET;
}
