import { AggregateRoot, IResult, Id, NotAllowedException, Result } from '@Architecture/Domain';

import { IExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { ExpenseAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { ExpenseDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseDescription';
import {
  ExpenseChangedException,
  SplitListsTwiceException,
  SplitWithStrangerException,
  SplitWithoutPayerException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import {
  ExpenseDeletedEvent,
  ExpenseEditedEvent,
  ExpenseRecordedEvent,
} from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ExpenseShare, Split } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * Expense is the aggregate root of one expense: what a member paid for some members of a group, split equally between
 * them. It keeps that its shares add up to its amount, since they are computed by Split, here, from what was given, and
 * kept as they were decided. The split is refused when it lists someone who is not a current member of the group, lists
 * someone twice, or leaves out the payer; the current members, with their roles, are asked of Groups by the handler and
 * given here.
 *
 * Its behaviours: its creation records ExpenseRecorded; an edit, from the version its author read, gives the expense
 * again whole and records ExpenseEdited; its deletion records ExpenseDeleted. The payer is who paid, and an edit never
 * changes it. Only the payer and the group's owner may change an expense.
 */
export class Expense extends AggregateRoot {
  readonly #groupId: string;
  readonly #description: ExpenseDescription;
  readonly #amount: ExpenseAmount;
  readonly #date: ExpenseDate;
  readonly #paidBy: string;
  readonly #shares: ExpenseShare[];

  private constructor(
    id: Id,
    groupId: string,
    description: ExpenseDescription,
    amount: ExpenseAmount,
    date: ExpenseDate,
    paidBy: string,
    shares: ExpenseShare[],
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#description = description;
    this.#amount = amount;
    this.#date = date;
    this.#paidBy = paidBy;
    this.#shares = shares;
  }

  /**
   * Records an expense paid by `paidBy`, split equally between `splitBetween` in the order given. `members` are the
   * group's current members, as Groups answers them; `today` is the application's clock, the day an expense may not
   * be after. Every value is validated here, and the split is refused as a failed Result, never thrown.
   */
  static create({
    groupId,
    description,
    amount,
    date,
    paidBy,
    splitBetween,
    members,
    today,
  }: {
    groupId: string;
    description: string;
    amount: number;
    date: string;
    paidBy: string;
    splitBetween: string[];
    members: string[];
    today: Date;
  }): IResult<Expense> {
    const decided = Expense.decide({ description, amount, date, paidBy, splitBetween, memberIds: members, today });
    if (decided.isFailure()) return Result.fail(decided.error);

    const expense = new Expense(
      Id.generate(),
      groupId,
      decided.data.description,
      decided.data.amount,
      decided.data.date,
      paidBy,
      decided.data.shares,
      0,
    );
    expense.record(ExpenseRecordedEvent.set({ expenseId: expense._id.value, groupId, paidBy }));
    return Result.ok(expense);
  }

  /**
   * Gives the expense again, whole, as `editedBy` made it from `version`, the version they read. Only the payer and the
   * group's owner may edit it; any other member is refused. An edit from another version than this one is refused, since
   * the expense changed since it was read; the values are then checked as when it was recorded, and the payer stays the
   * one who paid. The shares are computed again from what the edit gives. Answers the edited expense, at the version it
   * was read at: the store makes it the next one.
   */
  edit({
    editedBy,
    members,
    version,
    description,
    amount,
    date,
    splitBetween,
    today,
  }: {
    editedBy: string;
    members: GroupMember[];
    version: number;
    description: string;
    amount: number;
    date: string;
    splitBetween: string[];
    today: Date;
  }): IResult<Expense> {
    if (!this.mayChange(editedBy, members)) return Result.fail(notAllowed());
    if (version !== this.version) return Result.fail(new ExpenseChangedException());

    const decided = Expense.decide({
      description,
      amount,
      date,
      paidBy: this.#paidBy,
      splitBetween,
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
      this.version,
    );
    edited.record(ExpenseEditedEvent.set({ expenseId: this._id.value, groupId: this.#groupId, paidBy: this.#paidBy }));
    return Result.ok(edited);
  }

  /**
   * Deletes the expense, as `deletedBy` asks: only the payer and the group's owner may. A deleted expense no longer
   * exists; the store removes it in the transaction that records ExpenseDeleted.
   */
  delete({ deletedBy, members }: { deletedBy: string; members: GroupMember[] }): IResult {
    if (!this.mayChange(deletedBy, members)) return Result.fail(notAllowed());

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
      !snapshot.shares.some(share => share.memberId === snapshot.paidBy)
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
      version: this.version,
    };
  }

  get groupId(): string {
    return this.#groupId;
  }

  get paidBy(): string {
    return this.#paidBy;
  }

  /** The payer, and the group's owner, may change the expense; no other member may. */
  private mayChange(memberId: string, members: GroupMember[]): boolean {
    return memberId === this.#paidBy || members.some(member => member.memberId === memberId && member.role === 'owner');
  }

  /** The values of an expense, validated as the rules say and its shares computed; refused as a failed Result. */
  private static decide({
    description,
    amount,
    date,
    paidBy,
    splitBetween,
    memberIds,
    today,
  }: {
    description: string;
    amount: number;
    date: string;
    paidBy: string;
    splitBetween: string[];
    memberIds: string[];
    today: Date;
  }): IResult<{
    description: ExpenseDescription;
    amount: ExpenseAmount;
    date: ExpenseDate;
    shares: ExpenseShare[];
  }> {
    const validDescription = ExpenseDescription.create(description);
    if (validDescription.isFailure()) return Result.fail(validDescription.error);
    const validAmount = ExpenseAmount.create(amount);
    if (validAmount.isFailure()) return Result.fail(validAmount.error);
    const validDate = ExpenseDate.create(date, today);
    if (validDate.isFailure()) return Result.fail(validDate.error);

    if (splitBetween.some(memberId => !memberIds.includes(memberId))) {
      return Result.fail(new SplitWithStrangerException());
    }
    if (new Set(splitBetween).size !== splitBetween.length) {
      return Result.fail(new SplitListsTwiceException());
    }
    if (!splitBetween.includes(paidBy)) {
      return Result.fail(new SplitWithoutPayerException());
    }

    return Result.ok({
      description: validDescription.data,
      amount: validAmount.data,
      date: validDate.data,
      shares: Split.equally({ amount: validAmount.data.value, memberIds: splitBetween, payerId: paidBy }),
    });
  }
}

const memberIdsOf = (members: GroupMember[]): string[] => members.map(member => member.memberId);

/** The refusal of a member who is neither the payer nor the owner. */
const notAllowed = (): NotAllowedException =>
  new NotAllowedException('Ledger', 'Only the payer or the group’s owner may change an expense');
