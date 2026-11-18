/** The categories an expense may have. An expense given none has `other`, as do the expenses recorded before categories. */
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

/** Whether the text names one of the categories. */
export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}
