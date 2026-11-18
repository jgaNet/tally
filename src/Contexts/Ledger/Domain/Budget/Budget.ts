import { AggregateRoot, Id, IResult, NotAllowedException, Result } from '@Architecture/Domain';

import { IBudgetSnapshot } from '@Contexts/Ledger/Domain/Budget/DTOs';
import {
  BudgetPassedEvent,
  BudgetRemovedEvent,
  BudgetSetEvent,
} from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';
import { InvalidBudgetAmountException, NoBudgetException } from '@Contexts/Ledger/Domain/Budget/BudgetExceptions';
import { Category, isCategory } from '@Contexts/Ledger/Domain/Expense/Category';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** The largest budget a category may have, in the group's currency (request 24). */
export const LARGEST_BUDGET = 100_000_000;

/**
 * Budget is the aggregate root of one group's monthly budget for one category (request 24): the owner sets it, and removes
 * it; it keeps the months in which the spending of the category passed it, so that a month is notified once, however often
 * the spending goes over and comes back under.
 *
 * `decide` is asked when an expense of the category is recorded or edited: when the month's spending is more than the
 * budget, and the month has not been passed before, BudgetPassed is recorded with the members to tell, and the month is
 * kept. Setting or changing a budget makes no notice by itself. Any other member is refused: the budget is the owner's.
 */
export class Budget extends AggregateRoot {
  readonly #groupId: string;
  readonly #category: Category;
  readonly #amount: number | null;
  readonly #passedMonths: string[];

  private constructor(
    id: Id,
    groupId: string,
    category: Category,
    amount: number | null,
    passedMonths: string[],
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#category = category;
    this.#amount = amount;
    this.#passedMonths = passedMonths;
  }

  /** The budget of a category of a group, not set yet: no amount, and no month passed. Nothing is decided, so nothing is recorded. */
  static create({ groupId, category }: { groupId: string; category: Category }): Budget {
    return new Budget(Id.generate(), groupId, category, null, [], 0);
  }

  /**
   * Sets the budget to `amount`, as `setBy` asks: only the group's owner may. An amount is from 1 to 100 000 000; any other
   * is refused. Records BudgetSet; setting it again replaces the amount.
   */
  setAmount({ setBy, members, amount }: { setBy: string; members: GroupMember[]; amount: number }): IResult<Budget> {
    if (!isOwner(setBy, members)) return Result.fail(notOwner('Only the group’s owner may set a budget'));
    if (!Number.isInteger(amount) || amount < 1 || amount > LARGEST_BUDGET) {
      return Result.fail(new InvalidBudgetAmountException());
    }

    const set = this.withAmount(amount);
    set.record(
      BudgetSetEvent.set({
        budgetId: this._id.value,
        groupId: this.#groupId,
        category: this.#category,
        amount,
      }),
    );
    return Result.ok(set);
  }

  /**
   * Removes the budget, as `removedBy` asks: only the group's owner may, and only a budget that is set. Records BudgetRemoved.
   * The months it passed are kept, so that setting it again does not notify a month a second time.
   */
  unset({ removedBy, members }: { removedBy: string; members: GroupMember[] }): IResult<Budget> {
    if (!isOwner(removedBy, members)) return Result.fail(notOwner('Only the group’s owner may remove a budget'));
    if (this.#amount === null) return Result.fail(new NoBudgetException());

    const removed = this.withAmount(null);
    removed.record(
      BudgetRemovedEvent.set({
        budgetId: this._id.value,
        groupId: this.#groupId,
        category: this.#category,
      }),
    );
    return Result.ok(removed);
  }

  /**
   * Decides a month at the spending asked: when the budget is set, the month's spending (`spent`, in the group's currency) is
   * more than it, and the month has not been passed before, the budget passes the month: BudgetPassed is recorded, with the
   * members to tell as they were given (`memberIds`), and the month is kept. Answers the budget to store, or null when
   * nothing changed, so that nothing is saved.
   */
  decide({ month, spent, memberIds }: { month: string; spent: number; memberIds: string[] }): Budget | null {
    if (this.#amount === null || spent <= this.#amount || this.#passedMonths.includes(month)) return null;

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

  /** Rebuilds a budget from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: IBudgetSnapshot): Budget {
    if (
      !snapshot.groupId ||
      !isCategory(snapshot.category) ||
      (snapshot.amount !== null && !Number.isInteger(snapshot.amount))
    ) {
      throw new Error(`Corrupted budget ${snapshot._id}`);
    }
    return new Budget(
      new Id(snapshot._id),
      snapshot.groupId,
      snapshot.category,
      snapshot.amount,
      [...snapshot.passedMonths],
      snapshot.version,
    );
  }

  toSnapshot(): IBudgetSnapshot {
    return {
      _id: this._id.value,
      groupId: this.#groupId,
      category: this.#category,
      amount: this.#amount,
      passedMonths: [...this.#passedMonths],
      version: this.version,
    };
  }

  get category(): Category {
    return this.#category;
  }

  /** The same budget with another amount, at the version it was read at: the store makes it the next one. */
  private withAmount(amount: number | null): Budget {
    return new Budget(this._id, this.#groupId, this.#category, amount, [...this.#passedMonths], this.version);
  }
}

const isOwner = (memberId: string, members: GroupMember[]): boolean =>
  members.some(member => member.memberId === memberId && member.role === 'owner');

const notOwner = (message: string): NotAllowedException => new NotAllowedException('Ledger', message);
