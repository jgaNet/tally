import { Exception } from '@Architecture/Domain';

/**
 * The categories an expense may be in (request 24): one of these eight. A recurring expense keeps one for each expense
 * it records (request 23).
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

/** The category of an expense none is given for, and of every expense recorded before categories existed. */
export const DEFAULT_CATEGORY: Category = 'other';

/** Whether a value is one of the categories. */
export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

/** The category given is not one of the eight. */
export class InvalidCategoryException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidCategory',
      message: 'The category is one of groceries, rent, utilities, transport, food, travel, leisure or other',
    });
  }
}
