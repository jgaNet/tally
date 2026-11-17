import { Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import { ExpenseAmount } from './ExpenseAmount';
import { ExpenseDate } from './ExpenseDate';
import { ExpenseDescription } from './ExpenseDescription';
import { SplitMemberNotInGroupException } from './ExpenseExceptions';
import { Split } from './Split';

/** What a recording says: the expense as typed, the members it is split between in order, and the payer (the caller). */
export interface RecordExpenseCommand {
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
  payer: string;
}

/** The values a new expense is made of, once they are allowed. */
export interface NewExpenseValues {
  description: ExpenseDescription;
  amount: ExpenseAmount;
  date: ExpenseDate;
  split: Split;
}

/**
 * Recording an expense, as the storm decided it (ADR 5): a description of 1 to 100 characters, an amount from 1 to
 * 100 000 000, a real day of the calendar not after today in UTC, and a split whose members are all members of the group
 * (`memberIds`, given by the use case from Groups), each listed once, the payer among them. It answers the validated
 * values, with the split's shares computed once; the use case makes the expense from them with `Expense.register`.
 */
export const decideRecordExpense: Decision<
  NewExpenseValues,
  RecordExpenseCommand,
  never,
  { memberIds: readonly string[] }
> = ({ memberIds }, command, now) => {
  const description = ExpenseDescription.create(command.description);
  if (description.isFailure()) return description;
  const amount = ExpenseAmount.create(command.amount);
  if (amount.isFailure()) return amount;
  const date = ExpenseDate.create(command.date, now.toISOString().slice(0, 10));
  if (date.isFailure()) return date;
  if (command.splitBetween.some(member => !memberIds.includes(member))) {
    return Result.fail(new SplitMemberNotInGroupException());
  }
  const split = Split.create({ amount: amount.data, memberIds: command.splitBetween, payer: command.payer });
  if (split.isFailure()) return split;
  return decided({ description: description.data, amount: amount.data, date: date.data, split: split.data });
};
