import { AggregateRoot, Id, IResult, NotAllowedException, Result } from '@Architecture/Domain';

import { ExpenseSnapshot, ShareSnapshot, SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';
import {
  ExpenseDeletedEvent,
  ExpenseEditedEvent,
  ExpenseRecordedEvent,
} from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { ExpenseDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseDescription';
import {
  ExpenseChangedException,
  ExpenseOfFormerMemberException,
  InvalidAmountException,
  InvalidDateException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SPLIT_KINDS, Split, SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/** The largest amount of an expense, in whole units of the group's currency. */
export const MAX_EXPENSE_AMOUNT = 100_000_000;

/**
 * An amount a member of a group paid for some of its members, split equally, by exact amounts or by shares between them
 * (conventions/domain.yaml, the Ledger context; docs/adr/0004, docs/adr/0007). One aggregate per expense: it keeps that its shares add up to its amount, and nothing
 * else of the group is in it. The balances are not here (request 5).
 *
 * `register()` is the creation, named as Group's is: it validates the description, the amount, the date and the split,
 * generates the id, and records ExpenseRecorded for the store to make durable with it. The date is a real day of the
 * calendar, not after today in UTC, today being the one clock's now. `members` are the group's current members, which the
 * use case asked Groups for. `fromSnapshot()` reads what the store kept, records nothing, and throws on corrupted data.
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

  private constructor(
    id: Id,
    groupId: string,
    description: ExpenseDescription,
    amount: number,
    date: string,
    paidBy: string,
    split: Split,
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#description = description;
    this.#amount = amount;
    this.#date = date;
    this.#paidBy = paidBy;
    this.#split = split;
  }

  static register({
    groupId,
    description,
    amount,
    date,
    paidBy,
    split,
    members,
    at,
  }: {
    groupId: string;
    description: string;
    amount: number;
    date: string;
    paidBy: string;
    split: SplitInput;
    members: string[];
    at: Date;
  }): IResult<Expense> {
    const checked = checkExpense({ description, amount, date, paidBy, split, members, at });
    if (checked.isFailure()) return checked;

    const id = Id.generate();
    const expense = new Expense(id, groupId, checked.data.description, amount, date, paidBy, checked.data.split, 0);
    expense.record(
      ExpenseRecordedEvent.set({
        expenseId: id.value,
        groupId,
        amount,
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
    amount,
    date,
    split,
    at,
  }: {
    by: string;
    members: GroupMember[];
    version: number;
    description: string;
    amount: number;
    date: string;
    split: SplitInput;
    at: Date;
  }): IResult<Expense> {
    if (!this.mayChange(by, members)) return Result.fail(notAllowedToChange());
    if (!this.concernsOnlyCurrentMembers(members)) return Result.fail(new ExpenseOfFormerMemberException());
    if (version !== this.version) return Result.fail(new ExpenseChangedException());

    const checked = checkExpense({
      description,
      amount,
      date,
      paidBy: this.#paidBy,
      split,
      members: members.map(member => member.memberId),
      at,
    });
    if (checked.isFailure()) return checked;

    const edited = new Expense(
      this._id,
      this.#groupId,
      checked.data.description,
      amount,
      date,
      this.#paidBy,
      checked.data.split,
      this.version,
    );
    edited.record(
      ExpenseEditedEvent.set({
        expenseId: this._id.value,
        groupId: this.#groupId,
        amount,
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
  remove({ by, members }: { by: string; members: GroupMember[] }): IResult<Expense> {
    if (!this.mayChange(by, members)) return Result.fail(notAllowedToChange());
    if (!this.concernsOnlyCurrentMembers(members)) return Result.fail(new ExpenseOfFormerMemberException());
    this.record(ExpenseDeletedEvent.set({ expenseId: this._id.value, groupId: this.#groupId, paidBy: this.#paidBy }));
    return Result.ok(this);
  }

  static fromSnapshot(snapshot: ExpenseSnapshot): Expense {
    const description = ExpenseDescription.create(snapshot.description);
    const split = Split.fromSnapshot({ kind: snapshot.splitKind, shares: snapshot.shares });
    if (
      description.isFailure() ||
      !isRealDay(snapshot.date) ||
      !SPLIT_KINDS.includes(snapshot.splitKind) ||
      split.total !== snapshot.amount ||
      snapshot.shares.length === 0
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
  amount,
  date,
  paidBy,
  split,
  members,
  at,
}: {
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  split: SplitInput;
  members: string[];
  at: Date;
}): IResult<{ description: ExpenseDescription; split: Split }> {
  const text = ExpenseDescription.create(description);
  if (text.isFailure()) return text;
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_EXPENSE_AMOUNT) {
    return Result.fail(new InvalidAmountException());
  }
  if (!isRealDay(date) || date > dayOf(at)) {
    return Result.fail(new InvalidDateException());
  }
  const checkedSplit = Split.of({ input: split, amount, payerId: paidBy, members });
  if (checkedSplit.isFailure()) return checkedSplit;
  return Result.ok({ description: text.data, split: checkedSplit.data });
}

const notAllowedToChange = () =>
  new NotAllowedException('Ledger', "Only the payer of an expense or the group's owner may change it");

/** Whether `raw` is a day of the calendar written `YYYY-MM-DD`: `2026-02-30` is not one. */
function isRealDay(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const day = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && dayOf(day) === raw;
}

/** The day of an instant, in UTC, written `YYYY-MM-DD`. */
const dayOf = (instant: Date): string => instant.toISOString().slice(0, 10);
