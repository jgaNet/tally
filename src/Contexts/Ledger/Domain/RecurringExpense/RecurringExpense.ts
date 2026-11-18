import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';

import {
  InvalidExpenseAmountException,
  InvalidExpenseDescriptionException,
  SplitMemberNotInGroupException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { isAmount, isDescription } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Split, SplitDraft, memberIdsOf } from '@Contexts/Ledger/Domain/Expense/Split';
import { InvalidRecurringStartsOnException } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpenseExceptions';

/** A start may be this many days before today, or after it (request 23). */
const START_WINDOW_DAYS = 365;
const DAY_MS = 86_400_000;

/** What a member asks to set up: the group, the payer (the caller), and the rest of the draft as the request carries it. */
export interface RecurringExpenseDraft {
  readonly groupId: string;
  readonly payerId: string;
  readonly description: string;
  readonly amount: number;
  readonly startsOn: string;
  readonly split: SplitDraft;
}

/** A recurring expense as the store keeps it: its split as it was given, its next day, and the version it is at. */
export interface RecurringExpenseSnapshot {
  readonly id: string;
  readonly groupId: string;
  readonly paidBy: string;
  readonly description: string;
  readonly amount: number;
  readonly startsOn: string;
  readonly next: string;
  readonly split: SplitDraft;
  readonly setUpAt: string;
  readonly version: number;
}

/** What a sweep decides for one recurring expense: it goes on, or it ended (its payer or a member of its split has left). */
export type SweepOutcome = 'kept' | 'ended';

/**
 * A recurring expense (request 23, the storm's RecurringExpense, ADR 18): an expense a member pays every month, whose expense the
 * background job records on its day of every month, from `startsOn` on. It keeps its split as it was given, not decided, since the
 * expense each day records decides it under the rule in force then (request 10). Its `next` is the day of the next expense it will
 * record. It is an aggregate root because `SetUpRecurringExpense` and `StopRecurringExpense` record facts, and the sweep records a
 * fact for each day that has come, and one that ends it. Its version is the one it was loaded at (AggregateRoot).
 */
export class RecurringExpense extends AggregateRoot {
  readonly #groupId: string;
  readonly #paidBy: string;
  readonly #description: string;
  readonly #amount: number;
  readonly #startsOn: string;
  #next: string;
  readonly #split: SplitDraft;
  readonly #setUpAt: string;

  private constructor(
    id: Id,
    groupId: string,
    paidBy: string,
    description: string,
    amount: number,
    startsOn: string,
    next: string,
    split: SplitDraft,
    setUpAt: string,
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
    this.#setUpAt = setUpAt;
  }

  /**
   * A set up: the description and the amount are an expense's own (1 to 100 characters, not only spaces; a whole number from 1 to
   * 100 000 000 of the group's currency), the start is a real day of the month from 1 to 28, no more than 365 days before today nor
   * after it (UTC, `now`), and the split is one the members of the group (`members`) may be in, the payer among them, as an expense's
   * split is decided. The identity is generated here (DOMAIN-IDENTITY), and the set up records `RecurringExpenseSetUp`. Pure.
   */
  static setUp(draft: RecurringExpenseDraft, members: readonly string[], now: Date): IResult<RecurringExpense> {
    const { groupId, payerId, description, amount, startsOn, split } = draft;
    if (!isDescription(description)) return Result.fail(new InvalidExpenseDescriptionException());
    if (!isAmount(amount)) return Result.fail(new InvalidExpenseAmountException());
    if (!isStartDay(startsOn, now)) return Result.fail(new InvalidRecurringStartsOnException());
    if (!memberIdsOf(split).every(memberId => members.includes(memberId))) {
      return Result.fail(new SplitMemberNotInGroupException());
    }
    const decided = Split.decide({ amount, payerId, split });
    if (decided.isFailure()) return Result.fail(decided.error);

    const id = Id.generate();
    const setUpAt = now.toISOString();
    const recurring = new RecurringExpense(
      id,
      groupId,
      payerId,
      description,
      amount,
      startsOn,
      startsOn,
      split,
      setUpAt,
      0,
    );
    recurring.record(
      RecurringExpenseSetUpEvent.set({
        recurringId: id.value,
        groupId,
        paidBy: payerId,
        startsOn,
        at: setUpAt,
      }),
    );
    return Result.ok(recurring);
  }

  /**
   * A recurring expense the store keeps, as it was last saved. Records nothing; throws on a snapshot that is not one the domain keeps.
   */
  static fromSnapshot(snapshot: RecurringExpenseSnapshot): RecurringExpense {
    return new RecurringExpense(
      new Id(snapshot.id),
      snapshot.groupId,
      snapshot.paidBy,
      snapshot.description,
      snapshot.amount,
      snapshot.startsOn,
      snapshot.next,
      snapshot.split,
      snapshot.setUpAt,
      snapshot.version,
    );
  }

