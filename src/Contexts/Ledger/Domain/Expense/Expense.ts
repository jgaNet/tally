import { AccountDeleted, AccountSuspended, GroupArchived } from '@SharedKernel/Domain';
import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { CurrencyCode } from '@SharedKernel/Domain/Currency';

import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
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
  ExpenseMovedEvent,
} from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { MoneyInput, OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';
import { SpentOn } from '@Contexts/Ledger/Domain/Expense/SpentOn';
import { Share, Split, SplitInput, SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

/** What an expense says, once its description, money, day and split have been checked and its shares computed. */
interface Decided {
  description: Description;
  amount: Amount;
  category: Category;
  original: OriginalAmount | null;
  spentOn: SpentOn;
  splitKind: SplitKind;
  shares: Share[];
}

const SPLIT_KINDS: readonly SplitKind[] = ['equal', 'exact', 'shares'];

/**
 * An amount a member of a group paid, split between some of its members, the payer among them, equally, by exact amounts or
 * by shares. It holds what was decided: its amount in the group's currency, its day, the payer, how it was split and the
 * shares, which add up to the amount. An expense paid in another currency also keeps what was paid, its original amount in
 * that currency and its rate (request 21); its `amount` is then that original converted. It has a version: 1 when it is
 * recorded, and one more at each save of a change (the aggregate's version, ADR 8). The balances are read from its shares;
 * no aggregate holds a running total.
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
    readonly original: OriginalAmount | null,
    readonly category: Category,
    version: number,
  ) {
    super(id, version);
  }

  /**
   * Records an expense the payer paid, split as `split` says. `money` is its amount in the group's currency, or what was paid
   * in another currency (converted here). `groupMembers` are the group's current members, read by the handler: a split may
   * hold only them, and the payer must be among them. `groupCurrency` is the group's currency, read by the handler. `now` is
   * the application's clock, read by the handler: the day is checked against it, never a default.
   */
  static create({
    id,
    groupId,
    paidBy,
    description,
    money,
    date,
    split,
    category,
    groupMembers,
    groupCurrency,
    offer,
    archived,
    suspended,
    deleted,
    now,
  }: {
    /** The id the expense is born with: given when a recurring expense's day already named it (ADR 14); otherwise generated. */
    id?: Id;
    groupId: Id;
    paidBy: Id;
    description: string;
    money: MoneyInput;
    date: string;
    split: SplitInput;
    /** What it is for, one of the eight categories; `other` when none is given (request 24). */
    category?: string;
    groupMembers: Id[];
    groupCurrency: CurrencyCode;
    /** The rates service's answer for what was paid, read by the handler when the money is in another currency (request 22). */
    offer: RateOffer | null;
    /** Whether the group is archived, read by the handler: an archived group takes no expense (request 27). */
    archived: boolean;
    /** Whether the account that records it is suspended, read by the handler: a suspended account records no expense (request 34). */
    suspended: boolean;
    /** The accounts among the group's members that their person deleted, read by the handler: none of them may be in the split of a new expense (request 35). */
    deleted: Id[];
    now: Date;
  }): IResult<Expense> {
    if (archived) return Result.fail(new GroupArchived('Ledger'));
    if (suspended) return Result.fail(new AccountSuspended('Ledger'));
    const decided = Expense.decide({
      paidBy,
      description,
      money,
      date,
      split,
      category,
      groupMembers,
      groupCurrency,
      offer,
      now,
    });
    if (decided.isFailure()) return decided;
    if (decided.data.shares.some(share => deleted.some(account => account.value === share.memberId.value))) {
      return Result.fail(new AccountDeleted('Ledger'));
    }

    const { description: text, amount: value, original, spentOn, splitKind, shares, category: kind } = decided.data;
    const expense = new Expense(
      id ?? Id.generate(),
      groupId,
      text,
      value,
      spentOn,
      paidBy,
      splitKind,
      shares,
      original,
      kind,
      0,
    );
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
   * edit gives. An edit with an amount is in the group's currency; one with what was paid in another currency is in that
   * currency, at its rate. The returned expense keeps this version: the repository stores version + 1 when it saves it.
   */
  edit({
    by,
    byOwner,
    archived,
    version,
    description,
    money,
    date,
    split,
    category,
    groupMembers,
    groupCurrency,
    offer,
    now,
  }: {
    by: Id;
    byOwner: boolean;
    /** Whether the group is archived, read by the handler (request 27). */
    archived: boolean;
    version: number;
    description: string;
    money: MoneyInput;
    date: string;
    split: SplitInput;
    category?: string;
    groupMembers: Id[];
    groupCurrency: CurrencyCode;
    offer: RateOffer | null;
    now: Date;
  }): IResult<Expense> {
    if (archived) return Result.fail(new GroupArchived('Ledger'));
    if (!this.mayChange(by, byOwner)) return Result.fail(new NotThePayerOrTheOwner());
    if (this.concernsAFormerMember(groupMembers)) return Result.fail(new ExpenseConcernsAFormerMember());
    if (version !== this.version) return Result.fail(new ExpenseChanged());

    const decided = Expense.decide({
      paidBy: this.paidBy,
      description,
      money,
      date,
      split,
      category,
      groupMembers,
      groupCurrency,
      offer,
      now,
    });
    if (decided.isFailure()) return decided;

    const { description: text, amount: value, original, spentOn, splitKind, shares, category: kind } = decided.data;
    const edited = new Expense(
      this._id,
      this.groupId,
      text,
      value,
      spentOn,
      this.paidBy,
      splitKind,
      shares,
      original,
      kind,
      this.version,
    );
    edited.record(ExpenseEditedEvent.set({ expenseId: this._id.value, groupId: this.groupId.value, splitKind }));
    return Result.ok(edited);
  }

  /**
   * Deletes the expense: it is gone from every read once the repository removes it. Only its payer or the owner may, and not
   * an expense that concerns a member who has left (`groupMembers` are the group's current members, read by the handler).
   */
  delete({
    by,
    byOwner,
    groupMembers,
    archived,
  }: {
    by: Id;
    byOwner: boolean;
    groupMembers: Id[];
    archived: boolean;
  }): IResult<Expense> {
    if (archived) return Result.fail(new GroupArchived('Ledger'));
    if (!this.mayChange(by, byOwner)) return Result.fail(new NotThePayerOrTheOwner());
    if (this.concernsAFormerMember(groupMembers)) return Result.fail(new ExpenseConcernsAFormerMember());

    this.record(ExpenseDeletedEvent.set({ expenseId: this._id.value, groupId: this.groupId.value }));
    return Result.ok(this);
  }

  static fromSnapshot(snapshot: ExpenseSnapshot): Expense {
    const text = Description.create(snapshot.description);
    const value = Amount.create(snapshot.amount);
    const day = SpentOn.create(snapshot.date, '9999-12-31');
    const original = snapshot.original ? OriginalAmount.restore(snapshot.original) : null;
    const kind = Category.restore(snapshot.category);
    if (
      text.isFailure() ||
      value.isFailure() ||
      day.isFailure() ||
      !snapshot.shares.length ||
      !SPLIT_KINDS.includes(snapshot.splitKind) ||
      (snapshot.original && !original)
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
      original,
      kind,
      snapshot.version,
    );
  }

  /**
   * What this expense does to each member's balance: the payer is owed the whole amount, and each member of the split owes
   * their share, however it was split. The changes add up to 0 exactly, since the shares add up to the amount: this is the zero
   * sum, by construction.
   */
  /**
   * The expense moves to another group, when its group is merged into it (request 31): it keeps its payer, its shares, its version and
   * its category, and says so as ExpenseMoved. The aggregate it returns is the one the move is saved as.
   */
  moveTo(groupId: Id): Expense {
    const moved = Expense.fromSnapshot({ ...this.toSnapshot(), groupId: groupId.value });
    moved.record(
      ExpenseMovedEvent.set({ expenseId: this._id.value, fromGroupId: this.groupId.value, toGroupId: groupId.value }),
    );
    return moved;
  }

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
      original: this.original
        ? {
            currency: this.original.value.currency,
            amount: this.original.value.amount,
            rate: this.original.value.rate,
            rateSource: this.original.value.rateSource,
          }
        : null,
      category: this.category.value,
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

  /**
   * The rules of an expense's content, shared by recording and editing: the same refusals, the same computed shares. What was
   * paid in another currency is converted to the group's currency here, once, and the converted amount is refused like any
   * amount when it is out of range.
   */
  private static decide({
    paidBy,
    description,
    money,
    date,
    split,
    category,
    groupMembers,
    groupCurrency,
    offer,
    now,
  }: {
    paidBy: Id;
    description: string;
    money: MoneyInput;
    date: string;
    split: SplitInput;
    category?: string;
    groupMembers: Id[];
    groupCurrency: CurrencyCode;
    offer: RateOffer | null;
    now: Date;
  }): IResult<Decided> {
    const text = Description.create(description);
    if (text.isFailure()) return text;

    // The day is checked before the money, so a bad day is refused as a bad day, whatever the rate.
    const day = SpentOn.create(date, now.toISOString().slice(0, 10));
    if (day.isFailure()) return day;
    const kind = Category.create(category);
    if (kind.isFailure()) return kind;

    let value: Amount;
    let original: OriginalAmount | null = null;
    if ('original' in money) {
      const paid = OriginalAmount.create(money.original, groupCurrency, offer);
      if (paid.isFailure()) return paid;
      original = paid.data;
      const converted = Amount.create(paid.data.groupAmount(groupCurrency));
      if (converted.isFailure()) return converted;
      value = converted.data;
    } else {
      const amount = Amount.create(money.amount);
      if (amount.isFailure()) return amount;
      value = amount.data;
    }
    const decidedSplit = Split.decide({ amount: value, payer: paidBy, input: split });
    if (decidedSplit.isFailure()) return decidedSplit;

    const isMember = (memberId: Id) => groupMembers.some(member => member.value === memberId.value);
    if (!isMember(paidBy) || !decidedSplit.data.shares.every(share => isMember(share.memberId))) {
      return Result.fail(new NotAMemberOfTheGroup());
    }
    return Result.ok({
      description: text.data,
      amount: value,
      category: kind.data,
      original,
      spentOn: day.data,
      splitKind: decidedSplit.data.kind,
      shares: decidedSplit.data.shares,
    });
  }
}
