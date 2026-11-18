import { IResult, NotAllowedException, Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import { ExpenseAmount } from './ExpenseAmount';
import { ExpenseDate } from './ExpenseDate';
import { ExpenseDescription } from './ExpenseDescription';
import {
  ExpenseChangedSinceReadException,
  ExpenseHasFormerMemberException,
  SplitMemberNotInGroupException,
} from './ExpenseExceptions';
import { ExpenseSnapshot } from './Expense';
import { OriginalAmount, OriginalSnapshot } from './OriginalAmount';
import { memberIdsOfSplit, Split, SplitRequest } from './Split';

/**
 * How an expense's amount is given (request 21): in the group's currency (`amount`), or paid in another currency, at the rate its
 * payer states (`original`). Exactly one of them; the transport refuses a body with neither or both, by shape.
 */
export type GivenAmount = { amount: number; original?: undefined } | { amount?: undefined; original: OriginalSnapshot };

/**
 * What a recording says: the expense as typed, how it is split (one of the three ways, request 7), the payer (the caller), and its
 * amount, in the group's currency or as paid in another (request 21).
 */
export type RecordExpenseCommand = {
  description: string;
  date: string;
  split: SplitRequest;
  payer: string;
} & GivenAmount;

/**
 * What a change says (feature 6): the expense as typed, how it is split (request 7), the caller, the version the caller read the
 * expense at, and its amount (request 21). The payer is not given: an edit never changes it.
 */
export type EditExpenseCommand = {
  by: string;
  description: string;
  date: string;
  split: SplitRequest;
  version: number;
} & GivenAmount;

/** What a deletion says: only who asks for it (the caller). */
export interface DeleteExpenseCommand {
  by: string;
}

/** The values a new expense is made of, once they are allowed: its amount in the group's currency, and the original if it was paid in another. */
export interface NewExpenseValues {
  description: ExpenseDescription;
  amount: ExpenseAmount;
  original: OriginalAmount | undefined;
  date: ExpenseDate;
  split: Split;
}

/** The facts about the group a recording or an edit is decided against: its members (in the order they joined) and its currency (request 21). */
export interface GroupFacts {
  memberIds: readonly string[];
  groupCurrency: string;
}

/**
 * What a decision on a stored expense is given (feature 6): the expense as it is stored, the members of its group (`memberIds`,
 * in the order they joined), its owner, and its currency (request 21). The caller is a member: the use case asked Groups before it decided.
 */
export interface StoredExpenseAccess extends GroupFacts {
  expense: ExpenseSnapshot;
  ownerId: string;
}

/** What a deletion is decided against: the same as an edit's, but the group's currency, which a deletion does not count in. */
export type DeleteAccess = Omit<StoredExpenseAccess, 'groupCurrency'>;

/** The message of a refusal to change an expense by someone who is neither its payer nor the group's owner. */
const MAY_NOT_CHANGE = "Only the expense's payer or the group's owner may change it";

/**
 * Recording an expense, as the storm decided it (ADR 5, ADR 6): a description of 1 to 100 characters, an amount from 1 to
 * 100 000 000, a real day of the calendar not after today in UTC, and a split (one of the three ways, request 7) whose
 * members are all members of the group (`memberIds`, given by the use case from Groups), each listed once, the payer among
 * them. It answers the validated values, with the split's shares computed once; the use case makes the expense from them
 * with `Expense.register`.
 */
export const decideRecordExpense: Decision<NewExpenseValues, RecordExpenseCommand, never, GroupFacts> = (
  facts,
  command,
  now,
) => newValues(command, facts, now);

/**
 * Editing an expense, as the storm decided it (feature 6): only its payer or the group's owner may, and any other member is
 * refused. An edit made from a version the expense has since left is refused by name, before anything else is decided
 * about it. Otherwise the new values are the same rules as a recording, with the payer the one who paid. The use case
 * gives the answer to `Expense.revise`, which keeps the payer and records `ExpenseEdited`.
 */
export const decideEditExpense: Decision<NewExpenseValues, EditExpenseCommand, never, StoredExpenseAccess> = (
  { expense, memberIds, ownerId, groupCurrency },
  command,
  now,
) => {
  if (!mayChange(expense.paidBy, ownerId, command.by))
    return Result.fail(new NotAllowedException('Ledger', MAY_NOT_CHANGE));
  if (command.version !== expense.version) return Result.fail(new ExpenseChangedSinceReadException());
  if (concernsFormerMember(expense, memberIds)) return Result.fail(new ExpenseHasFormerMemberException());
  return newValues(
    {
      ...givenAmountOf(command),
      description: command.description,
      date: command.date,
      split: command.split,
      payer: expense.paidBy,
    },
    { memberIds, groupCurrency },
    now,
  );
};

/**
 * Deleting an expense (feature 6): only its payer or the group's owner may; anyone else is refused. It answers no state:
 * the use case removes the expense, which records `ExpenseDeleted`.
 */
export const decideDeleteExpense: Decision<undefined, DeleteExpenseCommand, never, DeleteAccess> = (
  { expense, memberIds, ownerId },
  command,
) => {
  if (!mayChange(expense.paidBy, ownerId, command.by))
    return Result.fail(new NotAllowedException('Ledger', MAY_NOT_CHANGE));
  if (concernsFormerMember(expense, memberIds)) return Result.fail(new ExpenseHasFormerMemberException());
  return decided(undefined);
};

/** Whether the expense's payer or a member of its split is no longer a member of the group (request 9). */
const concernsFormerMember = (expense: ExpenseSnapshot, memberIds: readonly string[]): boolean =>
  [expense.paidBy, ...expense.shares.map(share => share.memberId)].some(member => !memberIds.includes(member));

/** The payer, and the group's owner, may change an expense; no one else. */
const mayChange = (payer: string, ownerId: string, by: string): boolean => by === payer || by === ownerId;

/** The amount as an edit or a recording says it, without what else it says. */
const givenAmountOf = (command: GivenAmount): GivenAmount =>
  command.original === undefined ? { amount: command.amount } : { original: command.original };

/**
 * The amount an expense is counted in, given as it was (request 21). An amount in the group's currency is checked as any amount is;
 * one paid in another is checked as an original amount (its currency, its amount, its rate), and its amount in the group's currency
 * is the original amount times the rate, rounded, checked the same way. The original is kept with the expense only when it was given.
 */
function moneyOf(given: GivenAmount, groupCurrency: string): IResult<Money> {
  if (given.original === undefined) {
    const amount = ExpenseAmount.create(given.amount);
    if (amount.isFailure()) return amount;
    return Result.ok({ amount: amount.data, original: undefined });
  }
  const original = OriginalAmount.create(given.original, groupCurrency);
  if (original.isFailure()) return original;
  const amount = original.data.groupExpenseAmount();
  if (amount.isFailure()) return amount;
  return Result.ok({ amount: amount.data, original: original.data });
}

/** An amount as a recording or an edit counts it: in the group's currency, and the original it was paid in, if it was. */
interface Money {
  amount: ExpenseAmount;
  original: OriginalAmount | undefined;
}

/** The rules a recording and an edit share, applied to what they say: the values as typed, the split among the members. */
function newValues(
  {
    description: rawDescription,
    date: rawDate,
    split: request,
    payer,
    ...given
  }: { description: string; date: string; split: SplitRequest; payer: string } & GivenAmount,
  { memberIds, groupCurrency }: GroupFacts,
  now: Date,
) {
  const description = ExpenseDescription.create(rawDescription);
  if (description.isFailure()) return description;
  const money = moneyOf(given as GivenAmount, groupCurrency);
  if (money.isFailure()) return money;
  const date = ExpenseDate.create(rawDate, now.toISOString().slice(0, 10));
  if (date.isFailure()) return date;
  if (memberIdsOfSplit(request).some(member => !memberIds.includes(member))) {
    return Result.fail(new SplitMemberNotInGroupException());
  }
  const split = Split.create({ amount: money.data.amount, request, payer });
  if (split.isFailure()) return split;
  return decided({
    description: description.data,
    amount: money.data.amount,
    original: money.data.original,
    date: date.data,
    split: split.data,
  });
}
