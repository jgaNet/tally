import { Refusal } from '../refusal';

/**
 * The categories an expense, and a recurring expense, may have, in the order a group's budgets are listed.
 * An expense given none is `other`.
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

/** The category `text` names: a refusal (`422`) when it is none of the categories. */
export function categoryOf(text: string): Category {
  if (!(CATEGORIES as readonly string[]).includes(text)) {
    throw new Refusal(422, 'InvalidCategory', `The category must be one of ${CATEGORIES.join(', ')}.`);
  }
  return text as Category;
}
