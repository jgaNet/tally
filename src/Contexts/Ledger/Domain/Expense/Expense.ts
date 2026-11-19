import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { AccountSuspended, GroupArchived } from '@SharedKernel/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import {
  ExpenseChanged,
  FormerMemberInExpense,
  NotAGroupMember,
  NotAllowedToChangeExpense,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  ExpenseDeletedEvent,
  ExpenseEditedEvent,
  ExpenseMovedEvent,
  ExpenseRecordedEvent,
} from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';

/**
 * An expense of a group: an amount its payer paid for some members of the group, with its split. It is made by
 * `create()`, which checks that everyone in the split is a member of the group now (the members come from Groups,
 * through the port the caller asks), and records the fact. It may then be changed whole by `edit()`, from the version
 * its author read, or removed by `delete()`; only its payer or the owner of its group may do either, and the payer never
 * changes. An `edit()` or `delete()` answers a new instance at the version this one was read at: the repository stores it
 * at version + 1, and refuses it when the stored version is no longer that one.
 */
export class Expense extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly groupId: Id,
    readonly description: Description,
    readonly amount: Amount,
    /** What it was paid in, when it was not paid in the group's currency (request 21); `amount` is then its amount in the group's. */
    readonly original: OriginalAmount | null,
    readonly date: ExpenseDate,
    readonly split: Split,
    readonly recordedAt: Date,
    /** What the expense is filed under (request 24): `other` when none was given. */
    readonly category: Category = 'other',
    private readonly removed: boolean = false,
    private readonly relocated: boolean = false,
  ) {
    super(id, version);
  }

  /** Who paid the expense. An edit never changes it. */
  get payer(): Id {
    return this.split.payer;
  }

  /** Whether the expense moved to another group by a merge (request 31): its repository changes its group, and nothing else. */
  get isMoved(): boolean {
    return this.relocated;
  }

  /** Whether the expense was deleted: a deleted expense is gone from every read, and its repository forgets it. */
  get isDeleted(): boolean {
    return this.removed;
  }

  /**
   * Records an expense. The payer is the split's payer, and every member of the split (the payer included) must be
   * one of `groupMembers`: the members of the group as they are now. Records ExpenseRecorded.
   */
  static create({
    id = Id.generate(),
    groupId,
    description,
    amount,
    original = null,
    category = 'other',
    date,
    split,
    groupMembers,
    groupArchived = false,
    callerSuspended = false,
    at,
  }: {
    /** The identity the expense is given, when a recurring expense's day already gave one (request 23, ADR 16); generated otherwise. */
    id?: Id;
    groupId: Id;
    description: Description;
    amount: Amount;
    original?: OriginalAmount | null;
    category?: Category;
    date: ExpenseDate;
    split: Split;
    groupMembers: readonly Id[];
    /**
     * Whether the group is archived (request 27). Defaults to false only for the recurring expense's day, which the
     * background job has already asked before it reaches here; every command passes what Groups answered.
     */
    groupArchived?: boolean;
    /** Whether the account that starts it is suspended (request 34): an expense it starts is refused by AccountSuspended. */
    callerSuspended?: boolean;
    at: Date;
  }): IResult<Expense> {
    if (groupArchived) return Result.fail(new GroupArchived());
    if (callerSuspended) return Result.fail(new AccountSuspended());
    const outsider = split.memberIds.some(member => !groupMembers.some(current => current.equals(member)));
    if (outsider) return Result.fail(new NotAGroupMember());

    const expense = new Expense(id, 0, groupId, description, amount, original, date, split, at, category);
    expense.record(
      ExpenseRecordedEvent.set({
        expenseId: expense._id.value,
        groupId: groupId.value,
        paidBy: split.payer.value,
        amount: amount.value,
        splitKind: split.kind,
        shares: split.shares.map(share => ({ memberId: share.memberId.value, amount: share.amount })),
        recordedAt: at.toISOString(),
      }),
    );
    return Result.ok(expense);
  }

  /**
   * Gives the expense again, whole, from the version its author read. Only its payer or the group's owner may
   * (`by`, `byOwner`); the payer stays as it was, and the edit refuses a version other than the one this expense was
   * read at (ExpenseChanged), a split with a member who is not in the group now, and an expense that concerns a member
   * who has left (FormerMemberInExpense), so that the balances of the group stay as they were. Records ExpenseEdited.
   */
  edit({
    by,
    byOwner,
    fromVersion,
    description,
    amount,
    original = null,
    category = 'other',
    date,
    split,
    groupMembers,
    groupArchived,
    at,
  }: {
    by: Id;
    byOwner: boolean;
    fromVersion: number;
    description: Description;
    amount: Amount;
    original?: OriginalAmount | null;
    category?: Category;
    date: ExpenseDate;
    split: Split;
    groupMembers: readonly Id[];
    groupArchived: boolean;
    at: Date;
  }): IResult<Expense> {
    if (groupArchived) return Result.fail(new GroupArchived());
    if (!this.mayBeChangedBy(by, byOwner)) return Result.fail(new NotAllowedToChangeExpense());
    if (fromVersion !== this.version) return Result.fail(new ExpenseChanged());
    if (this.concernsFormerMember(groupMembers)) return Result.fail(new FormerMemberInExpense());
    const outsider = split.memberIds.some(member => !groupMembers.some(current => current.equals(member)));
    if (outsider) return Result.fail(new NotAGroupMember());

    const edited = new Expense(
      this._id,
      this.version,
      this.groupId,
      description,
      amount,
      original,
      date,
      split,
      this.recordedAt,
      category,
    );
    edited.record(
      ExpenseEditedEvent.set({
        expenseId: this._id.value,
        groupId: this.groupId.value,
        paidBy: split.payer.value,
        amount: amount.value,
        splitKind: split.kind,
        editedAt: at.toISOString(),
      }),
    );
    return Result.ok(edited);
  }

  /**
   * Removes the expense. Only its payer or the group's owner may (`by`, `byOwner`), and not an expense that concerns a
   * member who has left (`groupMembers`, the members now). Records ExpenseDeleted.
   */
  delete({
    by,
    byOwner,
    groupMembers,
    groupArchived,
    at,
  }: {
    by: Id;
    byOwner: boolean;
    groupMembers: readonly Id[];
    groupArchived: boolean;
    at: Date;
  }): IResult<Expense> {
    if (groupArchived) return Result.fail(new GroupArchived());
    if (!this.mayBeChangedBy(by, byOwner)) return Result.fail(new NotAllowedToChangeExpense());
    if (this.concernsFormerMember(groupMembers)) return Result.fail(new FormerMemberInExpense());

    const deleted = new Expense(
      this._id,
      this.version,
      this.groupId,
      this.description,
      this.amount,
      this.original,
      this.date,
      this.split,
      this.recordedAt,
      this.category,
      true,
    );
    deleted.record(
      ExpenseDeletedEvent.set({
        expenseId: this._id.value,
        groupId: this.groupId.value,
        deletedAt: at.toISOString(),
      }),
    );
    return Result.ok(deleted);
  }

  /**
   * Moves the expense to the group its group was merged into (request 31, ADR 23): it keeps its id, its payer, its shares, its
   * version and its category, and only its group changes; the members of its split are members of the group kept, or former
   * members of it, as the merge made them. Records ExpenseMoved.
   */
  moveTo(groupId: Id, at: Date): Expense {
    const moved = new Expense(
      this._id,
      this.version,
      groupId,
      this.description,
      this.amount,
      this.original,
      this.date,
      this.split,
      this.recordedAt,
      this.category,
      false,
      true,
    );
    moved.record(
      ExpenseMovedEvent.set({
        expenseId: this._id.value,
        groupId: groupId.value,
        fromGroupId: this.groupId.value,
        movedAt: at.toISOString(),
      }),
    );
    return moved;
  }

  /** Whether the payer or a member of the split is no longer a member of the group. */
  private concernsFormerMember(groupMembers: readonly Id[]): boolean {
    return this.split.memberIds.some(member => !groupMembers.some(current => current.equals(member)));
  }

  private mayBeChangedBy(by: Id, byOwner: boolean): boolean {
    return byOwner || this.split.payer.equals(by);
  }

  /** Reconstitutes a stored expense. It records nothing, and refuses corrupted data by throwing. */
  static fromSnapshot(snapshot: ExpenseSnapshot): Expense {
    const description = Description.create(snapshot.description);
    const amount = Amount.create(snapshot.amount);
    const date = ExpenseDate.parse(snapshot.date);
    const recordedAt = new Date(snapshot.recordedAt);
    if (
      description.isFailure() ||
      amount.isFailure() ||
      date.isFailure() ||
      !snapshot.id ||
      !snapshot.groupId ||
      Number.isNaN(recordedAt.getTime())
    ) {
      throw new Error(`Corrupted expense ${snapshot.id}`);
    }
    const split = Split.fromSnapshot({
      kind: snapshot.splitKind,
      payer: snapshot.paidBy,
      shares: snapshot.shares,
      amount: snapshot.amount,
    });
    return new Expense(
      new Id(snapshot.id),
      snapshot.version,
      new Id(snapshot.groupId),
      description.data,
      amount.data,
      snapshot.original ? OriginalAmount.fromSnapshot(snapshot.original) : null,
      date.data,
      split,
      recordedAt,
      snapshot.category,
    );
  }

  toSnapshot(): ExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      description: this.description.value,
      amount: this.amount.value,
      original: this.original
        ? { currency: this.original.currency, amount: this.original.amount, rate: this.original.rate }
        : null,
      date: this.date.value,
      paidBy: this.split.payer.value,
      splitKind: this.split.kind,
      shares: this.split.shares.map(share => ({ memberId: share.memberId.value, amount: share.amount })),
      recordedAt: this.recordedAt.toISOString(),
      category: this.category,
      version: this.version,
    };
  }
}
