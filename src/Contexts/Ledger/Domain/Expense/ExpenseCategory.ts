import { IResult, Result } from '@Architecture/Domain';

import { InvalidExpenseCategoryException } from './ExpenseExceptions';

/** What an expense was for (request 24), in the order a group's budgets are read in. */
export const EXPENSE_CATEGORIES = [
  'groceries',
  'rent',
  'utilities',
  'transport',
  'food',
  'travel',
  'leisure',
  'other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** The category of an expense that is given none, and of every expense recorded before request 24. */
export const DEFAULT_CATEGORY: ExpenseCategory = 'other';

/** Whether `raw` is one of the eight categories. */
export const isExpenseCategory = (raw: unknown): raw is ExpenseCategory =>
  typeof raw === 'string' && (EXPENSE_CATEGORIES as readonly string[]).includes(raw);

/** The category as given: one of the eight, or `other` when none is given. Anything else is refused. */
export const categoryOf = (raw: string | undefined): IResult<ExpenseCategory> => {
  if (raw === undefined) return Result.ok(DEFAULT_CATEGORY);
  return isExpenseCategory(raw) ? Result.ok(raw) : Result.fail(new InvalidExpenseCategoryException());
};
