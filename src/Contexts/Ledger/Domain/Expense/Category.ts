import { IResult, Result } from '@Architecture/Domain';
import { InvalidCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/**
 * The categories an expense is filed under (request 24), in the order budgets are listed. An expense is `other` when no
 * category is given; the recurring expense keeps one for each of its expenses.
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

/** The category a command gives, or `other` when it gives none; a value that is not one of the list is refused (InvalidCategory). */
export function categoryOf(raw: string | undefined): IResult<Category> {
  if (raw === undefined) return Result.ok('other');
  const found = CATEGORIES.find(category => category === raw);
  return found ? Result.ok(found) : Result.fail(new InvalidCategory());
}
