import { IResult, Result } from '@Architecture/Domain';

import { InvalidExpenseCategoryException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/**
 * What an expense is spent on (request 24): one of these eight. A budget is set per category, and what a month spends is counted per
 * category. `other` is the category of an expense that gives none, and of every expense kept before request 24.
 */
export const CATEGORIES = [
  'groceries',
  'rent',
  'utilities',
  'transport',
  'food',
  'travel',
  'leisure',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Whether a raw value is one of the eight categories. */
export const isCategory = (raw: unknown): raw is Category =>
  typeof raw === 'string' && (CATEGORIES as readonly string[]).includes(raw);

/**
 * The category a recording or an edit gives: the one given, `other` when none is given (`undefined`), and a refusal when what is given is
 * not one of the eight (`422`, the domain's to say: the body only says it is a string).
 */
export const categoryGiven = (raw: string | undefined): IResult<Category> => {
  if (raw === undefined) return Result.ok('other');
  if (!isCategory(raw)) return Result.fail(new InvalidExpenseCategoryException());
  return Result.ok(raw);
};

/** The month (`YYYY-MM`, UTC) of a day (`YYYY-MM-DD`). */
export const monthOfDay = (day: string): string => day.slice(0, 7);
