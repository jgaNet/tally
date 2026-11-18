import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The categories of an expense, in the order a budget is listed in (request 24). */
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

export type CategoryName = (typeof CATEGORIES)[number];

/** What an expense is for: one of the eight categories, `other` when none is given (request 24). */
export class Category extends ValueObject<CategoryName> {
  private constructor(name: CategoryName) {
    super(name);
  }

  /** The category given, or `other` when none is; any other word is refused. */
  static create(raw?: string | null): IResult<Category> {
    if (raw === undefined || raw === null) return Result.ok(new Category('other'));
    if (!(CATEGORIES as readonly string[]).includes(raw)) return Result.fail(new InvalidCategory());
    return Result.ok(new Category(raw as CategoryName));
  }

  /** A category as it was kept: any other word is corrupted data. */
  static restore(raw: string): Category {
    const made = Category.create(raw);
    if (made.isFailure()) throw new Error(`The category ${raw} is corrupted`);
    return made.data;
  }
}
