import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import {
  ExpenseChanged,
  NotAGroupMember,
  NotAllowedToChangeExpense,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  ExpenseDeletedEvent,
  ExpenseEditedEvent,
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
    readonly date: ExpenseDate,
    readonly split: Split,
    readonly recordedAt: Date,
    private readonly removed: boolean = false,
  ) {
    super(id, version);
  }

  /** Who paid the expense. An edit never changes it. */
  get payer(): Id {
    return this.split.payer;
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
    groupId,
    description,
    amount,
    date,
    split,
    groupMembers,
    at,
  }: {
    groupId: Id;
    description: Description;
    amount: Amount;
    date: ExpenseDate;
    split: Split;
    groupMembers: readonly Id[];
    at: Date;
  }): IResult<Expense> {
    const outsider = split.memberIds.some(member => !groupMembers.some(current => current.equals(member)));
    if (outsider) return Result.fail(new NotAGroupMember());

    const expense = new Expense(Id.generate(), 0, groupId, description, amount, date, split, at);
    expense.record(
      ExpenseRecordedEvent.set({
        expenseId: expense._id.value,
        groupId: groupId.value,
        paidBy: split.payer.value,
        amount: amount.value,
        recordedAt: at.toISOString(),
      }),
    );
    return Result.ok(expense);
  }

  /**
   * Gives the expense again, whole, from the version its author read. Only its payer or the group's owner may
   * (`by`, `byOwner`); the payer stays as it was, and the edit refuses a version other than the one this expense was
   * read at (ExpenseChanged), and a split with a member who is not in the group now. Records ExpenseEdited.
   */
  edit({
    by,
    byOwner,
    fromVersion,
    description,
    amount,
    date,
    split,
    groupMembers,
    at,
  }: {
    by: Id;
    byOwner: boolean;
    fromVersion: number;
    description: Description;
    amount: Amount;
    date: ExpenseDate;
    split: Split;
    groupMembers: readonly Id[];
    at: Date;
  }): IResult<Expense> {
    if (!this.mayBeChangedBy(by, byOwner)) return Result.fail(new NotAllowedToChangeExpense());
    if (fromVersion !== this.version) return Result.fail(new ExpenseChanged());
    const outsider = split.memberIds.some(member => !groupMembers.some(current => current.equals(member)));
    if (outsider) return Result.fail(new NotAGroupMember());

    const edited = new Expense(this._id, this.version, this.groupId, description, amount, date, split, this.recordedAt);
    edited.record(
      ExpenseEditedEvent.set({
        expenseId: this._id.value,
        groupId: this.groupId.value,
        paidBy: split.payer.value,
        amount: amount.value,
        editedAt: at.toISOString(),
      }),
    );
    return Result.ok(edited);
  }

  /** Removes the expense. Only its payer or the group's owner may (`by`, `byOwner`). Records ExpenseDeleted. */
  delete({ by, byOwner, at }: { by: Id; byOwner: boolean; at: Date }): IResult<Expense> {
    if (!this.mayBeChangedBy(by, byOwner)) return Result.fail(new NotAllowedToChangeExpense());

    const deleted = new Expense(
      this._id,
      this.version,
      this.groupId,
      this.description,
      this.amount,
      this.date,
      this.split,
      this.recordedAt,
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
    const split = Split.fromSnapshot({ payer: snapshot.paidBy, shares: snapshot.shares, amount: snapshot.amount });
    return new Expense(
      new Id(snapshot.id),
      snapshot.version,
      new Id(snapshot.groupId),
      description.data,
      amount.data,
      date.data,
      split,
      recordedAt,
    );
  }

  toSnapshot(): ExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      description: this.description.value,
      amount: this.amount.value,
      date: this.date.value,
      paidBy: this.split.payer.value,
      shares: this.split.shares.map(share => ({ memberId: share.memberId.value, amount: share.amount })),
      recordedAt: this.recordedAt.toISOString(),
      version: this.version,
    };
  }
}
