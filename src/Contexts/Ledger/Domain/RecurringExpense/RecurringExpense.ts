import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { GroupArchived } from '@SharedKernel/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { SplitKind, SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { NotAGroupMember } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';
import { NotAllowedToStopRecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExceptions';
import { nextMonthDay, StartsOn } from '@Contexts/Ledger/Domain/RecurringExpense/StartsOn';
import {
  RecurringExpenseDayCameEvent,
  RecurringExpenseEndedEvent,
  RecurringExpenseSetUpEvent,
  RecurringExpenseMovedEvent,
  RecurringExpenseStoppedEvent,
} from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';

/** One member of the split as it is stored: the amount or the shares it was given with, null for an equal split (it has none). */
export interface RecurringMemberSnapshot {
  memberId: string;
  given: number | null;
}

/** A recurring expense as it is stored and reconstituted: plain values, its version included. */
export interface RecurringSnapshot {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  splitKind: SplitKind;
  members: RecurringMemberSnapshot[];
  /** What each of its expenses is filed under (request 24). */
  category: Category;
  setUpAt: string;
  version: number;
}

/**
 * An expense its payer pays every month (request 23): a description, an amount in the group's currency, the split it was
 * given with (kept as given: the members of an equal split, the exact amounts, or the shares), the day of its first month,
 * and `next`, the day of the next expense it records. It is made by `setUp()`, which checks that everyone in the split is a
 * member of the group, and stopped by `stop()`, by its payer or the owner of its group.
 *
 * `recordDay()` is what the background job asks when `next` has come: the day's expense is made with an identity this
 * aggregate gives it, carried by RecurringExpenseDayCame, and `next` moves to the same day of the next month. When a member
 * of the split, or its payer, is no longer a member of the group, the day records nothing and the recurring expense ends:
 * it is removed, as if it had been stopped. An operation answers a new instance at the version this one was read at: the
 * repository stores it at version + 1, and refuses it when the stored version is no longer that one.
 */
export class RecurringExpense extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly groupId: Id,
    readonly description: Description,
    readonly amount: Amount,
    readonly startsOn: string,
    readonly next: string,
    readonly payer: Id,
    /** The split as it was given: exactly one of the three forms. */
    readonly givenSplit: SplitRequest,
    /** What each of its expenses is filed under (request 24). */
    readonly category: Category,
    readonly setUpAt: Date,
    private readonly removed: boolean = false,
  ) {
    super(id, version);
  }

  /** Whether it was stopped or ended: a removed recurring expense is gone from every read, and its repository forgets it. */
  get isRemoved(): boolean {
    return this.removed;
  }

  /** Whether its next day has come by `day` (a `YYYY-MM-DD`), so that the background job records it. */
  isDue(day: string): boolean {
    return !this.removed && this.next <= day;
  }

  /**
   * Sets up a recurring expense of `payer` in `groupId`, from what the command gave: the description, the amount in the
   * group's currency, the day of its first month (`startsOn`, a day from the 1st to the 28th, within a year of `at`), and
   * its split, which is checked as an expense's is (the members listed once, the payer among them, the exact amounts
   * adding up). Every member of the split must be one of `groupMembers`, the members of the group now. Records
   * RecurringExpenseSetUp.
   */
  static setUp({
    groupId,
    payer,
    description,
    amount,
    startsOn,
    category = 'other',
    request,
    groupMembers,
    groupArchived,
    at,
  }: {
    groupId: Id;
    payer: Id;
    description: string;
    amount: number;
    startsOn: string;
    category?: Category;
    request: SplitRequest;
    groupMembers: readonly Id[];
    groupArchived: boolean;
    at: Date;
  }): IResult<RecurringExpense> {
    if (groupArchived) return Result.fail(new GroupArchived());
    const described = Description.create(description);
    if (described.isFailure()) return described;
    const paid = Amount.create(amount);
    if (paid.isFailure()) return paid;
    const day = StartsOn.create(startsOn, at);
    if (day.isFailure()) return day;
    const split = Split.fromRequest({ amount: paid.data, payer, request });
    if (split.isFailure()) return split;
    const givenSplit = givenSplitOf(request);
    const outsider = membersOf(givenSplit).some(member => !groupMembers.some(current => current.value === member));
    if (outsider) return Result.fail(new NotAGroupMember());

    const recurring = new RecurringExpense(
      Id.generate(),
      0,
      groupId,
      described.data,
      paid.data,
      day.data.value,
      day.data.value,
      payer,
      givenSplit,
      category,
      at,
    );
    recurring.record(
      RecurringExpenseSetUpEvent.set({
        recurringId: recurring._id.value,
        groupId: groupId.value,
        paidBy: payer.value,
        startsOn: day.data.value,
        setUpAt: at.toISOString(),
      }),
    );
    return Result.ok(recurring);
  }

  /**
   * The day `next` has come: it is recorded with the members of the group now. When the payer or a member of the split has
   * left, the recurring expense ends and no expense is recorded for the day (RecurringExpenseEnded); otherwise the day's
   * expense is given its identity (`expenseId`), and `next` moves to the same day of the next month (RecurringExpenseDayCame).
   */
  recordDay({ groupMembers, at }: { groupMembers: readonly Id[]; at: Date }): {
    recurring: RecurringExpense;
    expenseId: Id | null;
  } {
    const concernsFormerMember = membersOf(this.givenSplit).some(
      member => !groupMembers.some(current => current.value === member),
    );
    if (concernsFormerMember) {
      const ended = this.moved({ removed: true });
      ended.record(
        RecurringExpenseEndedEvent.set({
          recurringId: this._id.value,
          groupId: this.groupId.value,
          endedAt: at.toISOString(),
        }),
      );
      return { recurring: ended, expenseId: null };
    }

    const expenseId = Id.generate();
    const moved = this.moved({ next: nextMonthDay(this.next) });
    moved.record(
      RecurringExpenseDayCameEvent.set({
        recurringId: this._id.value,
        expenseId: expenseId.value,
        groupId: this.groupId.value,
        paidBy: this.payer.value,
        description: this.description.value,
        amount: this.amount.value,
        day: this.next,
        splitRequest: this.givenSplit,
        category: this.category,
        cameAt: at.toISOString(),
      }),
    );
    return { recurring: moved, expenseId };
  }

  /** Stops it: only its payer or the owner of its group may (`by`, `byOwner`). Records RecurringExpenseStopped. */
  stop({
    by,
    byOwner,
    groupArchived,
    at,
  }: {
    by: Id;
    byOwner: boolean;
    groupArchived: boolean;
    at: Date;
  }): IResult<RecurringExpense> {
    if (groupArchived) return Result.fail(new GroupArchived());
    if (!byOwner && !this.payer.equals(by)) return Result.fail(new NotAllowedToStopRecurringExpense());
    const stopped = this.moved({ removed: true });
    stopped.record(
      RecurringExpenseStoppedEvent.set({
        recurringId: this._id.value,
        groupId: this.groupId.value,
        stoppedAt: at.toISOString(),
      }),
    );
    return Result.ok(stopped);
  }

  /**
   * Moves it to the group its group was merged into (request 31, ADR 23): it keeps its id, its payer, its split, its days and
   * its category; only its group changes. Records RecurringExpenseMoved.
   */
  moveTo(groupId: Id, at: Date): RecurringExpense {
    const moved = this.moved({ groupId });
    moved.record(
      RecurringExpenseMovedEvent.set({
        recurringId: this._id.value,
        groupId: groupId.value,
        fromGroupId: this.groupId.value,
        movedAt: at.toISOString(),
      }),
    );
    return moved;
  }

  /** The same recurring expense at its version, with what changed. It records nothing. */
  private moved({
    next = this.next,
    removed = this.removed,
    groupId = this.groupId,
  }: {
    next?: string;
    removed?: boolean;
    groupId?: Id;
  }): RecurringExpense {
    return new RecurringExpense(
      this._id,
      this.version,
      groupId,
      this.description,
      this.amount,
      this.startsOn,
      next,
      this.payer,
      this.givenSplit,
      this.category,
      this.setUpAt,
      removed,
    );
  }

  /** Reconstitutes a stored recurring expense. It records nothing, and refuses corrupted data by throwing. */
  static fromSnapshot(snapshot: RecurringSnapshot): RecurringExpense {
    const description = Description.create(snapshot.description);
    const amount = Amount.create(snapshot.amount);
    const startsOn = ExpenseDate.parse(snapshot.startsOn);
    const next = ExpenseDate.parse(snapshot.next);
    const setUpAt = new Date(snapshot.setUpAt);
    if (
      description.isFailure() ||
      amount.isFailure() ||
      startsOn.isFailure() ||
      next.isFailure() ||
      !snapshot.id ||
      !snapshot.groupId ||
      Number.isNaN(setUpAt.getTime()) ||
      !snapshot.members.some(member => member.memberId === snapshot.paidBy)
    ) {
      throw new Error(`Corrupted recurring expense ${snapshot.id}`);
    }
    return new RecurringExpense(
      new Id(snapshot.id),
      snapshot.version,
      new Id(snapshot.groupId),
      description.data,
      amount.data,
      snapshot.startsOn,
      snapshot.next,
      new Id(snapshot.paidBy),
      requestOf(snapshot.splitKind, snapshot.members),
      snapshot.category,
      setUpAt,
    );
  }

  toSnapshot(): RecurringSnapshot {
    const { kind, members } = snapshotOf(this.givenSplit);
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      paidBy: this.payer.value,
      description: this.description.value,
      amount: this.amount.value,
      startsOn: this.startsOn,
      next: this.next,
      splitKind: kind,
      members,
      category: this.category,
      setUpAt: this.setUpAt.toISOString(),
      version: this.version,
    };
  }
}

