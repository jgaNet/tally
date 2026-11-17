import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { findGroupOfMember, membersOfGroup } from './groups';
import { Refusal } from './refusal';
import { characters } from './text';
import { inTransaction } from './transactions';

/** A description has 1 to this many characters. */
const MAX_DESCRIPTION_LENGTH = 100;
/** An amount is in hundredths of the group's currency (as every amount of a group is), from 1 to 100 000 000. */
export const MIN_AMOUNT = 1;
export const MAX_AMOUNT = 100_000_000;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** One member's part of an expense. */
export interface Share {
  readonly memberId: string;
  readonly amount: number;
}

/** What the application knows of an expense, as a member of its group sees it. `date` is a `YYYY-MM-DD` day. */
export interface Expense {
  readonly id: string;
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly paidBy: string;
  /** The shares, in the order the split was given. */
  readonly shares: readonly Share[];
}

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
}

interface ShareRow {
  member_id: string;
  amount: number;
}

/**
 * Divides `amount` equally between `memberIds`, in their order: each share is the amount divided by
 * their number, rounded down; the remainder, less than their number, goes whole to the payer's share.
 * The shares add up to `amount` exactly. `payerId` is one of `memberIds`.
 */
export function equalShares(amount: number, memberIds: readonly string[], payerId: string): Share[] {
  const count = memberIds.length;
  const remainder = amount % count;
  const each = (amount - remainder) / count;
  return memberIds.map(memberId => ({
    memberId,
    amount: memberId === payerId ? each + remainder : each,
  }));
}

/** True when `text` is a real day of the calendar, written `YYYY-MM-DD`. */
function isCalendarDay(text: string): boolean {
  if (!DATE_SHAPE.test(text)) return false;
  const instant = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === text;
}

/** Today's day in UTC, `YYYY-MM-DD`. */
function todayInUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface RecordExpenseInput {
  readonly groupId: string;
  /** The member who records the expense: its payer. */
  readonly payerId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly splitBetween: readonly string[];
}

/**
 * Records an expense the payer paid in the group, split equally between the members named in
 * `splitBetween`, and returns its id. Refused with `404` when the payer is not a member of the group;
 * otherwise with `422` when the description, amount, date or split breaks a rule (the error names it).
 * The description is stored trimmed of surrounding spaces.
 */
export function recordExpense(db: DatabaseSync, input: RecordExpenseInput): string {
  const { groupId, payerId, description, amount, date, splitBetween } = input;
  const id = randomUUID();
  inTransaction(db, () => {
    if (!findGroupOfMember(db, payerId, groupId)) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    const trimmedDescription = description.trim();
    if (characters(description) > MAX_DESCRIPTION_LENGTH || trimmedDescription.length === 0) {
      throw new Refusal(
        422,
        'DescriptionIsInvalid',
        `The description must have 1 to ${MAX_DESCRIPTION_LENGTH} characters and not be only spaces.`,
      );
    }
    if (!Number.isInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      throw new Refusal(
        422,
        'AmountIsInvalid',
        `The amount must be a whole number from ${MIN_AMOUNT} to ${MAX_AMOUNT}.`,
      );
    }
    if (!isCalendarDay(date)) {
      throw new Refusal(422, 'DateIsInvalid', 'The date must be a real day of the calendar, written YYYY-MM-DD.');
    }
    if (date > todayInUtc()) {
      throw new Refusal(422, 'DateIsInTheFuture', 'The date must not be after today (UTC).');
    }
    if (splitBetween.length === 0) {
      throw new Refusal(422, 'SplitIsEmpty', 'The expense must be split between at least one member.');
    }
    if (new Set(splitBetween).size !== splitBetween.length) {
      throw new Refusal(422, 'SplitRepeatsAMember', 'Each member may be listed once in the split.');
    }
    const members = new Set(membersOfGroup(db, groupId).map(member => member.memberId));
    if (splitBetween.some(memberId => !members.has(memberId))) {
      throw new Refusal(422, 'MemberNotInGroup', 'Every member of the split must be a member of the group.');
    }
    if (!splitBetween.includes(payerId)) {
      throw new Refusal(422, 'PayerNotInSplit', 'The payer must be one of the members the expense is split between.');
    }

    db.prepare(
      'INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, groupId, trimmedDescription, amount, date, payerId, new Date().toISOString());
    const insertShare = db.prepare(
      'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
    );
    equalShares(amount, splitBetween, payerId).forEach((share, position) => {
      insertShare.run(id, position, share.memberId, share.amount);
    });
  });
  return id;
}

/**
 * The expense with this id, when `accountId` is a member of its group; `undefined` otherwise, as if it
 * did not exist. Reading never changes it.
 */
export function findExpenseOfMember(db: DatabaseSync, accountId: string, expenseId: string): Expense | undefined {
  const row = db
    .prepare(
      `SELECT e.id, e.group_id, e.description, e.amount, e.spent_on, e.paid_by FROM expenses e
       JOIN group_members m ON m.group_id = e.group_id
       WHERE e.id = ? AND m.account_id = ?`,
    )
    .get(expenseId, accountId) as ExpenseRow | undefined;
  if (!row) return undefined;
  const shares = db
    .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position ASC')
    .all(row.id) as unknown as ShareRow[];
  return {
    id: row.id,
    groupId: row.group_id,
    description: row.description,
    amount: row.amount,
    date: row.spent_on,
    paidBy: row.paid_by,
    shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
  };
}
