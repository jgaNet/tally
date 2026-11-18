/**
 * What an expense is for (request 24, docs/adr/0023): one of eight categories, in the order the budgets are listed in. An expense
 * given none is `other`, and so are the expenses recorded before the request.
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

/** The category of an expense given none, and of the expenses recorded before categories. */
export const DEFAULT_CATEGORY: Category = 'other';

/** Whether `raw` is one of the categories, by its name exactly. */
export function isCategory(raw: unknown): raw is Category {
  return typeof raw === 'string' && (CATEGORIES as readonly string[]).includes(raw);
}