/** The split as a command gives it, reduced to the one of its three forms that is given (the others are absent). */
export function givenSplitOf(request: SplitRequest): SplitRequest {
  if (request.splitBetween !== undefined) return { splitBetween: [...request.splitBetween] };
  if (request.splitExactly !== undefined) {
    return { splitExactly: request.splitExactly.map(share => ({ memberId: share.memberId, amount: share.amount })) };
  }
  return {
    splitByShares: (request.splitByShares ?? []).map(share => ({ memberId: share.memberId, shares: share.shares })),
  };
}

/** The members a split names, in the order given. */
function membersOf(given: SplitRequest): string[] {
  if (given.splitBetween !== undefined) return [...given.splitBetween];
  if (given.splitExactly !== undefined) return given.splitExactly.map(share => share.memberId);
  return (given.splitByShares ?? []).map(share => share.memberId);
}

function snapshotOf(given: SplitRequest): { kind: SplitKind; members: RecurringMemberSnapshot[] } {
  if (given.splitBetween !== undefined) {
    return { kind: 'equal', members: given.splitBetween.map(memberId => ({ memberId, given: null })) };
  }
  if (given.splitExactly !== undefined) {
    return {
      kind: 'exact',
      members: given.splitExactly.map(share => ({ memberId: share.memberId, given: share.amount })),
    };
  }
  return {
    kind: 'shares',
    members: (given.splitByShares ?? []).map(share => ({ memberId: share.memberId, given: share.shares })),
  };
}

function requestOf(kind: SplitKind, members: RecurringMemberSnapshot[]): SplitRequest {
  if (kind === 'equal') return { splitBetween: members.map(member => member.memberId) };
  if (kind === 'exact') {
    return { splitExactly: members.map(member => ({ memberId: member.memberId, amount: member.given ?? 0 })) };
  }
  return { splitByShares: members.map(member => ({ memberId: member.memberId, shares: member.given ?? 0 })) };
}
