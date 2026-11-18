import { GroupArchived } from '@SharedKernel/Domain';
import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { NotAMemberOfTheGroup } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { Split, SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  DayNotYetCome,
  NotThePayerOrTheOwnerOfRecurring,
} from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpenseExceptions';
import { StartsOn } from '@Contexts/Ledger/Domain/RecurringExpense/StartsOn';
import {
  RecurringExpenseDayCameEvent,
  RecurringExpenseEndedEvent,
  RecurringExpenseSetUpEvent,
  RecurringExpenseStoppedEvent,
} from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';

/** What a recurring expense is, as it is kept between two runs of the sweep. */
export interface RecurringExpenseSnapshot {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  split: SplitInput;
  /** What its expenses are for (request 24); a recurring expense kept before categories is `other`. */
  category: string;
  version: number;
}

/**
 * An expense a member pays every month (request 23): its payer, description, amount and split as it was given, the day it
 * starts on and the next day it records. Its day comes once each month, on the same day of the month as `startsOn`, which is
 * 1 to 28, so every month has it. The sweep asks `recordDay` when a day has come: the day's expense is recorded under the id
 * this aggregate gives it (carried by the `RecurringExpenseDayCame` fact, ADR 14), or, when its payer or a member of its split
 * has left the group, the recurring expense ends and records no expense. A stopped one is deleted by the repository.
 *
 * It has a version: the one it was read at, which the repository stores + 1 when it saves a changed one (ADR 8).
 */
export class RecurringExpense extends AggregateRoot {
  private constructor(
    id: Id,
    readonly groupId: Id,
    readonly paidBy: Id,
    readonly description: Description,
    readonly amount: Amount,
    readonly startsOn: string,
    readonly next: string,
    readonly split: SplitInput,
    readonly category: Category,
    /** Whether the day decided ended it: the repository then deletes it instead of saving it (`recordDay`). */
    readonly ended: boolean,
    version: number,
  ) {
    super(id, version);
  }

  /**
   * Sets up a recurring expense the caller pays: the split is decided as an expense's is, so the same refusals apply, and the payer
   * and every member of the split must be members of the group. `groupMembers` are the group's current members, read by the handler;
   * `now` is the application's clock, read by the handler, and the start day is checked against it.
   */
  static setUp({
    groupId,
    paidBy,
    description,
    amount,
    startsOn,
    split,
    category,
    groupMembers,
    archived,
    now,
  }: {
    groupId: Id;
    paidBy: Id;
    description: string;
    amount: number;
    startsOn: string;
    split: SplitInput;
    /** What its expenses are for; `other` when none is given (request 24). */
    category?: string;
    groupMembers: Id[];
    /** Whether the group is archived, read by the handler: an archived group sets up no recurring expense (request 27). */
    archived: boolean;
    now: Date;
  }): IResult<RecurringExpense> {
    if (archived) return Result.fail(new GroupArchived('Ledger'));
    const text = Description.create(description);
    if (text.isFailure()) return text;
    const day = StartsOn.create(startsOn, now.toISOString().slice(0, 10));
    if (day.isFailure()) return day;
    const value = Amount.create(amount);
    if (value.isFailure()) return value;
    const kind = Category.create(category);
    if (kind.isFailure()) return kind;

    const decided = Split.decide({ amount: value.data, payer: paidBy, input: split });
    if (decided.isFailure()) return decided;
    const isMember = (memberId: Id) => groupMembers.some(member => member.value === memberId.value);
    if (!isMember(paidBy) || !decided.data.shares.every(share => isMember(share.memberId))) {
      return Result.fail(new NotAMemberOfTheGroup());
    }

    const recurring = new RecurringExpense(
      Id.generate(),
      groupId,
      paidBy,
      text.data,
      value.data,
      day.data.value,
      day.data.value,
      split,
      kind.data,
      false,
      0,
    );
    recurring.record(
      RecurringExpenseSetUpEvent.set({
        recurringExpenseId: recurring._id.value,
        groupId: groupId.value,
        paidBy: paidBy.value,
      }),
    );
    return Result.ok(recurring);
  }

  /** Whether its day has come by `today`, a UTC day (YYYY-MM-DD): the sweep records each day that has come, once. */
  dayHasCome(today: string): boolean {
    return this.next <= today;
  }

