/**
 * The categories an expense may have, in the order the budgets of a group list them. An expense given none, and every
 * expense recorded before categories, is `other`.
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

export const DEFAULT_CATEGORY: Category = 'other';

/** The categories as a list of SQL string literals, for the schema's checks. */
export const CATEGORY_SQL_LIST = CATEGORIES.map(category => `'${category}'`).join(', ');

/** True when `text` is one of the categories. */
export function isCategory(text: string): text is Category {
  return (CATEGORIES as readonly string[]).includes(text);
}
