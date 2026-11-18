import { AggregateRoot, Id, IResult, NotAllowedException, Result } from '@Architecture/Domain';

import { IRecurringExpenseSnapshot } from '@Contexts/Ledger/Domain/RecurringExpense/DTOs';
import { RecurringDay } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringDay';
import {
  RecurringExpenseDayCameEvent,
  RecurringExpenseEndedEvent,
  RecurringExpenseSetUpEvent,
  RecurringExpenseStoppedEvent,
} from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';
import { ExpenseAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import { ExpenseDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseDescription';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { Split, SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  Category,
  DEFAULT_CATEGORY,
  InvalidCategoryException,
  isCategory,
} from '@Contexts/Ledger/Domain/Expense/Category';
import { RecurringExpenseMovedEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';

/**
 * RecurringExpense is the aggregate root of an expense its payer pays every month (request 23): what it is for, how much, the
 * members it is split between as it was given, and the day of its next expense. It is set up by a member of a group, the payer,
 * and checked as an expense is: its split lists members of the group, once each, the payer among them.
 *
 * Its days are recorded by the background job, never by a read: `settleDay` decides the next day once it has come. If the payer
 * or a member of its split has left the group by then, the recurring expense ends (RecurringExpenseEnded) and records no expense;
 * otherwise its day is recorded (RecurringExpenseDayCame, carrying the id of the expense it makes, made here once) and `next`
 * moves to the same day of the next month. The store makes the move at the version it was read at, so that two servers deciding
 * the same day cannot both record it. Its payer, or the group's owner, may stop it (RecurringExpenseStopped).
 */
export class RecurringExpense extends AggregateRoot {
  #groupId: string;
  readonly #paidBy: string;
  readonly #currency: string;
  readonly #description: ExpenseDescription;
  readonly #amount: ExpenseAmount;
  readonly #startsOn: RecurringDay;
  readonly #next: RecurringDay;
  readonly #split: SplitRequest;
  readonly #category: Category;

  private constructor(
    id: Id,
    groupId: string,
    paidBy: string,
    currency: string,
    description: ExpenseDescription,
    amount: ExpenseAmount,
    startsOn: RecurringDay,
    next: RecurringDay,
    split: SplitRequest,
    category: Category,
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#paidBy = paidBy;
    this.#currency = currency;
    this.#description = description;
    this.#amount = amount;
    this.#startsOn = startsOn;
    this.#next = next;
    this.#split = split;
    this.#category = category;
  }

  /**
   * Sets up a recurring expense paid by `paidBy`, in the group's `currency`, starting on `startsOn`. `memberIds` are the group's
   * current members, as Groups answers them, and `today` is the application's clock. Every value is checked here; a refusal is a
   * failed Result. Records RecurringExpenseSetUp.
   */
  static setUp({
    groupId,
    paidBy,
    currency,
    description,
    amount,
    startsOn,
    split,
    memberIds,
    today,
    category = DEFAULT_CATEGORY,
  }: {
    groupId: string;
    paidBy: string;
    currency: string;
    description: string;
    amount: number;
    startsOn: string;
    split: SplitRequest;
    memberIds: string[];
    today: Date;
    /** The category each expense it records is in, one of eight; `other` when left out (request 24). */
    category?: Category;
  }): IResult<RecurringExpense> {
    if (!isCategory(category)) return Result.fail(new InvalidCategoryException());
    const validDescription = ExpenseDescription.create(description);
    if (validDescription.isFailure()) return Result.fail(validDescription.error);
    const validAmount = ExpenseAmount.create(amount);
    if (validAmount.isFailure()) return Result.fail(validAmount.error);
    const validStart = RecurringDay.startingOn(startsOn, today);
    if (validStart.isFailure()) return Result.fail(validStart.error);
    // The split is checked as an expense's is; its shares are not kept, each expense computes its own when it is recorded.
    const checked = Split.decide({ request: split, amount: validAmount.data.value, payerId: paidBy, memberIds });
    if (checked.isFailure()) return Result.fail(checked.error);

    const recurring = new RecurringExpense(
      Id.generate(),
      groupId,
      paidBy,
      currency,
      validDescription.data,
      validAmount.data,
      validStart.data,
      validStart.data,
      split,
      category,
      0,
    );
    recurring.record(RecurringExpenseSetUpEvent.set({ recurringId: recurring._id.value, groupId, paidBy }));
    return Result.ok(recurring);
  }

  /**
   * Stops the recurring expense, as `stoppedBy` asks: only its payer and the group's owner may. Records RecurringExpenseStopped;
   * the store removes it, so that no expense is recorded for it from then on.
   */
  stop({ stoppedBy, members }: { stoppedBy: string; members: GroupMember[] }): IResult {
    const allowed =
      stoppedBy === this.#paidBy || members.some(member => member.memberId === stoppedBy && member.role === 'owner');
    if (!allowed) {
      return Result.fail(
        new NotAllowedException('Ledger', 'Only the payer or the group’s owner may stop a recurring expense'),
      );
    }
    this.record(RecurringExpenseStoppedEvent.set({ recurringId: this._id.value, groupId: this.#groupId }));
    return Result.ok();
  }

  /**
   * Decides the day of the next expense at `today`, given the group's current members (ids) as Groups answers them:
   * - `waiting`: that day has not come yet; nothing is decided;
   * - `ended`: the payer or a member of the split has left; RecurringExpenseEnded is recorded, and the store removes it;
   * - `recorded`: the day is recorded: an expense id is made, RecurringExpenseDayCame is recorded, and the new version, with
   *   `next` a month on, is what the store saves.
   * A day that has come is decided once: the saved version moves `next` past it.
   */
  settleDay({ today, memberIds }: { today: Date; memberIds: string[] }): DayDecision {
    if (!this.#next.hasComeBy(today)) return { kind: 'waiting' };

    const current = new Set(memberIds);
    if (this.involvedMemberIds().some(memberId => !current.has(memberId))) {
      this.record(RecurringExpenseEndedEvent.set({ recurringId: this._id.value, groupId: this.#groupId }));
      return { kind: 'ended', recurring: this };
    }

    const advanced = new RecurringExpense(
      this._id,
      this.#groupId,
      this.#paidBy,
      this.#currency,
      this.#description,
      this.#amount,
      this.#startsOn,
      this.#next.monthAfter(),
      this.#split,
      this.#category,
      this.version,
    );
    advanced.record(
      RecurringExpenseDayCameEvent.set({
        recurringId: this._id.value,
        groupId: this.#groupId,
        expenseId: Id.generate().value,
        paidBy: this.#paidBy,
        currency: this.#currency,
        description: this.#description.value,
        amount: this.#amount.value,
        date: this.#next.value,
        split: this.#split,
        category: this.#category,
      }),
    );
    return { kind: 'recorded', recurring: advanced };
  }

  /** Rebuilds a recurring expense from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: IRecurringExpenseSnapshot): RecurringExpense {
    const description = ExpenseDescription.create(snapshot.description);
    const amount = ExpenseAmount.create(snapshot.amount);
    const startsOn = RecurringDay.parse(snapshot.startsOn);
    const next = RecurringDay.parse(snapshot.next);
    if (
      description.isFailure() ||
      amount.isFailure() ||
      startsOn.isFailure() ||
      next.isFailure() ||
      !snapshot.paidBy ||
      !snapshot.currency ||
      !SPLIT_KINDS.includes(snapshot.split.kind) ||
      !isCategory(snapshot.category)
    ) {
      throw new Error(`Corrupted recurring expense ${snapshot._id}`);
    }
    return new RecurringExpense(
      new Id(snapshot._id),
      snapshot.groupId,
      snapshot.paidBy,
      snapshot.currency,
      description.data,
      amount.data,
      startsOn.data,
      next.data,
      snapshot.split,
      snapshot.category,
      snapshot.version,
    );
  }

  toSnapshot(): IRecurringExpenseSnapshot {
    return {
      _id: this._id.value,
      groupId: this.#groupId,
      paidBy: this.#paidBy,
      currency: this.#currency,
      description: this.#description.value,
      amount: this.#amount.value,
      startsOn: this.#startsOn.value,
      next: this.#next.value,
      split: structuredClone(this.#split),
      category: this.#category,
      version: this.version,
    };
  }

  /**
   * The recurring expense moves to the group it names, the group merged into the group kept (request 31): its id, its payer, its
   * split, its version and its next day are kept, and RecurringExpenseMoved is recorded.
   */
  moveTo(groupId: string): void {
    const from = this.#groupId;
    this.#groupId = groupId;
    this.record(RecurringExpenseMovedEvent.set({ recurringId: this._id.value, from, to: groupId }));
  }

  get groupId(): string {
    return this.#groupId;
  }

  get paidBy(): string {
    return this.#paidBy;
  }

  get currency(): string {
    return this.#currency;
  }

  get description(): string {
    return this.#description.value;
  }

  get amount(): number {
    return this.#amount.value;
  }

  get startsOn(): string {
    return this.#startsOn.value;
  }

  get next(): string {
    return this.#next.value;
  }

  get split(): SplitRequest {
    return structuredClone(this.#split);
  }

  /** The payer and every member the split lists: the members a recurring expense cannot be recorded without. */
  private involvedMemberIds(): string[] {
    const listed =
      this.#split.kind === 'equal'
        ? this.#split.memberIds
        : this.#split.kind === 'exact'
          ? this.#split.amounts.map(share => share.memberId)
          : this.#split.shares.map(share => share.memberId);
    return [this.#paidBy, ...listed];
  }
}

/** What the background job does with a recurring expense on the day it is decided, as `settleDay` says. */
export type DayDecision =
  | { kind: 'waiting' }
  | { kind: 'ended'; recurring: RecurringExpense }
  | { kind: 'recorded'; recurring: RecurringExpense };

const SPLIT_KINDS: readonly string[] = ['equal', 'exact', 'shares'];
