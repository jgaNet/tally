import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { isAmount } from '@Contexts/Ledger/Domain/Expense/Expense';
import { BudgetNotFoundException, InvalidBudgetAmountException } from '@Contexts/Ledger/Domain/Budget/BudgetExceptions';

/**
 * A budget as the store keeps it: its group and category, its amount (absent once removed), the months it has passed, and the
 * version it is at.
 */
export interface BudgetSnapshot {
  readonly id: string;
  readonly groupId: string;
  readonly category: Category;
  readonly amount: number | undefined;
  readonly passedMonths: readonly string[];
  readonly version: number;
}

/**
 * The most a group's month may spend in one category (request 24, ADR 19): one per group and category, set and removed by its owner.
 * It keeps the months it has passed, so that a month's notice is made once: a month that goes further over, or comes back under and over
 * again, passes nothing more, and a budget removed and set again keeps them. Setting it passes nothing by itself. It is an aggregate root
 * because `SetBudget` and `RemoveBudget` record facts, and the policy that judges a month records `BudgetPassed`. Its version is the one it
 * was loaded at (AggregateRoot).
 */
export class Budget extends AggregateRoot {
  readonly #groupId: string;
  readonly #category: Category;
  #amount: number | undefined;
  readonly #passedMonths: string[];

  private constructor(
    id: Id,
    groupId: string,
    category: Category,
    amount: number | undefined,
    passedMonths: readonly string[],
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#category = category;
    this.#amount = amount;
    this.#passedMonths = [...passedMonths];
  }

  /** A budget for a category the group has none for: no amount yet, no month passed. Its identity is generated here (DOMAIN-IDENTITY). Pure. */
  static create(groupId: string, category: Category): Budget {
    return new Budget(Id.generate(), groupId, category, undefined, [], 0);
  }

  /** A budget the store keeps, as it was last saved. Records nothing. */
  static fromSnapshot(snapshot: BudgetSnapshot): Budget {
    return new Budget(
      new Id(snapshot.id),
      snapshot.groupId,
      snapshot.category,
      snapshot.amount,
      snapshot.passedMonths,
      snapshot.version,
    );
  }

  /**
   * Sets the amount, replacing the one it had: a whole number from 1 to 100 000 000 of the group's currency. Records `BudgetSet`; the time
   * is `now`. Who may set it is the use case's to say. Pure.
   */
  set(amount: number, now: Date): IResult<void> {
    if (!isAmount(amount)) return Result.fail(new InvalidBudgetAmountException());
    this.#amount = amount;
    this.record(
      BudgetSetEvent.set({
        budgetId: this._id.value,
        groupId: this.#groupId,
        category: this.#category,
        amount,
        at: now.toISOString(),
      }),
    );
    return Result.ok(undefined);
  }

  /**
   * Removes the budget (`unset`, not `remove`: the store's name for a deletion is not the aggregate's): the category has none in the group from now on, and the months it passed stay passed. Refused when none is set.
   * Records `BudgetRemoved`; the time is `now`. Pure.
   */
  unset(now: Date): IResult<void> {
    if (this.#amount === undefined) return Result.fail(new BudgetNotFoundException());
    this.#amount = undefined;
    this.record(
      BudgetRemovedEvent.set({
        budgetId: this._id.value,
        groupId: this.#groupId,
        category: this.#category,
        at: now.toISOString(),
      }),
    );
    return Result.ok(undefined);
  }

  /**
   * The judgement of one month (request 24): when a budget is set, what the month spends in its category (`spent`, in the group's currency's
   * hundredths) is more than the amount, and the month has not passed yet, the month passes: `BudgetPassed` is recorded for the members
   * given (`members`, read through the owned port when the judgement is made), and the month is remembered. Records nothing otherwise.
   * Returns whether the month passed. Pure: the members and the time are given.
   */
  judge(month: string, spent: number, members: readonly string[], now: Date): boolean {
    if (this.#amount === undefined || spent <= this.#amount || this.#passedMonths.includes(month)) return false;
    this.#passedMonths.push(month);
    this.record(
      BudgetPassedEvent.set({
        budgetId: this._id.value,
        groupId: this.#groupId,
        category: this.#category,
        month,
        budget: this.#amount,
        spent,
        memberIds: [...members],
        at: now.toISOString(),
      }),
    );
    return true;
  }

  get groupId(): string {
    return this.#groupId;
  }

  get category(): Category {
    return this.#category;
  }

  get amount(): number | undefined {
    return this.#amount;
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

export type BudgetSetPayload = { budgetId: string; groupId: string; category: Category; amount: number; at: string };
export type BudgetRemovedPayload = { budgetId: string; groupId: string; category: Category; at: string };
export type BudgetPassedPayload = {
  budgetId: string;
  groupId: string;
  category: Category;
  /** The month passed, `YYYY-MM`. */
  month: string;
  /** The budget the month passed, and what the month spends in the category. */
  budget: number;
  spent: number;
  /** The members to tell: the group's members when the month passed, the payer among them. */
  memberIds: string[];
  at: string;
};

/** The fact that a budget was set (or set again): it replaces the amount. Made durable with the budget and published after the commit. */
export class BudgetSetEvent extends DomainEvent<BudgetSetPayload> {}

/** The fact that a budget was removed: its category has none in the group. Published after the commit. */
export class BudgetRemovedEvent extends DomainEvent<BudgetRemovedPayload> {}

/**
 * The fact that a month passed its category's budget: every member is told once for that month (request 24). Made durable with the
 * budget's new passed month, in the reaction's transaction, and translated into the integration event BudgetPassed (ADR 19).
 */
export class BudgetPassedEvent extends DomainEvent<BudgetPassedPayload> {}
