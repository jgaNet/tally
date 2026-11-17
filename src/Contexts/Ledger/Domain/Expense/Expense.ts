import { AggregateRoot, IResult, Id, Result } from '@Architecture/Domain';

import { IExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { ExpenseAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { ExpenseDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseDescription';
import {
  SplitListsTwiceException,
  SplitWithStrangerException,
  SplitWithoutPayerException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { ExpenseShare, Split } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * Expense is the aggregate root of one expense: what a member paid for some members of a group, split equally between
 * them. It keeps that its shares add up to its amount, since they are computed once, here, by Split, and kept as they
 * were decided. The split is refused when it lists someone who is not a current member of the group, lists someone
 * twice, or leaves out the payer; the current members are asked of Groups by the handler and given here.
 *
 * Its creation is its one behaviour: it records ExpenseRecorded. An expense changes nothing once recorded.
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
    const validDescription = ExpenseDescription.create(description);
    if (validDescription.isFailure()) return Result.fail(validDescription.error);
    const validAmount = ExpenseAmount.create(amount);
    if (validAmount.isFailure()) return Result.fail(validAmount.error);
    const validDate = ExpenseDate.create(date, today);
    if (validDate.isFailure()) return Result.fail(validDate.error);

    if (splitBetween.some(memberId => !members.includes(memberId))) {
      return Result.fail(new SplitWithStrangerException());
    }
    if (new Set(splitBetween).size !== splitBetween.length) {
      return Result.fail(new SplitListsTwiceException());
    }
    if (!splitBetween.includes(paidBy)) {
      return Result.fail(new SplitWithoutPayerException());
    }

    const shares = Split.equally({ amount: validAmount.data.value, memberIds: splitBetween, payerId: paidBy });
    const expense = new Expense(
      Id.generate(),
      groupId,
      validDescription.data,
      validAmount.data,
      validDate.data,
      paidBy,
      shares,
      0,
    );
    expense.record(ExpenseRecordedEvent.set({ expenseId: expense._id.value, groupId, paidBy }));
    return Result.ok(expense);
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
}
