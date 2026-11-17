import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { NotAGroupMember } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';

/**
 * An expense of a group: an amount its payer paid for some members of the group, with its split, kept as it was
 * recorded. It is made by `create()`, which checks that everyone in the split is a member of the group now (the
 * members come from Groups, through the port the caller asks), and records the fact. Nothing here changes it afterwards.
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
  ) {
    super(id, version);
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
