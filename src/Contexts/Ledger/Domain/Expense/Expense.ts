import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';

import {
  OfferedRate,
  OriginalAmount,
  OriginalDraft,
  OriginalRecord,
} from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import { Share, Split, SplitDraft, SplitKind, memberIdsOf } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  ExpenseChangedException,
  ExpenseConcernsFormerMemberException,
  InvalidExpenseAmountException,
  InvalidExpenseDateException,
  InvalidExpenseDescriptionException,
  SplitMemberNotInGroupException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/**
 * What the amount of an expense is, as a member gives it (request 21): either `amount`, in the group's currency's hundredths, or
 * `original`, what was paid in another currency at the rate its payer states. Exactly one of the two; the group's currency
 * (`groupCurrency`, read through Ledger's port) is what an original is converted to.
 */
export interface AmountDraft {
  readonly amount?: number;
  readonly original?: OriginalDraft;
  readonly groupCurrency: string;
  /**
   * What the rates service offers for the original's currency to the group's on the expense's day (request 22), asked by the use case
   * when there is an original and read here. Absent for an expense in the group's currency; with an original and none given, no rate
   * is offered.
   */
  readonly offered?: OfferedRate;
}

/** What a member asks to record: the expense as the request carries it, its payer being the caller. */
export interface ExpenseDraft extends AmountDraft {
  readonly groupId: string;
  readonly description: string;
  readonly date: string;
  readonly payerId: string;
  readonly split: SplitDraft;
}

/** What a member asks to put in an expense's place: the whole of it, the payer and the group staying as they are. */
export interface EditDraft extends AmountDraft {
  readonly description: string;
  readonly date: string;
  readonly split: SplitDraft;
}

/**
 * An expense as the store keeps it: its shares included, in the order they were decided, the version it is at, and the
 * moment it was first recorded (`recordedAt`, an ISO instant), which no edit changes (the storm's hot spot: the lists order
 * by it on the same date).
 */
export interface ExpenseSnapshot {
  readonly id: string;
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly paidBy: string;
  readonly splitKind: SplitKind;
  readonly shares: readonly Share[];
  readonly recordedAt: string;
  readonly version: number;
  /** What the expense was paid in, when it was paid in another currency (request 21), at the rate kept; absent for an expense in the group's currency. */
  readonly original?: OriginalRecord;
}

/**
 * An expense a member paid for some members of a group, as the ledger keeps it (conventions/domain.yaml, the storm's Expense):
 * its description, its amount in the group's currency, the day it was spent, its payer, and its shares. It is an aggregate
 * root because `RecordExpense` records it and `ExpenseRecorded` announces it (the storm, decided before the code). It is
 * changed by `EditExpense`, which gives it again whole, from the version its author read, and deleted by `DeleteExpense`
 * (request 6, the storm's hot spots): the payer stays the one who paid, and the shares are computed again from what an edit
 * gives. Its version is the one it was loaded at (AggregateRoot); an edit from any other version is refused by this rule.
 */
export class Expense extends AggregateRoot {
  static readonly MAX_AMOUNT = 100_000_000;
  static readonly MAX_DESCRIPTION_LENGTH = 100;

  readonly #groupId: string;
  #description: string;
  #amount: number;
  #date: string;
  readonly #paidBy: string;
  #split: Split;
  readonly #recordedAt: string;
  #original: OriginalAmount | undefined;

  private constructor(
    id: Id,
    groupId: string,
    description: string,
    amount: number,
    date: string,
    paidBy: string,
    split: Split,
    recordedAt: string,
    version: number,
    original: OriginalAmount | undefined,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#description = description;
    this.#amount = amount;
    this.#date = date;
    this.#paidBy = paidBy;
    this.#split = split;
    this.#recordedAt = recordedAt;
    this.#original = original;
  }

  /**
   * A recording: the description is 1 to 100 characters and not only spaces, the amount a whole number from 1 to 100 000 000 in
   * the group's currency, or an original amount in another currency converted to it (request 21), the date a real day of the
   * calendar not after today in UTC (`now`), and the split one the members of the group (`members`, the group's current members)
   * may be in, each once, the payer among them. The shares are the `Split`'s, decided the way the split is given (equally, by
   * exact amounts, or by shares), the remainder to the member listed first. The identity is generated here (DOMAIN-IDENTITY), and
   * the recording records `ExpenseRecorded`. Pure: the members, the group's currency and the time are given, nothing is read.
   */
  static register(draft: ExpenseDraft, members: readonly string[], now: Date): IResult<Expense> {
    const { groupId, description, date, payerId, split: splitDraft } = draft;
    const checked = checkDraft({ ...draft, payerId, split: splitDraft }, members, now);
    if (checked.isFailure()) return Result.fail(checked.error);
    const { split, amount, original } = checked.data;

    const id = Id.generate();
    const expense = new Expense(id, groupId, description, amount, date, payerId, split, now.toISOString(), 0, original);
    expense.record(
      ExpenseRecordedEvent.set({
        expenseId: id.value,
        groupId,
        paidBy: payerId,
        amount,
        splitKind: split.kind,
        shares: split.shares.map(({ memberId, amount }) => ({ memberId, amount })),
        at: now.toISOString(),
      }),
    );
    return Result.ok(expense);
  }