  /**
   * A stop: no expense is recorded for it from now on, and the expenses it recorded stay. Who may stop it is the use case's to say.
   * Records `RecurringExpenseStopped`; the time is `now`. Pure.
   */
  stop(now: Date): void {
    this.record(
      RecurringExpenseStoppedEvent.set({
        recurringId: this._id.value,
        groupId: this.#groupId,
        at: now.toISOString(),
      }),
    );
  }

  /**
   * The background sweep's decision for this recurring expense (ADR 18). `members` are the group's current members, or `undefined` when
   * the group is not there: if the payer or a member of its split is not among them, it ends (`RecurringExpenseEnded`) and no expense is
   * recorded for it. Otherwise every day from `next` up to today (UTC, `now`) has come, and each records `RecurringExpenseDayCame`, with
   * the id of the expense that day stands for, generated here; `next` moves to the first day of the month after the last of them.
   * Records nothing on a day that has not come. Pure: the members and the time are given.
   */
  sweep(members: readonly string[] | undefined, now: Date): SweepOutcome {
    const at = now.toISOString();
    const concerned = [this.#paidBy, ...memberIdsOf(this.#split)];
    if (!members || !concerned.every(memberId => members.includes(memberId))) {
      this.record(
        RecurringExpenseEndedEvent.set({
          recurringId: this._id.value,
          groupId: this.#groupId,
          at,
        }),
      );
      return 'ended';
    }

    const today = dayOf(now);
    while (this.#next <= today) {
      this.record(
        RecurringExpenseDayCameEvent.set({
          recurringId: this._id.value,
          groupId: this.#groupId,
          expenseId: Id.generate().value,
          day: this.#next,
          paidBy: this.#paidBy,
          description: this.#description,
          amount: this.#amount,
          split: this.#split,
          at,
        }),
      );
      this.#next = nextMonthOf(this.#next);
    }
    return 'kept';
  }

  get groupId(): string {
    return this.#groupId;
  }

  get next(): string {
    return this.#next;
  }

  toSnapshot(): RecurringExpenseSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      paidBy: this.#paidBy,
      description: this.#description,
      amount: this.#amount,
      startsOn: this.#startsOn,
      next: this.#next,
      split: this.#split,
      setUpAt: this.#setUpAt,
      version: this.version,
    };
  }
}

/** The day (`YYYY-MM-DD`) of an instant, in UTC. */
export const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** The same day of the next month, the day of the month being 1 to 28 so that every month has it. */
export const nextMonthOf = (day: string): string => {
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  const next = month === 12 ? [year + 1, 1] : [year, month + 1];
  return `${next[0]}-${String(next[1]).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
};

/** A real day of the month from 1 to 28, no more than 365 days before today nor after it (UTC). */
const isStartDay = (raw: string, now: Date): boolean => {
  if (!/^\d{4}-\d{2}-(0[1-9]|1\d|2[0-8])$/.test(raw)) return false;
  const day = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== raw) return false;
  const today = new Date(`${dayOf(now)}T00:00:00.000Z`);
  const distance = Math.round((day.getTime() - today.getTime()) / DAY_MS);
  return Math.abs(distance) <= START_WINDOW_DAYS;
};

export type RecurringExpenseSetUpPayload = {
  recurringId: string;
  groupId: string;
  paidBy: string;
  startsOn: string;
  at: string;
};
export type RecurringExpenseStoppedPayload = { recurringId: string; groupId: string; at: string };
export type RecurringExpenseEndedPayload = { recurringId: string; groupId: string; at: string };
export type RecurringExpenseDayCamePayload = {
  recurringId: string;
  groupId: string;
  /** The id of the expense this day records, born here and carried, so that the recording builds on it (DOMAIN-IDENTITY). */
  expenseId: string;
  /** The day of the expense, `YYYY-MM-DD`. */
  day: string;
  paidBy: string;
  description: string;
  amount: number;
  split: SplitDraft;
  at: string;
};

/** The fact of a set up: which recurring expense, of which group, paid by whom, from which day. Made durable and published after the commit. */
export class RecurringExpenseSetUpEvent extends DomainEvent<RecurringExpenseSetUpPayload> {}

/** The fact of a stop: no expense is recorded for it from now on. Published after the commit. */
export class RecurringExpenseStoppedEvent extends DomainEvent<RecurringExpenseStoppedPayload> {}

/** The fact that the recurring expense ended, its payer or a member of its split having left: no expense is recorded for it. */
export class RecurringExpenseEndedEvent extends DomainEvent<RecurringExpenseEndedPayload> {}

/**
 * The fact that a day of a recurring expense has come: the expense of that day is recorded by the policy that reacts to it (ADR 18),
 * on the id the fact carries. It is made durable with the recurring expense's new `next`, in the sweep's transaction.
 */
export class RecurringExpenseDayCameEvent extends DomainEvent<RecurringExpenseDayCamePayload> {}
