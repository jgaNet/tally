import { NotAllowedException, Result } from '@Architecture/Domain';
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
import { memberIdsOfSplit, Split, SplitRequest } from './Split';

/**
 * What a recording says: the expense as typed, how it is split (one of the three ways, request 7), and the payer (the caller).
 */
export interface RecordExpenseCommand {
  description: string;
  amount: number;
  date: string;
  split: SplitRequest;
  payer: string;
}

/**
 * What a change says (feature 6): the expense as typed, how it is split (request 7), the caller, and the version the caller
 * read the expense at. The payer is not given: an edit never changes it.
 */
export interface EditExpenseCommand {
  by: string;
  description: string;
  amount: number;
  date: string;
  split: SplitRequest;
  version: number;
}

/** What a deletion says: only who asks for it (the caller). */
export interface DeleteExpenseCommand {
  by: string;
}

/** The values a new expense is made of, once they are allowed. */
export interface NewExpenseValues {
  description: ExpenseDescription;
  amount: ExpenseAmount;
  date: ExpenseDate;
  split: Split;
}

/**
 * What a decision on a stored expense is given (feature 6): the expense as it is stored, the members of its group (`memberIds`,
 * in the order they joined), and its owner. The caller is a member: the use case asked Groups before it decided.
 */
export interface StoredExpenseAccess {
  expense: ExpenseSnapshot;
  memberIds: readonly string[];
  ownerId: string;
}

/** The message of a refusal to change an expense by someone who is neither its payer nor the group's owner. */
const MAY_NOT_CHANGE = "Only the expense's payer or the group's owner may change it";

/**
 * Recording an expense, as the storm decided it (ADR 5, ADR 6): a description of 1 to 100 characters, an amount from 1 to
 * 100 000 000, a real day of the calendar not after today in UTC, and a split (one of the three ways, request 7) whose
 * members are all members of the group (`memberIds`, given by the use case from Groups), each listed once, the payer among
 * them. It answers the validated values, with the split's shares computed once; the use case makes the expense from them
 * with `Expense.register`.
 */
export const decideRecordExpense: Decision<
  NewExpenseValues,
  RecordExpenseCommand,
  never,
  { memberIds: readonly string[] }
> = ({ memberIds }, command, now) => newValues(command, memberIds, now);

/**
 * Editing an expense, as the storm decided it (feature 6): only its payer or the group's owner may, and any other member is
 * refused. An edit made from a version the expense has since left is refused by name, before anything else is decided
 * about it. Otherwise the new values are the same rules as a recording, with the payer the one who paid. The use case
 * gives the answer to `Expense.revise`, which keeps the payer and records `ExpenseEdited`.
 */
export const decideEditExpense: Decision<NewExpenseValues, EditExpenseCommand, never, StoredExpenseAccess> = (
  { expense, memberIds, ownerId },
  command,
  now,
) => {
  if (!mayChange(expense.paidBy, ownerId, command.by))
    return Result.fail(new NotAllowedException('Ledger', MAY_NOT_CHANGE));
  if (command.version !== expense.version) return Result.fail(new ExpenseChangedSinceReadException());
  if (concernsFormerMember(expense, memberIds)) return Result.fail(new ExpenseHasFormerMemberException());
  return newValues(
    {
      description: command.description,
      amount: command.amount,
      date: command.date,
      split: command.split,
      payer: expense.paidBy,
    },
    memberIds,
    now,
  );
};

/**
 * Deleting an expense (feature 6): only its payer or the group's owner may; anyone else is refused. It answers no state:
 * the use case removes the expense, which records `ExpenseDeleted`.
 */
export const decideDeleteExpense: Decision<undefined, DeleteExpenseCommand, never, StoredExpenseAccess> = (
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

/** The rules a recording and an edit share, applied to what they say: the values as typed, the split among the members. */
function newValues(
  {
    description: rawDescription,
    amount: rawAmount,
    date: rawDate,
    split: request,
    payer,
  }: { description: string; amount: number; date: string; split: SplitRequest; payer: string },
  memberIds: readonly string[],
  now: Date,
) {
  const description = ExpenseDescription.create(rawDescription);
  if (description.isFailure()) return description;
  const amount = ExpenseAmount.create(rawAmount);
  if (amount.isFailure()) return amount;
  const date = ExpenseDate.create(rawDate, now.toISOString().slice(0, 10));
  if (date.isFailure()) return date;
  if (memberIdsOfSplit(request).some(member => !memberIds.includes(member))) {
    return Result.fail(new SplitMemberNotInGroupException());
  }
  const split = Split.create({ amount: amount.data, request, payer });
  if (split.isFailure()) return split;
  return decided({ description: description.data, amount: amount.data, date: date.data, split: split.data });
}