  /**
   * Decides the day that has come: when its payer and every member of its split are still in `groupMembers`, the day's expense
   * is to be recorded under a new id, carried by `RecurringExpenseDayCame`, and the next day is the same day of the next month;
   * otherwise the recurring expense ends (`ended`), and records no expense. `today` is the day of the application's clock, read
   * by the sweep. The returned aggregate keeps this version.
   */
  recordDay({
    today,
    groupMembers,
    archived,
  }: {
    today: string;
    groupMembers: Id[];
    /** Whether the group is archived, read by the sweep: an archived group records no expense of its own (request 27). */
    archived: boolean;
  }): IResult<RecurringExpense> {
    if (archived) return Result.fail(new GroupArchived('Ledger'));
    if (!this.dayHasCome(today)) return Result.fail(new DayNotYetCome());

    const isCurrent = (memberId: Id) => groupMembers.some(member => member.value === memberId.value);
    const concernsAFormerMember =
      !isCurrent(this.paidBy) || splitMemberIds(this.split).some(id => !isCurrent(new Id(id)));
    if (concernsAFormerMember) {
      const ended = this.with({ ended: true });
      ended.record(RecurringExpenseEndedEvent.set({ recurringExpenseId: this._id.value, groupId: this.groupId.value }));
      return Result.ok(ended);
    }

    const expenseId = Id.generate();
    const moved = this.with({ next: nextMonth(this.next) });
    moved.record(
      RecurringExpenseDayCameEvent.set({
        recurringExpenseId: this._id.value,
        expenseId: expenseId.value,
        groupId: this.groupId.value,
        paidBy: this.paidBy.value,
        description: this.description.value,
        amount: this.amount.value,
        day: this.next,
        split: this.split,
        category: this.category.value,
        members: [this.paidBy.value, ...splitMemberIds(this.split)],
      }),
    );
    return Result.ok(moved);
  }

  /** Stops it: only its payer, or the owner of its group (`byOwner`, read by the handler), may. It is deleted; no expense follows. */
  stop({ by, byOwner, archived }: { by: Id; byOwner: boolean; archived: boolean }): IResult<RecurringExpense> {
    if (archived) return Result.fail(new GroupArchived('Ledger'));
    if (!byOwner && by.value !== this.paidBy.value) return Result.fail(new NotThePayerOrTheOwnerOfRecurring());
    this.record(RecurringExpenseStoppedEvent.set({ recurringExpenseId: this._id.value, groupId: this.groupId.value }));
    return Result.ok(this);
  }

  static fromSnapshot(snapshot: RecurringExpenseSnapshot): RecurringExpense {
    const text = Description.create(snapshot.description);
    const value = Amount.create(snapshot.amount);
    if (
      text.isFailure() ||
      value.isFailure() ||
      !isStartsOnShape(snapshot.startsOn) ||
      !isStartsOnShape(snapshot.next)
    ) {
      throw new Error(`The recurring expense ${snapshot.id} is corrupted`);
    }
    return new RecurringExpense(
      new Id(snapshot.id),
      new Id(snapshot.groupId),
      new Id(snapshot.paidBy),
      text.data,
      value.data,
      snapshot.startsOn,
      snapshot.next,
      snapshot.split,
      Category.restore(snapshot.category),
      false,
      snapshot.version,
    );
  }

  toSnapshot(): RecurringExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      paidBy: this.paidBy.value,
      description: this.description.value,
      amount: this.amount.value,
      startsOn: this.startsOn,
      next: this.next,
      split: this.split,
      category: this.category.value,
      version: this.version,
    };
  }

  /** The same recurring expense, with the given changes, keeping this version: the one it was read at. */
  private with(changes: { next?: string; ended?: boolean }): RecurringExpense {
    return new RecurringExpense(
      this._id,
      this.groupId,
      this.paidBy,
      this.description,
      this.amount,
      this.startsOn,
      changes.next ?? this.next,
      this.split,
      this.category,
      changes.ended ?? this.ended,
      this.version,
    );
  }
}

/** The members a split names, as the ids given. */
function splitMemberIds(split: SplitInput): string[] {
  switch (split.kind) {
    case 'equal':
      return split.members;
    case 'exact':
      return split.amounts.map(share => share.memberId);
    case 'shares':
      return split.shares.map(share => share.memberId);
  }
}

/** The same day of the next month: a day of 1 to 28 exists in every month, so none is moved to a shorter month's end. */
function nextMonth(day: string): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month, dayOfMonth)).toISOString().slice(0, 10);
}

const isStartsOnShape = (day: string): boolean => /^\d{4}-\d{2}-(0[1-9]|1\d|2[0-8])$/.test(day);
