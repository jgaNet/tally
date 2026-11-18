import { AggregateRoot, IResult, Id, NotAllowedException, Result } from '@Architecture/Domain';

import { IExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import {
  Category,
  DEFAULT_CATEGORY,
  InvalidCategoryException,
  isCategory,
} from '@Contexts/Ledger/Domain/Expense/Category';
import { ExpenseAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { ExpenseDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseDescription';
import {
  ExpenseChangedException,
  ExpenseOfFormerMemberException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import {
  ExpenseDeletedEvent,
  ExpenseEditedEvent,
  ExpenseMovedEvent,
  ExpenseRecordedEvent,
} from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ExpenseMoney, OriginalAmount } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';
import { ExpenseShare, Split, SplitKind, SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';
import { recordAudit, AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/**
 * Expense is the aggregate root of one expense: what a member paid for some members of a group, split equally, by exact
 * amounts, or by shares. It keeps that its shares add up to its amount, since they are computed by Split, here, from what
 * was given, and kept as they were decided, with the kind of split they came from. The split is refused when it lists
 * someone who is not a current member of the group, lists someone twice, or leaves out the payer; the current members,
 * with their roles, are asked of Groups by the handler and given here.
 *
 * The amount is either given in the group's currency, or as what was paid in another currency at the rate the payer
 * states (request 21): then the amount in the group's currency is computed here, from the original amount and the rate,
 * and the expense keeps the currency, the original amount and the rate with it.
 *
 * Its behaviours: its creation records ExpenseRecorded; an edit, from the version its author read, gives the expense
 * again whole and records ExpenseEdited; its deletion records ExpenseDeleted. The payer is who paid, and an edit never
 * changes it. Only the payer and the group's owner may change an expense, and only while the payer and every member of
 * its split are still members of the group: an expense that concerns a member who left is kept as it was.
 */
export class Expense extends AggregateRoot {
  #groupId: string;
  readonly #description: ExpenseDescription;
  readonly #amount: ExpenseAmount;
  readonly #date: ExpenseDate;
  readonly #paidBy: string;
  readonly #shares: ExpenseShare[];
  readonly #splitKind: SplitKind;
  readonly #original: OriginalAmount | null;
  readonly #category: Category;
  /** The audit entries of the changes this aggregate made since it was read (request 28): written with the change by its store. */
  readonly #audit: AuditEntry[] = [];

  private constructor(
    id: Id,
    groupId: string,
    description: ExpenseDescription,
    amount: ExpenseAmount,
    date: ExpenseDate,
    paidBy: string,
    shares: ExpenseShare[],
    splitKind: SplitKind,
    original: OriginalAmount | null,
    category: Category,
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#description = description;
    this.#amount = amount;
    this.#date = date;
    this.#paidBy = paidBy;
    this.#shares = shares;
    this.#splitKind = splitKind;
    this.#original = original;
    this.#category = category;
  }

  /**
   * Records an expense paid by `paidBy`, split as `split` says, in the order the members were given. `money` is the amount
   * in the group's currency, or what was paid in another currency; `groupCurrency` is the currency the group counts in,
   * as Groups answers it. `members` are the group's current members, as Groups answers them; `today` is the application's
   * clock, the day an expense may not be after; `offer` is the rate offered for an expense in another currency and its day,
   * asked by the handler (request 22), or null when none was asked. Every value is validated here, and a refusal is a failed
   * Result, never thrown.
   */
  static create({
    groupId,
    description,
    money,
    groupCurrency,
    date,
    paidBy,
    split,
    members,
    today,
    offer = null,
    category = DEFAULT_CATEGORY,
    id,
  }: {
    groupId: string;
    description: string;
    money: ExpenseMoney;
    groupCurrency: string;
    date: string;
    paidBy: string;
    split: SplitRequest;
    members: string[];
    today: Date;
    offer?: RateOffer | null;
    /** The category, one of eight; `other` when left out (request 24). */
    category?: Category;
    /** The id of an expense whose day a recurring expense made (request 23): built on the id its fact carries; generated when left out. */
    id?: string;
  }): IResult<Expense> {
    const decided = Expense.decide({
      description,
      money,
      groupCurrency,
      date,
      paidBy,
      split,
      memberIds: members,
      today,
      offer,
      category,
    });
    if (decided.isFailure()) return Result.fail(decided.error);

    const expense = new Expense(
      id === undefined ? Id.generate() : new Id(id),
      groupId,
      decided.data.description,
      decided.data.amount,
      decided.data.date,
      paidBy,
      decided.data.shares,
      decided.data.splitKind,
      decided.data.original,
      decided.data.category,
      0,
    );
    expense.#audit.push(
      recordAudit({
        groupId,
        at: today,
        by: paidBy,
        action: 'expense-recorded',
        subjectId: expense._id.value,
        amount: expense.#amount.value,
      }),
    );
    expense.record(
      ExpenseRecordedEvent.set({
        expenseId: expense._id.value,
        groupId,
        paidBy,
        amount: expense.#amount.value,
        splitKind: expense.#splitKind,
        shares: expense.#shares.map(share => ({ ...share })),
      }),
    );
    return Result.ok(expense);
  }

  /**
   * Gives the expense again, whole, as `editedBy` made it from `version`, the version they read. Only the payer and the
   * group's owner may edit it; any other member is refused. An edit from another version than this one is refused, since
   * the expense changed since it was read; the values are then checked as when it was recorded, and the payer stays the
   * one who paid. The amount is given again either in the group's currency or as what was paid in another currency, and
   * the shares are computed again from it, split as the edit says. Answers the edited expense, at the version it was read
   * at: the store makes it the next one. `offer` is the rate offered for an expense in another currency, as for a recording.
   */
  edit({
    editedBy,
    members,
    groupCurrency,
    version,
    description,
    money,
    date,
    split,
    today,
    offer = null,
    category = DEFAULT_CATEGORY,
  }: {
    editedBy: string;
    members: GroupMember[];
    groupCurrency: string;
    version: number;
    description: string;
    money: ExpenseMoney;
    date: string;
    split: SplitRequest;
    today: Date;
    offer?: RateOffer | null;
    /** The category the expense is given now, one of eight; `other` when left out (request 24). */
    category?: Category;
  }): IResult<Expense> {
    if (!this.mayChange(editedBy, members)) return Result.fail(notAllowed());
    if (this.concernsFormerMember(members)) return Result.fail(new ExpenseOfFormerMemberException());
    if (version !== this.version) return Result.fail(new ExpenseChangedException());

    const decided = Expense.decide({
      description,
      money,
      groupCurrency,
      date,
      paidBy: this.#paidBy,
      split,
      memberIds: memberIdsOf(members),
      today,
      offer,
      category,
    });
    if (decided.isFailure()) return Result.fail(decided.error);

    const edited = new Expense(
      this._id,
      this.#groupId,
      decided.data.description,
      decided.data.amount,
      decided.data.date,
      this.#paidBy,
      decided.data.shares,
      decided.data.splitKind,
      decided.data.original,
      decided.data.category,
      this.version,
    );
    edited.#audit.push(
      recordAudit({
        groupId: this.#groupId,
        at: today,
        by: editedBy,
        action: 'expense-edited',
        subjectId: this._id.value,
        amount: edited.#amount.value,
      }),
    );
    edited.record(
      ExpenseEditedEvent.set({
        expenseId: this._id.value,
        groupId: this.#groupId,
        paidBy: this.#paidBy,
        splitKind: edited.#splitKind,
      }),
    );
    return Result.ok(edited);
  }

  /**
   * Deletes the expense, as `deletedBy` asks: only the payer and the group's owner may. A deleted expense no longer
   * exists; the store removes it in the transaction that records ExpenseDeleted.
   */
  delete({ deletedBy, members, at }: { deletedBy: string; members: GroupMember[]; at: Date }): IResult {
    if (!this.mayChange(deletedBy, members)) return Result.fail(notAllowed());
    if (this.concernsFormerMember(members)) return Result.fail(new ExpenseOfFormerMemberException());

    this.#audit.push(
      recordAudit({
        groupId: this.#groupId,
        at,
        by: deletedBy,
        action: 'expense-deleted',
        subjectId: this._id.value,
        amount: this.#amount.value,
      }),
    );

    this.record(ExpenseDeletedEvent.set({ expenseId: this._id.value, groupId: this.#groupId }));
    return Result.ok();
  }

  /** The audit entries of the changes made since the aggregate was read, in the order they were made (request 28). */
  get newAuditEntries(): readonly AuditEntry[] {
    return this.#audit;
  }

  /** Rebuilds an expense from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: IExpenseSnapshot): Expense {
    const description = ExpenseDescription.create(snapshot.description);
    const amount = ExpenseAmount.create(snapshot.amount);
    // A stored day was valid when it was recorded; it is checked for its shape and calendar, not against today again.
    const date = ExpenseDate.create(snapshot.date, new Date(`${snapshot.date}T00:00:00.000Z`));
    // A stored original amount is checked for its own values; its amount in the group's currency is not converted again here,
    // because an expense does not keep its group's currency, and the conversion needs it (ADR 25). It was decided when recorded.
    const original = snapshot.original ? OriginalAmount.restore(snapshot.original) : null;
    const total = snapshot.shares.reduce((sum, share) => sum + share.amount, 0);
    if (
      description.isFailure() ||
      amount.isFailure() ||
      date.isFailure() ||
      (original !== null && original.isFailure()) ||
      total !== snapshot.amount ||
      !snapshot.shares.some(share => share.memberId === snapshot.paidBy) ||
      !SPLIT_KINDS.includes(snapshot.splitKind) ||
      !isCategory(snapshot.category)
    ) {
      throw new Error(`Corrupted expense ${snapshot._id}`);
    }
    return new Expense(
      new Id(snapshot._id),
      snapshot.groupId,
      description.data,
      amount.data,
      date.data,
      snapshot.paidBy,
      snapshot.shares.map(share => ({ ...share })),
      snapshot.splitKind,
      original?.data ?? null,
      snapshot.category,
      snapshot.version,
    );
  }

  toSnapshot(): IExpenseSnapshot {
    return {
      _id: this._id.value,
      groupId: this.#groupId,
      description: this.#description.value,
      amount: this.#amount.value,
      date: this.#date.value,
      paidBy: this.#paidBy,
      shares: this.#shares.map(share => ({ ...share })),
      splitKind: this.#splitKind,
      original: this.#original ? this.#original.toSnapshot() : null,
      category: this.#category,
      version: this.version,
    };
  }

  /**
   * The expense moves to the group it names, the group merged into the group kept (request 31). Its id, payer, shares, version and
   * category are kept: only its group changes, and ExpenseMoved is recorded. The store moves it at the version it was read at.
   */
  moveTo(groupId: string): void {
    const from = this.#groupId;
    this.#groupId = groupId;
    this.record(ExpenseMovedEvent.set({ expenseId: this._id.value, from, to: groupId }));
  }

  get groupId(): string {
    return this.#groupId;
  }

  /** How the expense was split: equally, by exact amounts, or by shares. */
  get splitKind(): SplitKind {
    return this.#splitKind;
  }

  get paidBy(): string {
    return this.#paidBy;
  }

  /** The category of the expense: one of eight, `other` when none was given (request 24). */
  get category(): Category {
    return this.#category;
  }

  /** The payer, and the group's owner, may change the expense; no other member may. */
  private mayChange(memberId: string, members: GroupMember[]): boolean {
    return memberId === this.#paidBy || members.some(member => member.memberId === memberId && member.role === 'owner');
  }

  /**
   * Whether the payer or a member of the split is no longer a member of the group: such an expense can no longer change,
   * so that its member's balance stays 0 and the group's balances still add up to 0 (request 9).
   */
  private concernsFormerMember(members: GroupMember[]): boolean {
    const current = new Set(members.map(member => member.memberId));
    return [this.#paidBy, ...this.#shares.map(share => share.memberId)].some(memberId => !current.has(memberId));
  }

  /** The values of an expense, validated as the rules say and its shares computed; refused as a failed Result. */
  private static decide({
    description,
    money,
    groupCurrency,
    date,
    paidBy,
    split,
    memberIds,
    today,
    offer,
    category,
  }: {
    description: string;
    money: ExpenseMoney;
    groupCurrency: string;
    date: string;
    paidBy: string;
    split: SplitRequest;
    memberIds: string[];
    today: Date;
    offer: RateOffer | null;
    category: Category;
  }): IResult<{
    description: ExpenseDescription;
    amount: ExpenseAmount;
    original: OriginalAmount | null;
    date: ExpenseDate;
    shares: ExpenseShare[];
    splitKind: SplitKind;
    category: Category;
  }> {
    if (!isCategory(category)) return Result.fail(new InvalidCategoryException());
    const validDescription = ExpenseDescription.create(description);
    if (validDescription.isFailure()) return Result.fail(validDescription.error);
    const validDate = ExpenseDate.create(date, today);
    if (validDate.isFailure()) return Result.fail(validDate.error);
    const priced = Expense.price(money, groupCurrency, offer);
    if (priced.isFailure()) return Result.fail(priced.error);
    const validAmount = ExpenseAmount.create(priced.data.amount);
    if (validAmount.isFailure()) return Result.fail(validAmount.error);

    const shares = Split.decide({ request: split, amount: validAmount.data.value, payerId: paidBy, memberIds });
    if (shares.isFailure()) return Result.fail(shares.error);

    return Result.ok({
      description: validDescription.data,
      amount: validAmount.data,
      original: priced.data.original,
      date: validDate.data,
      shares: shares.data,
      splitKind: split.kind,
      category,
    });
  }

  /**
   * The amount in the group's currency, and the original amount it came from, if any: the group's amount is given as it
   * is; an amount in another currency is converted at its rate, settled against the offer (request 22), and the group's
   * amount is what the split divides.
   */
  private static price(
    money: ExpenseMoney,
    groupCurrency: string,
    offer: RateOffer | null,
  ): IResult<{ amount: number; original: OriginalAmount | null }> {
    if (!('original' in money)) return Result.ok({ amount: money.amount, original: null });

    const original = OriginalAmount.create(money.original, groupCurrency, offer);
    if (original.isFailure()) return Result.fail(original.error);
    return Result.ok({ amount: original.data.inGroupCurrency(groupCurrency), original: original.data });
  }
}

const SPLIT_KINDS: readonly string[] = ['equal', 'exact', 'shares'];

const memberIdsOf = (members: GroupMember[]): string[] => members.map(member => member.memberId);

/** The refusal of a member who is neither the payer nor the owner. */
const notAllowed = (): NotAllowedException =>
  new NotAllowedException('Ledger', 'Only the payer or the group’s owner may change an expense');
