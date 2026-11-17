import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import {
  ExpenseChanged,
  ExpenseConcernsAFormerMember,
  NotAMemberOfTheGroup,
  NotThePayerOrTheOwner,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import {
  ExpenseDeletedEvent,
  ExpenseEditedEvent,
  ExpenseRecordedEvent,
} from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { SpentOn } from '@Contexts/Ledger/Domain/Expense/SpentOn';
import { Share, Split, SplitInput, SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

/** What an expense says, once its description, amount, day and split have been checked and its shares computed. */
interface Decided {
  description: Description;
  amount: Amount;
  spentOn: SpentOn;
  splitKind: SplitKind;
  shares: Share[];
}

const SPLIT_KINDS: readonly SplitKind[] = ['equal', 'exact', 'shares'];

/**
 * An amount a member of a group paid, split between some of its members, the payer among them, equally, by exact amounts or
 * by shares. It holds what was decided: its amount, its day, the payer, how it was split and the shares, which add up to the
 * amount. It has a version: 1 when it is recorded, and one more at each save of a change (the aggregate's version, ADR 8).
 * The balances are read from its shares; no aggregate holds a running total.
 */
export class Expense extends AggregateRoot {
  private constructor(
    id: Id,
    readonly groupId: Id,
    readonly description: Description,
    readonly amount: Amount,
    readonly spentOn: SpentOn,
    readonly paidBy: Id,
    readonly splitKind: SplitKind,
    readonly shares: Share[],
    version: number,
  ) {
    super(id, version);
  }

  /**
   * Records an expense the payer paid, split as `split` says. `groupMembers` are the group's current members, read by the
   * handler: a split may hold only them, and the payer must be among them. `now` is the application's clock, read by the
   * handler: the day is checked against it, never a default.
   */
  static create({
    groupId,
    paidBy,
    description,
    amount,
    date,
    split,
    groupMembers,
    now,
  }: {
    groupId: Id;
    paidBy: Id;
    description: string;
    amount: number;
    date: string;
    split: SplitInput;
    groupMembers: Id[];
    now: Date;
  }): IResult<Expense> {
    const decided = Expense.decide({ paidBy, description, amount, date, split, groupMembers, now });
    if (decided.isFailure()) return decided;

    const { description: text, amount: value, spentOn, splitKind, shares } = decided.data;
    const expense = new Expense(Id.generate(), groupId, text, value, spentOn, paidBy, splitKind, shares, 0);
    expense.record(
      ExpenseRecordedEvent.set({
        expenseId: expense._id.value,
        groupId: groupId.value,
        splitKind,
        paidBy: paidBy.value,
        shares: shares.map(share => ({ memberId: share.memberId.value, amount: share.amount })),
      }),
    );
    return Result.ok(expense);
  }

  /**
   * Replaces the expense, whole, from the version its author read. Only its payer, or the owner of its group, may change
   * it (`byOwner` is the group's role of the caller, read by the handler). The payer stays the one who paid. An expense
   * whose payer or split members are no longer in `groupMembers` is refused: it concerns a member who has left (request 9).
   * The edit is refused when the expense has changed since `version` was read, and the new shares are computed from what the
   * edit gives. The returned expense keeps this version: the repository stores version + 1 when it saves it.
   */
  edit({
    by,
    byOwner,
    version,
    description,
    amount,
    date,
    split,
    groupMembers,
    now,
  }: {
    by: Id;
    byOwner: boolean;
    version: number;
    description: string;
    amount: number;
    date: string;
    split: SplitInput;
    groupMembers: Id[];
    now: Date;
  }): IResult<Expense> {
    if (!this.mayChange(by, byOwner)) return Result.fail(new NotThePayerOrTheOwner());
    if (this.concernsAFormerMember(groupMembers)) return Result.fail(new ExpenseConcernsAFormerMember());
    if (version !== this.version) return Result.fail(new ExpenseChanged());

    const decided = Expense.decide({
      paidBy: this.paidBy,
      description,
      amount,
      date,
      split,
      groupMembers,
      now,
    });
    if (decided.isFailure()) return decided;

    const { description: text, amount: value, spentOn, splitKind, shares } = decided.data;
    const edited = new Expense(
      this._id,
      this.groupId,
      text,
      value,
      spentOn,
      this.paidBy,
      splitKind,
      shares,
      this.version,
    );
    edited.record(ExpenseEditedEvent.set({ expenseId: this._id.value, groupId: this.groupId.value, splitKind }));
    return Result.ok(edited);
  }

  /**
   * Deletes the expense: it is gone from every read once the repository removes it. Only its payer or the owner may, and not
   * an expense that concerns a member who has left (`groupMembers` are the group's current members, read by the handler).
   */
  delete({ by, byOwner, groupMembers }: { by: Id; byOwner: boolean; groupMembers: Id[] }): IResult<Expense> {
    if (!this.mayChange(by, byOwner)) return Result.fail(new NotThePayerOrTheOwner());
    if (this.concernsAFormerMember(groupMembers)) return Result.fail(new ExpenseConcernsAFormerMember());

    this.record(ExpenseDeletedEvent.set({ expenseId: this._id.value, groupId: this.groupId.value }));
    return Result.ok(this);
  }

  static fromSnapshot(snapshot: ExpenseSnapshot): Expense {
    const text = Description.create(snapshot.description);
    const value = Amount.create(snapshot.amount);
    const day = SpentOn.create(snapshot.date, '9999-12-31');
    if (
      text.isFailure() ||
      value.isFailure() ||
      day.isFailure() ||
      !snapshot.shares.length ||
      !SPLIT_KINDS.includes(snapshot.splitKind)
    ) {
      throw new Error(`The expense ${snapshot.id} is corrupted`);
    }
    const split = Split.fromShares(
      snapshot.splitKind,
      snapshot.shares.map(share => ({ memberId: new Id(share.memberId), amount: share.amount })),
    );
    return new Expense(
      new Id(snapshot.id),
      new Id(snapshot.groupId),
      text.data,
      value.data,
      day.data,
      new Id(snapshot.paidBy),
      split.kind,
      split.shares,
      snapshot.version,
    );
  }

  /**
   * What this expense does to each member's balance: the payer is owed the whole amount, and each member of the split owes
   * their share, however it was split. The changes add up to 0 exactly, since the shares add up to the amount: this is the zero
   * sum, by construction.
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
      splitKind: this.splitKind,
      shares: this.shares.map(share => ({ memberId: share.memberId.value, amount: share.amount })),
      version: this.version,
    };
  }

  /** The payer, or the owner of the group, may change an expense; no one else. */
  private mayChange(by: Id, byOwner: boolean): boolean {
    return byOwner || by.value === this.paidBy.value;
  }

  /** Whether the payer or one of the split's members is no longer a member of the group (ADR 4). */
  private concernsAFormerMember(groupMembers: Id[]): boolean {
    const isCurrent = (memberId: Id) => groupMembers.some(member => member.value === memberId.value);
    return !isCurrent(this.paidBy) || this.shares.some(share => !isCurrent(share.memberId));
  }

  /** The rules of an expense's content, shared by recording and editing: the same refusals, the same computed shares. */
  private static decide({
    paidBy,
    description,
    amount,
    date,
    split,
    groupMembers,
    now,
  }: {
    paidBy: Id;
    description: string;
    amount: number;
    date: string;
    split: SplitInput;
    groupMembers: Id[];
    now: Date;
  }): IResult<Decided> {
    const text = Description.create(description);
    if (text.isFailure()) return text;
    const value = Amount.create(amount);
    if (value.isFailure()) return value;
    const day = SpentOn.create(date, now.toISOString().slice(0, 10));
    if (day.isFailure()) return day;
    const decidedSplit = Split.decide({ amount: value.data, payer: paidBy, input: split });
    if (decidedSplit.isFailure()) return decidedSplit;

    const isMember = (memberId: Id) => groupMembers.some(member => member.value === memberId.value);
    if (!isMember(paidBy) || !decidedSplit.data.shares.every(share => isMember(share.memberId))) {
      return Result.fail(new NotAMemberOfTheGroup());
    }
    return Result.ok({
      description: text.data,
      amount: value.data,
      spentOn: day.data,
      splitKind: decidedSplit.data.kind,
      shares: decidedSplit.data.shares,
    });
  }
}
