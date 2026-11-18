import { AggregateRoot, Id, IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';

import { BudgetSnapshot } from '@Contexts/Ledger/Domain/Budget/DTOs';
import {
  BudgetPassedEvent,
  BudgetRemovedEvent,
  BudgetSetEvent,
} from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';
import { InvalidBudgetAmountException } from '@Contexts/Ledger/Domain/Budget/BudgetExceptions';
import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** The largest budget: the same bound an expense's amount has (request 24). */
export const MAX_BUDGET_AMOUNT = 100_000_000;

/**
 * A group's monthly budget for one category (request 24, docs/adr/0023): an amount in the group's currency that the group's owner sets
 * and removes. One aggregate per group and category: it keeps the months it was passed in, so that the notice for a month is made once,
 * whatever the expenses and the changes of the budget that follow.
 *
 * `open()` is the budget of a category that has none yet, which the first `setAmount()` decides on; it generates the id. `setAmount()` and `unset()`
 * are the owner's (any other member is refused); setting it again replaces its amount and makes no notice by itself. `pass()` is the
 * decision a recorded or edited expense asks for: when its month spends more than the budget in the category, and that month was not passed
 * yet, the budget records `BudgetPassed` for the members to tell, and keeps the month. Otherwise it changes nothing and answers itself.
 *
 * The version is the one it was read at, which the store checks when it saves the budget (CONC-OPTIMISTIC); the aggregate never changes it.
 */
export class Budget extends AggregateRoot {
  readonly #groupId: string;
  readonly #category: Category;
  readonly #amount: number | undefined;
  readonly #passedMonths: string[];

  private constructor(
    id: Id,
    groupId: string,
    category: Category,
    amount: number | undefined,
    passedMonths: string[],
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#category = category;
    this.#amount = amount;
    this.#passedMonths = passedMonths;
  }

  /** The budget of a category that has none yet in the group: no amount, no month passed, a new identity. Records nothing. */
  static open({ groupId, category }: { groupId: string; category: Category }): Budget {
    return new Budget(Id.generate(), groupId, category, undefined, [], 0);
  }

  /**
   * Sets the category's budget to `amount` for the group's owner (request 24). The months it was passed in are kept.
   */
  setAmount({ by, members, amount }: { by: string; members: GroupMember[]; amount: number }): IResult<Budget> {
    if (!isOwner(by, members)) return Result.fail(notAllowedToChange());
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_BUDGET_AMOUNT) {
      return Result.fail(new InvalidBudgetAmountException());
    }
    const set = this.copy({ amount });
    set.record(
      BudgetSetEvent.set({ budgetId: this._id.value, groupId: this.#groupId, category: this.#category, amount }),
    );
    return Result.ok(set);
  }

  /** Removes the category's budget for the group's owner (request 24). It is refused when none is set. */
  unset({ by, members }: { by: string; members: GroupMember[] }): IResult<Budget> {
    if (!isOwner(by, members)) return Result.fail(notAllowedToChange());
    if (this.#amount === undefined) return Result.fail(new NotFoundException('Ledger', 'There is no such budget'));
    const removed = this.copy({ amount: undefined });
    removed.record(
      BudgetRemovedEvent.set({ budgetId: this._id.value, groupId: this.#groupId, category: this.#category }),
    );
    return Result.ok(removed);
  }

  /**
   * The decision on a month's spending in the category, asked when an expense of it is recorded or edited (request 24): `spent` is what the
   * month spends in the category, `memberIds` the members to tell. It answers this budget unchanged when no budget is set, when the month
   * does not spend more than it, or when the month was passed already; otherwise it answers the budget with the month passed and records
   * `BudgetPassed`.
   */
  pass({ month, spent, memberIds }: { month: string; spent: number; memberIds: string[] }): Budget {
    if (this.#amount === undefined || spent <= this.#amount || this.#passedMonths.includes(month)) return this;
    const passed = new Budget(
      this._id,
      this.#groupId,
      this.#category,
      this.#amount,
      [...this.#passedMonths, month],
      this.version,
    );
    passed.record(
      BudgetPassedEvent.set({
        budgetId: this._id.value,
        groupId: this.#groupId,
        category: this.#category,
        month,
        budget: this.#amount,
        spent,
        memberIds: [...memberIds],
      }),
    );
    return passed;
  }

  static fromSnapshot(snapshot: BudgetSnapshot): Budget {
    const amountIsAllowed =
      snapshot.amount === undefined ||
      (Number.isInteger(snapshot.amount) && snapshot.amount >= 1 && snapshot.amount <= MAX_BUDGET_AMOUNT);
    if (
      !snapshot.id ||
      !CATEGORIES.includes(snapshot.category) ||
      !amountIsAllowed ||
      !snapshot.passedMonths.every(month => /^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    ) {
      throw new Error(`The budget ${snapshot.id} is corrupted in the store`);
    }
    return new Budget(
      new Id(snapshot.id),
      snapshot.groupId,
      snapshot.category,
      snapshot.amount,
      [...snapshot.passedMonths],
      snapshot.version,
    );
  }

  toSnapshot(): BudgetSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      category: this.#category,
      ...(this.#amount === undefined ? {} : { amount: this.#amount }),
      passedMonths: [...this.#passedMonths],
      version: this.version,
    };
  }

  get id(): string {
    return this._id.value;
  }

  get groupId(): string {
    return this.#groupId;
  }

  get category(): Category {
    return this.#category;
  }

  /** The amount set, or `undefined` when no budget is set (never set, or removed). */
  get amount(): number | undefined {
    return this.#amount;
  }

  /** Same identity, group, category and passed months, at the version it was read at; the given amount. */
  private copy({ amount }: { amount: number | undefined }): Budget {
    return new Budget(this._id, this.#groupId, this.#category, amount, [...this.#passedMonths], this.version);
  }
}

const isOwner = (by: string, members: GroupMember[]): boolean =>
  members.some(member => member.memberId === by && member.role === 'owner');

const notAllowedToChange = () => new NotAllowedException('Ledger', "Only the group's owner may set or remove a budget");
