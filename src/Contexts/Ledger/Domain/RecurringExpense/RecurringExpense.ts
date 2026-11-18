import { AggregateRoot, Id, IResult, NotAllowedException, Result } from '@Architecture/Domain';

import { dayOf, isRealDay } from '@Contexts/Ledger/Domain/Expense/Expense';
import { MAX_EXPENSE_AMOUNT } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import { ExpenseDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseDescription';
import { InvalidAmountException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { listedMembers, Split, SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import { RecurringExpenseSnapshot } from '@Contexts/Ledger/Domain/RecurringExpense/DTOs';
import {
  RecurringExpenseDayCameEvent,
  RecurringExpenseEndedEvent,
  RecurringExpenseSetUpEvent,
  RecurringExpenseStoppedEvent,
} from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';
import { InvalidStartsOnException } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpenseExceptions';

/** The last day of the month a recurring expense may start on: every month has that day (request 23). */
const LAST_START_DAY = 28;
/** How far from today its first day may be, either way (request 23). */
const MAX_DAYS_FROM_TODAY = 365;
const DAY_MS = 86_400_000;

/**
 * What a run of the background job did with a recurring expense on its day (docs/adr/0022): its day recorded, the recurring
 * expense moved on to its next month and carrying the fact `RecurringExpenseDayCame`, or ended, carrying
 * `RecurringExpenseEnded`, because its payer or a member of its split has left the group.
 */
export type DayRun = { kind: 'recorded'; recurring: RecurringExpense } | { kind: 'ended'; recurring: RecurringExpense };

/**
 * An expense a member of a group pays every month (request 23, docs/adr/0022): its payer, its description, its amount, the split
 * it was given, and the day of its next expense. One aggregate per recurring expense; the expenses it records are Expenses of
 * their own, recorded by Ledger's reaction to `RecurringExpenseDayCame`.
 *
 * `setUp()` is the creation: it validates the description, the amount, the split (as an expense's, against the group's
 * current members, the payer among them) and the first day, which is a real day no more than 365 days from today and whose
 * day of the month is 1 to 28, so every month has it. It generates the id and records `RecurringExpenseSetUp`.
 *
 * `runDay()` is one step of the background job on the day of the next expense, given the group's current members: a
 * pure decision of the state and the members, with no port in it. The use case asks `isDue()` first, so a day that has
 * not come is not read for the members at all.
 *
 * The version is the one it was read at, as an expense's is (docs/adr/0008): the store checks it, and a run that moves the
 * recurring expense on is saved at that version, so two servers that run for the same day cannot both record it.
 */
export class RecurringExpense extends AggregateRoot {
  readonly #groupId: string;
  readonly #paidBy: string;
  readonly #description: ExpenseDescription;
  readonly #amount: number;
  readonly #startsOn: string;
  readonly #next: string;
  readonly #split: SplitInput;

  private constructor(
    id: Id,
    groupId: string,
    paidBy: string,
    description: ExpenseDescription,
    amount: number,
    startsOn: string,
    next: string,
    split: SplitInput,
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#paidBy = paidBy;
    this.#description = description;
    this.#amount = amount;
    this.#startsOn = startsOn;
    this.#next = next;
    this.#split = split;
  }

  static setUp({
    groupId,
    paidBy,
    description,
    amount,
    startsOn,
    split,
    members,
    at,
  }: {
    groupId: string;
    paidBy: string;
    description: string;
    amount: number;
    startsOn: string;
    split: SplitInput;
    members: string[];
    at: Date;
  }): IResult<RecurringExpense> {
    const text = ExpenseDescription.create(description);
    if (text.isFailure()) return text;
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_EXPENSE_AMOUNT) {
      return Result.fail(new InvalidAmountException());
    }
    if (!startsOnIsAllowed(startsOn, at)) return Result.fail(new InvalidStartsOnException());
    const checked = Split.of({ input: split, amount, payerId: paidBy, members });
    if (checked.isFailure()) return checked;

    const id = Id.generate();
    const recurring = new RecurringExpense(
      id,
      groupId,
      paidBy,
      text.data,
      amount,
      startsOn,
      startsOn,
      copyOf(split),
      0,
    );
    recurring.record(RecurringExpenseSetUpEvent.set({ recurringId: id.value, groupId }));
    return Result.ok(recurring);
  }

  /**
   * Stops it, for its payer or the group's owner (request 23): it no longer exists, and no expense is recorded for it from then
   * on. The expenses it recorded stay. The caller's membership is asked by the use case, which passes the members with their roles.
   */
  stop({ by, members }: { by: string; members: GroupMember[] }): IResult<RecurringExpense> {
    const mayStop = by === this.#paidBy || members.some(member => member.memberId === by && member.role === 'owner');
    if (!mayStop) {
      return Result.fail(
        new NotAllowedException('Ledger', "Only the payer of a recurring expense or the group's owner may stop it"),
      );
    }
    this.record(RecurringExpenseStoppedEvent.set({ recurringId: this._id.value, groupId: this.#groupId }));
    return Result.ok(this);
  }

  /** Whether the day of its next expense has come by `now`: it is not after today, in UTC. */
  isDue(now: Date): boolean {
    return this.#next <= dayOf(now);
  }

  /**
   * One step of the background job on its due day (docs/adr/0022). When its payer or a member of its split is not among the
   * group's `currentMemberIds`, the recurring expense ends and records no expense. Otherwise the day is recorded: the recurring
   * expense moves on to the same day of the next month, and records `RecurringExpenseDayCame`, which carries the id of the
   * expense that day records, so a redelivered fact finds that expense recorded rather than making another.
   */
  runDay(currentMemberIds: string[]): DayRun {
    const current = new Set(currentMemberIds);
    const concerned = [this.#paidBy, ...listedMembers(this.#split)];
    if (concerned.some(memberId => !current.has(memberId))) {
      this.record(RecurringExpenseEndedEvent.set({ recurringId: this._id.value, groupId: this.#groupId }));
      return { kind: 'ended', recurring: this };
    }
    const moved = new RecurringExpense(
      this._id,
      this.#groupId,
      this.#paidBy,
      this.#description,
      this.#amount,
      this.#startsOn,
      nextMonth(this.#next),
      copyOf(this.#split),
      this.version,
    );
    moved.record(
      RecurringExpenseDayCameEvent.set({
        recurringId: this._id.value,
        expenseId: Id.generate().value,
        groupId: this.#groupId,
        paidBy: this.#paidBy,
        description: this.#description.value,
        amount: this.#amount,
        date: this.#next,
        split: copyOf(this.#split),
      }),
    );
    return { kind: 'recorded', recurring: moved };
  }

  static fromSnapshot(snapshot: RecurringExpenseSnapshot): RecurringExpense {
    const description = ExpenseDescription.create(snapshot.description);
    if (
      description.isFailure() ||
      !isRealDay(snapshot.startsOn) ||
      !isRealDay(snapshot.next) ||
      Number(snapshot.startsOn.slice(8)) > LAST_START_DAY ||
      !Number.isInteger(snapshot.amount)
    ) {
      throw new Error(`The recurring expense ${snapshot.id} is corrupted in the store`);
    }
    return new RecurringExpense(
      new Id(snapshot.id),
      snapshot.groupId,
      snapshot.paidBy,
      description.data,
      snapshot.amount,
      snapshot.startsOn,
      snapshot.next,
      copyOf(snapshot.split),
      snapshot.version,
    );
  }

  toSnapshot(): RecurringExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      paidBy: this.#paidBy,
      description: this.#description.value,
      amount: this.#amount,
      startsOn: this.#startsOn,
      next: this.#next,
      split: copyOf(this.#split),
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

  get startsOn(): string {
    return this.#startsOn;
  }

  get next(): string {
    return this.#next;
  }
}

/** Whether a first day is allowed: a real day of the calendar, 1 to 28 in its month, and no more than 365 days from `at`'s day. */
function startsOnIsAllowed(startsOn: string, at: Date): boolean {
  if (!isRealDay(startsOn) || Number(startsOn.slice(8)) > LAST_START_DAY) return false;
  const earliest = dayOf(new Date(at.getTime() - MAX_DAYS_FROM_TODAY * DAY_MS));
  const latest = dayOf(new Date(at.getTime() + MAX_DAYS_FROM_TODAY * DAY_MS));
  return startsOn >= earliest && startsOn <= latest;
}

/** The same day of the next month, which every month has, as the day is 1 to 28 (request 23). */
function nextMonth(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const [nextYear, nextMonthNumber] = month === 12 ? [year + 1, 1] : [year, month + 1];
  return `${nextYear}-${String(nextMonthNumber).padStart(2, '0')}-${day.slice(8)}`;
}

/** A copy of a split as it was given, so that no caller and no snapshot shares its arrays. */
function copyOf(split: SplitInput): SplitInput {
  return JSON.parse(JSON.stringify(split)) as SplitInput;
}
