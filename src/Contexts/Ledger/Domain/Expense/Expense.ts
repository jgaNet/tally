import { AggregateRoot, Id, IResult, NotAllowedException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';

import {
  ExpenseSnapshot,
  OriginalAmountSnapshot,
  ShareSnapshot,
  SplitKind,
} from '@Contexts/Ledger/Domain/Expense/DTOs';
import {
  ExpenseDeletedEvent,
  ExpenseEditedEvent,
  ExpenseRecordedEvent,
} from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { AmountInput, MAX_EXPENSE_AMOUNT, OriginalAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import { ExpenseDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseDescription';
import { Category, DEFAULT_CATEGORY, isCategory } from '@Contexts/Ledger/Domain/Expense/Category';
import {
  ExpenseChangedException,
  ExpenseOfFormerMemberException,
  InvalidAmountException,
  InvalidCategoryException,
  InvalidDateException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SPLIT_KINDS, Split, SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

export { MAX_EXPENSE_AMOUNT };

/**
 * An amount a member of a group paid for some of its members, split equally, by exact amounts or by shares between them
 * (conventions/domain.yaml, the Ledger context; docs/adr/0004, docs/adr/0007). One aggregate per expense: it keeps that its shares add up to its amount, and nothing
 * else of the group is in it. The balances are not here (request 5).
 *
 * The amount is the group's, and it is given either as it (`amount`) or as what was paid in another currency (`original`, request
 * 21, docs/adr/0020): then the amount is the original times its rate, and the expense keeps both, with the rate as the payer gave it.
 *
 * `register()` is the creation, named as Group's is: it validates the description, the amount, the date and the split,
 * generates the id, and records ExpenseRecorded for the store to make durable with it. The date is a real day of the calendar,
 * not after today in UTC, today being the one clock's now. `members` are the group's current members, which the use case asked
 * Groups for. `fromSnapshot()` reads what the store kept, records nothing, and throws on corrupted data.
 *
 * `edit()` and `remove()` are the two changes after the creation (request 6, docs/adr/0006). Both are refused to anyone
 * but the payer and the group's owner; `edit()` is refused when the version it was made from is not the one the expense
 * was read at. The payer never changes. An edit answers a new expense at the same version, which the store checks when it
 * saves it: the aggregate never changes its own version (ADR 8).
 */
export class Expense extends AggregateRoot {
  readonly #groupId: string;
  readonly #description: ExpenseDescription;
  readonly #amount: number;
  readonly #date: string;
  readonly #paidBy: string;
  readonly #split: Split;
  readonly #original: OriginalAmount | undefined;
  readonly #category: Category;

  private constructor(
    id: Id,
    groupId: string,
    description: ExpenseDescription,
    amount: number,
    date: string,
    paidBy: string,
    split: Split,
    original: OriginalAmount | undefined,
    category: Category,
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#description = description;
    this.#amount = amount;
    this.#date = date;
    this.#paidBy = paidBy;
    this.#split = split;
    this.#original = original;
    this.#category = category;
  }

  /**
   * `id` is given only by a recurring expense's day, which carries the id of the expense it records (request 23, docs/adr/0022):
   * the reaction that records it then finds the expense recorded when the fact comes again. Any other creation generates it.
   */
  static register({
    id: givenId,
    groupId,
    description,
    date,
    paidBy,
    split,
    members,
    category,
    archived,
    at,
    ...money
  }: {
    id?: string;
    groupId: string;
    description: string;
    date: string;
    paidBy: string;
    split: SplitInput;
    members: string[];
    /** What the expense is for (request 24); left out, it is `other`. */
    category?: string;
    /** Whether the group is archived, as Groups says it now (request 27): an archived group takes no expense. */
    archived: boolean;
    at: Date;
  } & AmountInput): IResult<Expense> {
    if (archived) return Result.fail(new GroupArchivedException('Ledger'));
    const checked = checkExpense({ description, date, paidBy, split, members, category, at, ...money });
    if (checked.isFailure()) return checked;

    const id = givenId === undefined ? Id.generate() : new Id(givenId);
    const expense = new Expense(
      id,
      groupId,
      checked.data.description,
      checked.data.amount,
      date,
      paidBy,
      checked.data.split,
      checked.data.original,
      checked.data.category,
      0,
    );
    expense.record(
      ExpenseRecordedEvent.set({
        expenseId: id.value,
        groupId,
        amount: checked.data.amount,
        paidBy,
        splitKind: checked.data.split.kind,
        shares: checked.data.split.shares,
      }),
    );
    return Result.ok(expense);
  }

  /**
   * Gives the expense again, whole, as its author read it at `version` (request 6). Only its payer or the group's owner may
   * do it; the rules of a creation hold again on what it gives, with the payer kept as the one who paid. The answer is the
   * expense as it is to be stored: at the version it was read at, the store checks that and stores one more.
   */
  edit({
    by,
    members,
    version,
    description,
    date,
    split,
    category,
    archived,
    at,
    ...money
  }: {
    by: string;
    members: GroupMember[];
    version: number;
    description: string;
    date: string;
    split: SplitInput;
    /** What the expense is for (request 24): left out, it is `other`, as the expense is given whole. */
    category?: string;
    /** Whether the group is archived, as Groups says it now (request 27): an archived group changes no expense. */
    archived: boolean;
    at: Date;
  } & AmountInput): IResult<Expense> {
    if (archived) return Result.fail(new GroupArchivedException('Ledger'));
    if (!this.mayChange(by, members)) return Result.fail(notAllowedToChange());
    if (!this.concernsOnlyCurrentMembers(members)) return Result.fail(new ExpenseOfFormerMemberException());
    if (version !== this.version) return Result.fail(new ExpenseChangedException());

    const checked = checkExpense({
      description,
      date,
      paidBy: this.#paidBy,
      split,
      members: members.map(member => member.memberId),
      category,
      at,
      ...money,
    });
    if (checked.isFailure()) return checked;

    const edited = new Expense(
      this._id,
      this.#groupId,
      checked.data.description,
      checked.data.amount,
      date,
      this.#paidBy,
      checked.data.split,
      checked.data.original,
      checked.data.category,
      this.version,
    );
    edited.record(
      ExpenseEditedEvent.set({
        expenseId: this._id.value,
        groupId: this.#groupId,
        amount: checked.data.amount,
        paidBy: this.#paidBy,
        splitKind: checked.data.split.kind,
      }),
    );
    return Result.ok(edited);
  }

  /**
   * Removes the expense, for its payer or the group's owner (request 6). A deleted expense is gone from every read and
   * counts in no balance: the store removes it and its shares with it, in the same transaction.
   */
  remove({ by, members, archived }: { by: string; members: GroupMember[]; archived: boolean }): IResult<Expense> {
    if (archived) return Result.fail(new GroupArchivedException('Ledger'));
    if (!this.mayChange(by, members)) return Result.fail(notAllowedToChange());
    if (!this.concernsOnlyCurrentMembers(members)) return Result.fail(new ExpenseOfFormerMemberException());
    this.record(ExpenseDeletedEvent.set({ expenseId: this._id.value, groupId: this.#groupId, paidBy: this.#paidBy }));
    return Result.ok(this);
  }

  static fromSnapshot(snapshot: ExpenseSnapshot): Expense {
    const description = ExpenseDescription.create(snapshot.description);
    const split = Split.fromSnapshot({ kind: snapshot.splitKind, shares: snapshot.shares });
    const original = snapshot.original === undefined ? undefined : OriginalAmount.read(snapshot.original);
    if (
      description.isFailure() ||
      !isRealDay(snapshot.date) ||
      !isCategory(snapshot.category) ||
      !SPLIT_KINDS.includes(snapshot.splitKind) ||
      split.total !== snapshot.amount ||
      snapshot.shares.length === 0 ||
      original?.isFailure() ||
      (original !== undefined && original.data?.toGroupAmount() !== snapshot.amount)
    ) {
      throw new Error(`The expense ${snapshot.id} is corrupted in the store`);
    }
    return new Expense(
      new Id(snapshot.id),
      snapshot.groupId,
      description.data,
      snapshot.amount,
      snapshot.date,
      snapshot.paidBy,
      split,
      original?.data,
      snapshot.category,
      snapshot.version,
    );
  }

  toSnapshot(): ExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      description: this.#description.value,
      amount: this.#amount,
      date: this.#date,
      paidBy: this.#paidBy,
      splitKind: this.#split.kind,
      shares: this.#split.shares,
      original: this.#original?.toSnapshot(),
      category: this.#category,
      version: this.version,
    };
  }

  get id(): string {
    return this._id.value;
  }

  get groupId(): string {
    return this.#groupId;
  }

  get paidBy(): string {
    return this.#paidBy;
  }

  get shares(): ShareSnapshot[] {
    return this.#split.shares;
  }

  get splitKind(): SplitKind {
    return this.#split.kind;
  }

  get original(): OriginalAmountSnapshot | undefined {
    return this.#original?.toSnapshot();
  }

  get category(): Category {
    return this.#category;
  }

  get date(): string {
    return this.#date;
  }

  /** The payer, or the group's owner, may change the expense; any other member may not. */
  private mayChange(by: string, members: GroupMember[]): boolean {
    if (by === this.#paidBy) return true;
    return members.some(member => member.memberId === by && member.role === 'owner');
  }

  /**
   * Whether the payer and every member of the split are still members of the group. An expense of a former member is kept as
   * it was: the shares stay, so the balances add up to 0 (docs/adr/0009).
   */
  private concernsOnlyCurrentMembers(members: GroupMember[]): boolean {
    const current = new Set(members.map(member => member.memberId));
    return current.has(this.#paidBy) && this.#split.shares.every(share => current.has(share.memberId));
  }
}

/** The rules of an expense as it is given, shared by its creation and its edit: the description, the amount, the date and the split. */
function checkExpense({
  description,
  date,
  paidBy,
  split,
  members,
  category,
  at,
  ...money
}: {
  description: string;
  date: string;
  paidBy: string;
  split: SplitInput;
  members: string[];
  category?: string;
  at: Date;
} & AmountInput): IResult<{
  description: ExpenseDescription;
  split: Split;
  amount: number;
  original: OriginalAmount | undefined;
  category: Category;
}> {
  const text = ExpenseDescription.create(description);
  if (text.isFailure()) return text;
  // An expense is in one of the categories, `other` when none is given (request 24): a name that is none of them is refused.
  if (category !== undefined && !isCategory(category)) return Result.fail(new InvalidCategoryException());
  const chosen: Category = category === undefined ? DEFAULT_CATEGORY : (category as Category);
  // The date comes before the amount: the rate offered for an expense in another currency is the one on its date (request 22).
  if (!isRealDay(date) || date > dayOf(at)) {
    return Result.fail(new InvalidDateException());
  }
  const money_ = amountOf(money);
  if (money_.isFailure()) return money_;
  const checkedSplit = Split.of({ input: split, amount: money_.data.amount, payerId: paidBy, members });
  if (checkedSplit.isFailure()) return checkedSplit;
  return Result.ok({
    description: text.data,
    split: checkedSplit.data,
    amount: money_.data.amount,
    original: money_.data.original,
    category: chosen,
  });
}

/**
 * The amount of an expense in the group's currency, and what it was paid in when that was another currency (request 21). Given
 * either as the group's amount or as an original, never both: the amount is refused by name when it is neither whole nor in range.
 * The rate of an original is decided against the offer it is given (request 22); with no offer, nothing is offered.
 */
function amountOf({
  amount,
  original,
  groupCurrency,
  offered,
}: AmountInput): IResult<{ amount: number; original: OriginalAmount | undefined }> {
  if (original === undefined) {
    if (amount === undefined || !Number.isInteger(amount) || amount < 1 || amount > MAX_EXPENSE_AMOUNT) {
      return Result.fail(new InvalidAmountException());
    }
    return Result.ok({ amount, original: undefined });
  }
  if (amount !== undefined || groupCurrency === undefined) return Result.fail(new InvalidAmountException());
  const paid = OriginalAmount.create(original, groupCurrency, offered ?? { kind: 'none' });
  if (paid.isFailure()) return paid;
  const inGroupCurrency = paid.data.toGroupAmount();
  if (inGroupCurrency < 1 || inGroupCurrency > MAX_EXPENSE_AMOUNT) return Result.fail(new InvalidAmountException());
  return Result.ok({ amount: inGroupCurrency, original: paid.data });
}

const notAllowedToChange = () =>
  new NotAllowedException('Ledger', "Only the payer of an expense or the group's owner may change it");

/** Whether `raw` is a day of the calendar written `YYYY-MM-DD`: `2026-02-30` is not one. */
export function isRealDay(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const day = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && dayOf(day) === raw;
}

/** The day of an instant, in UTC, written `YYYY-MM-DD`. */
export const dayOf = (instant: Date): string => instant.toISOString().slice(0, 10);
