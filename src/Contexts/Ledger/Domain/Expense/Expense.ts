import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { NotAMemberOfTheGroup } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { SpentOn } from '@Contexts/Ledger/Domain/Expense/SpentOn';
import { Share, Split } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * An amount a member of a group paid, split equally between some of its members, the payer among them. It holds what
 * was decided: its amount, its day, the payer and the shares, which add up to the amount. Once recorded it is not
 * changed: the balances are read from it, and no aggregate holds a running total.
 */
export class Expense extends AggregateRoot {
  private constructor(
    id: Id,
    readonly groupId: Id,
    readonly description: Description,
    readonly amount: Amount,
    readonly spentOn: SpentOn,
    readonly paidBy: Id,
    readonly shares: Share[],
  ) {
    super(id);
  }

  /**
   * Records an expense the payer paid, split equally between `splitBetween`. `groupMembers` are the group's current
   * members, read by the handler: a split may hold only them, and the payer must be among them. `now` is the
   * application's clock, read by the handler: the day is checked against it, never a default.
   */
  static create({
    groupId,
    paidBy,
    description,
    amount,
    date,
    splitBetween,
    groupMembers,
    now,
  }: {
    groupId: Id;
    paidBy: Id;
    description: string;
    amount: number;
    date: string;
    splitBetween: Id[];
    groupMembers: Id[];
    now: Date;
  }): IResult<Expense> {
    const text = Description.create(description);
    if (text.isFailure()) return text;
    const value = Amount.create(amount);
    if (value.isFailure()) return value;
    const day = SpentOn.create(date, now.toISOString().slice(0, 10));
    if (day.isFailure()) return day;
    const split = Split.equally({ amount: value.data, payer: paidBy, members: splitBetween });
    if (split.isFailure()) return split;

    const isMember = (memberId: Id) => groupMembers.some(member => member.value === memberId.value);
    if (!isMember(paidBy) || !split.data.shares.every(share => isMember(share.memberId))) {
      return Result.fail(new NotAMemberOfTheGroup());
    }

    const expense = new Expense(Id.generate(), groupId, text.data, value.data, day.data, paidBy, split.data.shares);
    expense.record(ExpenseRecordedEvent.set({ expenseId: expense._id.value, groupId: groupId.value }));
    return Result.ok(expense);
  }

  static fromSnapshot(snapshot: ExpenseSnapshot): Expense {
    const text = Description.create(snapshot.description);
    const value = Amount.create(snapshot.amount);
    const day = SpentOn.create(snapshot.date, '9999-12-31');
    if (text.isFailure() || value.isFailure() || day.isFailure() || !snapshot.shares.length) {
      throw new Error(`The expense ${snapshot.id} is corrupted`);
    }
    const split = Split.fromShares(
      snapshot.shares.map(share => ({ memberId: new Id(share.memberId), amount: share.amount })),
    );
    return new Expense(
      new Id(snapshot.id),
      new Id(snapshot.groupId),
      text.data,
      value.data,
      day.data,
      new Id(snapshot.paidBy),
      split.shares,
    );
  }

  /**
   * What this expense does to each member's balance: the payer is owed the whole amount, and each member of the split owes
   * their share. The changes add up to 0 exactly, since the shares add up to the amount: this is the zero sum, by construction.
   */
  balanceChanges(): { memberId: Id; change: number }[] {
    const changes = new Map<string, { memberId: Id; change: number }>();
    const add = (memberId: Id, change: number) => {
      const entry = changes.get(memberId.value) ?? { memberId, change: 0 };
      entry.change += change;
      changes.set(memberId.value, entry);
    };
    add(this.paidBy, this.amount.value);
    for (const share of this.shares) add(share.memberId, -share.amount);
    return [...changes.values()];
  }

  toSnapshot(): ExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      description: this.description.value,
      amount: this.amount.value,
      date: this.spentOn.value,
      paidBy: this.paidBy.value,
      shares: this.shares.map(share => ({ memberId: share.memberId.value, amount: share.amount })),
    };
  }
}
