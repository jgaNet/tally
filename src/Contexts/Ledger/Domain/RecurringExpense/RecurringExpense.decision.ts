import { NotAllowedException, Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';
import { AccountSuspendedException, GroupArchivedException } from '@SharedKernel/Domain';

import { ExpenseAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import { categoryOf, ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';
import { ExpenseDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseDescription';
import { SplitMemberNotInGroupException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { memberIdsOfSplit, Split, SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

import { occurrencesUpTo, startsOnOf } from './RecurringDay';
import { RecurringExpenseSnapshot } from './RecurringExpense';

/** What a member sets up: the description, the amount in the group's currency, `startsOn`, the split as given, and the caller who pays. */
export interface SetUpRecurringExpenseCommand {
  description: string;
  amount: number;
  startsOn: string;
  split: SplitRequest;
  payer: string;
  /** What its expenses are for (request 24); `other` when none is given. */
  category?: string;
}

/** The members of the group, as the caller may see them: every split member must be one of them. */
export interface SetUpFacts {
  memberIds: readonly string[];
  /** Whether the group is archived (request 27): then no recurring expense is set up in it. */
  archived: boolean;
  /** Whether the payer, the caller, is suspended (request 34): then it sets up no recurring expense, in any group. */
  suspended: boolean;
}

/** The values a recurring expense is set up with, once they are allowed: the split is kept as it was given. */
export interface SetUpValues {
  description: string;
  amount: number;
  startsOn: string;
  split: SplitRequest;
  payer: string;
  category: ExpenseCategory;
}

/**
 * Setting up a recurring expense (request 23): the description and the amount as an expense's are checked, `startsOn` is a real day
 * whose day of the month is from 1 to 28 and no more than 365 days from today, and the split is one of the three ways, whose members
 * are all members of the group, each listed once, the payer among them (the same rules as an expense's, request 4 and request 7).
 */
export const decideSetUpRecurringExpense: Decision<SetUpValues, SetUpRecurringExpenseCommand, never, SetUpFacts> = (
  { memberIds, archived, suspended },
  command,
  now,
) => {
  if (archived) return Result.fail(new GroupArchivedException());
  if (suspended) return Result.fail(new AccountSuspendedException());
  const description = ExpenseDescription.create(command.description);
  if (description.isFailure()) return description;
  const amount = ExpenseAmount.create(command.amount);
  if (amount.isFailure()) return amount;
  const startsOn = startsOnOf(command.startsOn, now.toISOString().slice(0, 10));
  if (startsOn.isFailure()) return startsOn;
  if (memberIdsOfSplit(command.split).some(member => !memberIds.includes(member))) {
    return Result.fail(new SplitMemberNotInGroupException());
  }
  // The split is checked now, as an expense's is: its shape, its payer among its members, and the amounts it gives.
  const split = Split.create({ amount: amount.data, request: command.split, payer: command.payer });
  if (split.isFailure()) return split;
  const category = categoryOf(command.category);
  if (category.isFailure()) return category;
  return decided({
    description: description.data.value,
    amount: amount.data.value,
    startsOn: startsOn.data,
    split: command.split,
    payer: command.payer,
    category: category.data,
  });
};

/** What a background run sees of a recurring expense: its stored state, and the members of its group if its payer may ask for them. */
export interface SweepGiven {
  recurring: RecurringExpenseSnapshot;
  /** The members of the group, `undefined` when its payer is not one of them (or the group is not there). */
  memberIds: readonly string[] | undefined;
  /** Whether the group is archived (request 27): then the background job records nothing in it, and leaves the recurring expense as it is. */
  archived: boolean;
  /** Whether the payer is suspended (request 34): then the background job records nothing for it, and its days wait, unmoved, until it is reinstated. */
  suspended: boolean;
}

/** What a run decides: the recurring expense has ended, or the days it falls on up to today, each of which records an expense. */
export type SweepOutcome = { kind: 'ended' } | { kind: 'due'; days: string[] };

/**
 * One run of the background job over a recurring expense (request 23): when its payer or a member of its split is no longer a member
 * of the group, it has ended, and no expense is recorded for it; otherwise each day it falls on up to today (the UTC day of the run),
 * from its next day on, is a day that came. A run that finds nothing due decides nothing.
 */
export const decideSweepRecurringExpense: Decision<SweepOutcome, undefined, never, SweepGiven> = (
  { recurring, memberIds, archived, suspended },
  _command,
  now,
) => {
  if (archived) return decided({ kind: 'due', days: [] });
  const concerned = [recurring.paidBy, ...memberIdsOfSplit(recurring.split)];
  if (memberIds === undefined || !concerned.every(member => memberIds.includes(member))) {
    return decided({ kind: 'ended' });
  }
  if (suspended) return decided({ kind: 'due', days: [] });
  return decided({ kind: 'due', days: occurrencesUpTo(recurring.next, now.toISOString().slice(0, 10)) });
};

/** Who stops a recurring expense: its payer or the group's owner, and no one else. */
export interface StopRecurringExpenseCommand {
  by: string;
}

/** The payer and the owner of the group, against whom the caller is checked. */
export interface StopGiven {
  paidBy: string;
  ownerId: string;
  /** Whether the group is archived (request 27): then no recurring expense is stopped in it. */
  archived: boolean;
}

/** Stopping a recurring expense (request 23): by its payer or the group's owner; any other member is refused. */
export const decideStopRecurringExpense: Decision<undefined, StopRecurringExpenseCommand, never, StopGiven> = (
  { paidBy, ownerId, archived },
  { by },
) => {
  if (archived) return Result.fail(new GroupArchivedException());
  if (by !== paidBy && by !== ownerId) {
    return Result.fail(
      new NotAllowedException('Ledger', "Only the recurring expense's payer or the group's owner may stop it"),
    );
  }
  return decided(undefined);
};
