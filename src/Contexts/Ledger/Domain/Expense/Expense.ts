import { AggregateRoot, IResult, Id, NotAllowedException, Result } from '@Architecture/Domain';

import { IExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
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
  ExpenseRecordedEvent,
} from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ExpenseShare, Split, SplitKind, SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * Expense is the aggregate root of one expense: what a member paid for some members of a group, split equally, by exact
 * amounts, or by shares. It keeps that its shares add up to its amount, since they are computed by Split, here, from what
 * was given, and kept as they were decided, with the kind of split they came from. The split is refused when it lists
 * someone who is not a current member of the group, lists someone twice, or leaves out the payer; the current members,
 * with their roles, are asked of Groups by the handler and given here.
 *
 * Its behaviours: its creation records ExpenseRecorded; an edit, from the version its author read, gives the expense
 * again whole and records ExpenseEdited; its deletion records ExpenseDeleted. The payer is who paid, and an edit never
 * changes it. Only the payer and the group's owner may change an expense, and only while the payer and every member of
 * its split are still members of the group: an expense that concerns a member who left is kept as it was.
 */
export class Expense extends AggregateRoot {
  readonly #groupId: string;
  readonly #description: ExpenseDescription;
  readonly #amount: ExpenseAmount;
  readonly #date: ExpenseDate;
  readonly #paidBy: string;
  readonly #shares: ExpenseShare[];
  readonly #splitKind: SplitKind;

  private constructor(
    id: Id,
    groupId: string,
    description: ExpenseDescription,
    amount: ExpenseAmount,
    date: ExpenseDate,
    paidBy: string,
    shares: ExpenseShare[],
    splitKind: SplitKind,
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
  }

  /**
   * Records an expense paid by `paidBy`, split as `split` says, in the order the members were given. `members` are the
   * group's current members, as Groups answers them; `today` is the application's clock, the day an expense may not
   * be after. Every value is validated here, and the split is refused as a failed Result, never thrown.
   */
  static create({
    groupId,
    description,
    amount,
    date,
    paidBy,
    split,
    members,
    today,
  }: {
    groupId: string;
    description: string;
    amount: number;
    date: string;
    paidBy: string;
    split: SplitRequest;
    members: string[];
    today: Date;
  }): IResult<Expense> {
    const decided = Expense.decide({ description, amount, date, paidBy, split, memberIds: members, today });
    if (decided.isFailure()) return Result.fail(decided.error);

    const expense = new Expense(
      Id.generate(),
      groupId,
      decided.data.description,
      decided.data.amount,
      decided.data.date,
      paidBy,
      decided.data.shares,
      decided.data.splitKind,
      0,
    );
    expense.record(
      ExpenseRecordedEvent.set({ expenseId: expense._id.value, groupId, paidBy, splitKind: expense.#splitKind }),
    );
    return Result.ok(expense);
  }

  /**
   * Gives the expense again, whole, as `editedBy` made it from `version`, the version they read. Only the payer and the
   * group's owner may edit it; any other member is refused. An edit from another version than this one is refused, since
   * the expense changed since it was read; the values are then checked as when it was recorded, and the payer stays the
   * one who paid. The shares are computed again from what the edit gives, split as the edit says. Answers the edited
   * expense, at the version it was read at: the store makes it the next one.
   */
  edit({
    editedBy,
    members,
    version,
    description,
    amount,
    date,
    split,
    today,
  }: {
    editedBy: string;
    members: GroupMember[];
    version: number;
    description: string;
    amount: number;
    date: string;
    split: SplitRequest;
    today: Date;
  }): IResult<Expense> {
    if (!this.mayChange(editedBy, members)) return Result.fail(notAllowed());
    if (this.concernsFormerMember(members)) return Result.fail(new ExpenseOfFormerMemberException());
    if (version !== this.version) return Result.fail(new ExpenseChangedException());

    const decided = Expense.decide({
      description,
      amount,
      date,
      paidBy: this.#paidBy,
      split,
      memberIds: memberIdsOf(members),
      today,
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
      this.version,
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
  delete({ deletedBy, members }: { deletedBy: string; members: GroupMember[] }): IResult {
    if (!this.mayChange(deletedBy, members)) return Result.fail(notAllowed());
    if (this.concernsFormerMember(members)) return Result.fail(new ExpenseOfFormerMemberException());

    this.record(ExpenseDeletedEvent.set({ expenseId: this._id.value, groupId: this.#groupId }));
    return Result.ok();
  }

  /** Rebuilds an expense from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: IExpenseSnapshot): Expense {
    const description = ExpenseDescription.create(snapshot.description);
    const amount = ExpenseAmount.create(snapshot.amount);
    // A stored day was valid when it was recorded; it is checked for its shape and calendar, not against today again.
    const date = ExpenseDate.create(snapshot.date, new Date(`${snapshot.date}T00:00:00.000Z`));
    const total = snapshot.shares.reduce((sum, share) => sum + share.amount, 0);
    if (
      description.isFailure() ||
      amount.isFailure() ||
      date.isFailure() ||
      total !== snapshot.amount ||
      !snapshot.shares.some(share => share.memberId === snapshot.paidBy) ||
      !SPLIT_KINDS.includes(snapshot.splitKind)
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
      version: this.version,
    };
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
    amount,
    date,
    paidBy,
    split,
    memberIds,
    today,
  }: {
    description: string;
    amount: number;
    date: string;
    paidBy: string;
    split: SplitRequest;
    memberIds: string[];
    today: Date;
  }): IResult<{
    description: ExpenseDescription;
    amount: ExpenseAmount;
    date: ExpenseDate;
    shares: ExpenseShare[];
    splitKind: SplitKind;
  }> {
    const validDescription = ExpenseDescription.create(description);
    if (validDescription.isFailure()) return Result.fail(validDescription.error);
    const validAmount = ExpenseAmount.create(amount);
    if (validAmount.isFailure()) return Result.fail(validAmount.error);
    const validDate = ExpenseDate.create(date, today);
    if (validDate.isFailure()) return Result.fail(validDate.error);

    const shares = Split.decide({ request: split, amount: validAmount.data.value, payerId: paidBy, memberIds });
    if (shares.isFailure()) return Result.fail(shares.error);

    return Result.ok({
      description: validDescription.data,
      amount: validAmount.data,
      date: validDate.data,
      shares: shares.data,
      splitKind: split.kind,
    });
  }
}

const SPLIT_KINDS: readonly string[] = ['equal', 'exact', 'shares'];

const memberIdsOf = (members: GroupMember[]): string[] => members.map(member => member.memberId);

/** The refusal of a member who is neither the payer nor the owner. */
const notAllowed = (): NotAllowedException =>
  new NotAllowedException('Ledger', 'Only the payer or the group’s owner may change an expense');