  /**
   * An expense the store keeps, as it was last saved: its shares as they were decided, its version as it is stored. Records
   * nothing; throws on a snapshot that is not an expense the domain keeps.
   */
  static fromSnapshot(snapshot: ExpenseSnapshot): Expense {
    const split = Split.kept({
      kind: snapshot.splitKind,
      amount: snapshot.amount,
      payerId: snapshot.paidBy,
      shares: snapshot.shares,
    });
    const original = keptOriginal(snapshot.original, snapshot.amount);
    return new Expense(
      new Id(snapshot.id),
      snapshot.groupId,
      snapshot.description,
      snapshot.amount,
      snapshot.date,
      snapshot.paidBy,
      split,
      snapshot.recordedAt,
      snapshot.version,
      original,
    );
  }

  /**
   * An edit: the expense is given again whole, under the rules of a recording, with the members of its group (`members`) and
   * the payer it has. It is refused with `ExpenseChanged` when it changed since the version the edit was made from
   * (`fromVersion`), before anything else is looked at: the author reads it again and decides. The shares are computed again
   * from what the edit gives, in whichever of the three ways it splits them, and the amount is the one the edit gives: an edit
   * with an `amount` is in the group's currency, an edit with an `original` is in that currency at its rate (request 21). An
   * expense that concerns a member who has left the group (its payer, or one of its split) is refused with
   * `ExpenseConcernsFormerMember` (feature 9). Records `ExpenseEdited`; the time is `now`. Pure.
   */
  edit(draft: EditDraft, members: readonly string[], fromVersion: number, now: Date): IResult<void> {
    if (fromVersion !== this.version) return Result.fail(new ExpenseChangedException());
    if (!this.#concernsOnly(members)) return Result.fail(new ExpenseConcernsFormerMemberException());

    const checked = checkDraft({ ...draft, payerId: this.#paidBy, split: draft.split }, members, now);
    if (checked.isFailure()) return Result.fail(checked.error);
    const { split, amount, original } = checked.data;

    this.#description = draft.description;
    this.#amount = amount;
    this.#date = draft.date;
    this.#split = split;
    this.#original = original;
    this.record(
      ExpenseEditedEvent.set({
        expenseId: this._id.value,
        groupId: this.#groupId,
        paidBy: this.#paidBy,
        amount: this.#amount,
        splitKind: this.#split.kind,
        at: now.toISOString(),
      }),
    );
    return Result.ok(undefined);
  }

  /**
   * A deletion: the expense is no longer there for anyone (the store takes its rows, and its balances, out in the same
   * transaction). Who may delete it is the use case's to say. An expense that concerns a member who has left the group is
   * refused with `ExpenseConcernsFormerMember` (feature 9), given the group's current members (`members`). Records
   * `ExpenseDeleted`; the time is `now`.
   */
  delete(members: readonly string[], now: Date): IResult<void> {
    if (!this.#concernsOnly(members)) return Result.fail(new ExpenseConcernsFormerMemberException());

    this.record(
      ExpenseDeletedEvent.set({
        expenseId: this._id.value,
        groupId: this.#groupId,
        at: now.toISOString(),
      }),
    );
    return Result.ok(undefined);
  }

  /**
   * Whether the payer and each member of the split are still members of the group (`members`, its current members): an
   * expense of a member who left keeps its shares, and can no longer change, so the group's balances still add up to 0.
   */
  #concernsOnly(members: readonly string[]): boolean {
    return [this.#paidBy, ...this.#split.shares.map(share => share.memberId)].every(memberId =>
      members.includes(memberId),
    );
  }

  toSnapshot(): ExpenseSnapshot {
    const original = this.#original;
    return {
      id: this._id.value,
      groupId: this.#groupId,
      description: this.#description,
      amount: this.#amount,
      date: this.#date,
      paidBy: this.#paidBy,
      splitKind: this.#split.kind,
      shares: this.#split.shares,
      recordedAt: this.#recordedAt,
      version: this.version,
      ...(original && { original: { currency: original.currency, amount: original.amount, rate: original.rate } }),
    };
  }
}

/** The original amount an expense keeps, or none for an expense in the group's currency; throws when it does not match the amount. */
const keptOriginal = (original: OriginalRecord | undefined, amount: number): OriginalAmount | undefined => {
  if (original === undefined) return undefined;
  const kept = OriginalAmount.kept(original);
  if (kept.toGroupAmount() !== BigInt(amount)) {
    throw new Error(`The original amount of an expense of ${amount} is corrupted`);
  }
  return kept;
};

/** What a recording or an edit decides: the split its shares are decided by, the amount in the group's currency, and the original. */
interface Checked {
  readonly split: Split;
  readonly amount: number;
  readonly original: OriginalAmount | undefined;
}

/**
 * What a recording and an edit both must hold (the storm's split and the rules of requests 4, 7 and 21): the description, the
 * amount (in the group's currency, or an original converted to it), the date, and the split the group's members may be in, the
 * payer among them. Returns what was decided, the split in the way it was given.
 */
const checkDraft = (
  { description, date, payerId, split, ...money }: Omit<ExpenseDraft, 'groupId'>,
  members: readonly string[],
  now: Date,
): IResult<Checked> => {
  if (!isDescription(description)) return Result.fail(new InvalidExpenseDescriptionException());
  const amount = amountOf(money);
  if (amount.isFailure()) return Result.fail(amount.error);
  if (!isSpentBy(date, now)) return Result.fail(new InvalidExpenseDateException());
  if (!memberIdsOf(split).every(memberId => members.includes(memberId))) {
    return Result.fail(new SplitMemberNotInGroupException());
  }
  const decided = Split.decide({ amount: amount.data.amount, payerId, split });
  if (decided.isFailure()) return Result.fail(decided.error);
  return Result.ok({ split: decided.data, amount: amount.data.amount, original: amount.data.original });
};

/**
 * The amount an expense is in the group's currency, given as `amount` or as an original (request 21): exactly one of the two. An
 * original is decided by its own value, and its amount in the group's currency must be from 1 to 100 000 000, as any amount is.
 */
const amountOf = ({
  amount,
  original,
  groupCurrency,
  offered,
}: AmountDraft): IResult<{ amount: number; original: OriginalAmount | undefined }> => {
  if (original === undefined) {
    if (amount === undefined || !isAmount(amount)) return Result.fail(new InvalidExpenseAmountException());
    return Result.ok({ amount, original: undefined });
  }
  if (amount !== undefined) return Result.fail(new InvalidExpenseAmountException());

  const decided = OriginalAmount.decide(original, groupCurrency, offered ?? { kind: 'none' });
  if (decided.isFailure()) return Result.fail(decided.error);
  const converted = decided.data.toGroupAmount();
  if (converted < 1n || converted > BigInt(Expense.MAX_AMOUNT)) return Result.fail(new InvalidExpenseAmountException());
  return Result.ok({ amount: Number(converted), original: decided.data });
};

/** The description is 1 to 100 characters (counted as characters, not bytes), and not only spaces. */
const isDescription = (raw: string): boolean => {
  const length = [...raw].length;
  return raw.trim() !== '' && length >= 1 && length <= Expense.MAX_DESCRIPTION_LENGTH;
};

/** A whole number of units from 1 to 100 000 000. */
const isAmount = (raw: number): boolean => Number.isInteger(raw) && raw >= 1 && raw <= Expense.MAX_AMOUNT;

/** A real day of the calendar (`YYYY-MM-DD`, round-tripped so that 2026-02-30 is refused), not after today in UTC. */
const isSpentBy = (raw: string, now: Date): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const day = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== raw) return false;
  return raw <= now.toISOString().slice(0, 10);
};

export type ExpenseRecordedPayload = {
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  splitKind: SplitKind;
  shares: Share[];
  at: string;
};
export type ExpenseEditedPayload = {
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  splitKind: SplitKind;
  at: string;
};
export type ExpenseDeletedPayload = { expenseId: string; groupId: string; at: string };

/**
 * The fact of a recording: which expense, of which group, paid by whom, for how much, and when it was recorded. It is made
 * durable with the expense and published after the commit. Ledger's own handler translates it into the integration event
 * ExpenseRecorded, which Notifications reacts to (ADR 13); it carries the shares, so the translation reads nothing back.
 */
export class ExpenseRecordedEvent extends DomainEvent<ExpenseRecordedPayload> {}

/** The fact of an edit: the expense as it now stands in its amount and payer, and when it was edited. Published after the commit. */
export class ExpenseEditedEvent extends DomainEvent<ExpenseEditedPayload> {}

/** The fact of a deletion: which expense, of which group, and when it was deleted. Published after the commit. */
export class ExpenseDeletedEvent extends DomainEvent<ExpenseDeletedPayload> {}
