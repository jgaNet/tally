import { Refusal } from '../refusal';
import { charLength } from '../text';

/** The largest amount an expense can have, in hundredths of the group's currency. */
export const MAX_AMOUNT = 100_000_000;

/** How an expense is split: equally, by exact amounts, or by shares. */
export type SplitKind = 'equal' | 'exact' | 'shares';

/** The split as a request gives it: exactly one of the three ways. */
export type SplitInput =
  | {
      kind: 'equal';
      /** The account ids of the members the expense is split between, in the order chosen. */
      splitBetween: string[];
    }
  | {
      kind: 'exact';
      /** Each member with the exact amount of their share, in hundredths. */
      splitExactly: { memberId: string; amount: number }[];
    }
  | {
      kind: 'shares';
      /** Each member with a whole number of shares, at least 1. */
      splitByShares: { memberId: string; shares: number }[];
    };

export interface ExpenseInput {
  description: string;
  /** In hundredths of the group's currency. */
  amount: number;
  /** A day of the calendar, written `YYYY-MM-DD`. */
  date: string;
  split: SplitInput;
}

export interface ValidExpense {
  /** Trimmed. */
  description: string;
  amount: number;
  date: string;
  split: SplitInput;
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

  const split = validateSplit(input.split, input.amount, groupMembers, payerId);
  return { description, amount: input.amount, date: input.date, split };
}

/** The members a split names, in the order given. */
export function memberIdsInSplit(split: SplitInput): string[] {
  switch (split.kind) {
    case 'equal':
      return split.splitBetween;
    case 'exact':
      return split.splitExactly.map(share => share.memberId);
    case 'shares':
      return split.splitByShares.map(share => share.memberId);
  }
}

/**
 * Checks a split of `amount`: its members are the group's, each listed once, the payer among them;
 * then its own values. Returns a copy of it, in the order given.
 */
function validateSplit(
  split: SplitInput,
  amount: number,
  groupMembers: ReadonlySet<string>,
  payerId: string,
): SplitInput {
  const memberIds = memberIdsInSplit(split);
  if (memberIds.length === 0 || new Set(memberIds).size !== memberIds.length) {
    throw new Refusal(422, 'InvalidSplit', 'The expense must be split between at least one member, each listed once.');
  }
  if (!memberIds.every(memberId => groupMembers.has(memberId))) {
    throw new Refusal(422, 'NotAMember', 'Every member of the split must be a member of the group.');
  }
  if (!memberIds.includes(payerId)) {
    throw new Refusal(422, 'PayerNotInSplit', 'The member who paid must be one of the members of the split.');
  }

  switch (split.kind) {
    case 'equal':
      return { kind: 'equal', splitBetween: [...split.splitBetween] };
    case 'exact': {
      for (const share of split.splitExactly) {
        if (!Number.isInteger(share.amount) || share.amount < 0 || share.amount > MAX_AMOUNT) {
          throw new Refusal(422, 'InvalidShareAmount', 'Each exact amount must be a whole number, 0 or more.');
        }
      }
      const total = split.splitExactly.reduce((sum, share) => sum + share.amount, 0);
      if (total !== amount) {
        throw new Refusal(422, 'SharesDoNotAddUp', 'The exact amounts must add up to the amount of the expense.');
      }
      return { kind: 'exact', splitExactly: split.splitExactly.map(({ memberId, amount }) => ({ memberId, amount })) };
    }
    case 'shares': {
      for (const share of split.splitByShares) {
        if (!Number.isInteger(share.shares) || share.shares < 1) {
          throw new Refusal(422, 'InvalidShares', 'Each member must have at least 1 share, a whole number.');
        }
      }
      return {
        kind: 'shares',
        splitByShares: split.splitByShares.map(({ memberId, shares }) => ({ memberId, shares })),
      };
    }
  }
}
