import { Refusal } from '../refusal';
import { charLength } from '../text';

/** The largest amount an expense can have, in hundredths of the group's currency. */
export const MAX_AMOUNT = 100_000_000;

export interface ExpenseInput {
  description: string;
  /** In hundredths of the group's currency. */
  amount: number;
  /** A day of the calendar, written `YYYY-MM-DD`. */
  date: string;
  /** The account ids of the members the expense is split between, in the order chosen. */
  splitBetween: string[];
}

export interface ValidExpense {
  /** Trimmed. */
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
}

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `text` is a day that exists in the calendar: `2026-02-30` is not one. */
function isRealDay(text: string): boolean {
  if (!DAY_SHAPE.test(text)) {
    return false;
  }
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Today's date in UTC, as `YYYY-MM-DD`. */
export const todayInUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * Checks a new expense. `groupMembers` are the account ids of the group's members and `payerId` is
 * the member who records it. Refusals are `422`: the body had the right shape, a value is not allowed.
 */
export function validateExpense(input: ExpenseInput, groupMembers: ReadonlySet<string>, payerId: string): ValidExpense {
  const description = input.description.trim();
  if (charLength(description) < 1 || charLength(description) > 100) {
    throw new Refusal(
      422,
      'InvalidDescription',
      'The description must have between 1 and 100 characters, not only spaces.',
    );
  }

  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_AMOUNT) {
    throw new Refusal(422, 'InvalidAmount', `The amount must be a whole number from 1 to ${MAX_AMOUNT}.`);
  }

  if (!isRealDay(input.date) || input.date > todayInUtc()) {
    throw new Refusal(
      422,
      'InvalidDate',
      'The date must be a day of the calendar, written YYYY-MM-DD, and not after today (UTC).',
    );
  }

  const { splitBetween } = input;
  if (splitBetween.length === 0 || new Set(splitBetween).size !== splitBetween.length) {
    throw new Refusal(422, 'InvalidSplit', 'The expense must be split between at least one member, each listed once.');
  }
  if (!splitBetween.every(memberId => groupMembers.has(memberId))) {
    throw new Refusal(422, 'NotAMember', 'Every member of the split must be a member of the group.');
  }
  if (!splitBetween.includes(payerId)) {
    throw new Refusal(422, 'PayerNotInSplit', 'The member who paid must be one of the members of the split.');
  }

  return { description, amount: input.amount, date: input.date, splitBetween: [...splitBetween] };
}
