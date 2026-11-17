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
  /** 1 when the expense is recorded, one more at each edit. */
  readonly version: number;
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
  version: number;
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

/** The fields an expense is given with, when it is recorded or edited. */
export interface ExpenseFields {
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  /** The members the expense is split between, in the order of the split. */
  readonly splitBetween: readonly string[];
}

/**
 * Checks the fields of an expense of `groupId` paid by `payerId`, under the rules of recording one,
 * and answers the description trimmed of surrounding spaces. Refused with `422` (the error names the
 * rule) when a rule is broken. Writes nothing; the caller runs it in its transaction.
 */
function checkExpenseFields(db: DatabaseSync, groupId: string, payerId: string, fields: ExpenseFields): string {
  const { description, amount, date, splitBetween } = fields;
  const trimmedDescription = description.trim();
  if (characters(description) > MAX_DESCRIPTION_LENGTH || trimmedDescription.length === 0) {
    throw new Refusal(
      422,
      'DescriptionIsInvalid',
      `The description must have 1 to ${MAX_DESCRIPTION_LENGTH} characters and not be only spaces.`,
    );
  }
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    throw new Refusal(422, 'AmountIsInvalid', `The amount must be a whole number from ${MIN_AMOUNT} to ${MAX_AMOUNT}.`);
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
  return trimmedDescription;
}

/** Writes the expense's shares: the equal split of its amount, in the order of the split. */
function writeShares(
  db: DatabaseSync,
  expenseId: string,
  amount: number,
  splitBetween: readonly string[],
  payerId: string,
) {
  const insertShare = db.prepare(
    'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
  );
  equalShares(amount, splitBetween, payerId).forEach((share, position) => {
    insertShare.run(expenseId, position, share.memberId, share.amount);
  });
}

export interface RecordExpenseInput extends ExpenseFields {
  readonly groupId: string;
  /** The member who records the expense: its payer. */
  readonly payerId: string;
}

/**
 * Records an expense the payer paid in the group, split equally between the members named in
 * `splitBetween`, and returns its id. Refused with `404` when the payer is not a member of the group;
 * otherwise with `422` when the description, amount, date or split breaks a rule (the error names it).
 * The description is stored trimmed of surrounding spaces. It is recorded at version 1.
 */
export function recordExpense(db: DatabaseSync, input: RecordExpenseInput): string {
  const { groupId, payerId, amount, date, splitBetween } = input;
  const id = randomUUID();
  inTransaction(db, () => {
    if (!findGroupOfMember(db, payerId, groupId)) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    const description = checkExpenseFields(db, groupId, payerId, input);
    db.prepare(
      'INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, version, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    ).run(id, groupId, description, amount, date, payerId, new Date().toISOString());
    writeShares(db, id, amount, splitBetween, payerId);
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
      `SELECT e.id, e.group_id, e.description, e.amount, e.spent_on, e.paid_by, e.version FROM expenses e
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
    version: row.version,
    shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
  };
}

/**
 * The expense `editorId` may change: they must be a member of its group (else `404`, as if it did not
 * exist), and its payer or the group's owner (else `403`). Answers the expense as it is now.
 */
function expenseChangeableBy(db: DatabaseSync, editorId: string, expenseId: string): Expense {
  const expense = findExpenseOfMember(db, editorId, expenseId);
  if (!expense) throw new Refusal(404, 'ExpenseNotFound', 'No expense has this id.');
  const ownerId = findGroupOfMember(db, editorId, expense.groupId)?.ownerId;
  if (editorId !== expense.paidBy && editorId !== ownerId) {
    throw new Refusal(403, 'NotPayerOrOwner', 'Only the payer of the expense or the owner of its group may change it.');
  }
  return expense;
}

export interface EditExpenseInput extends ExpenseFields {
  readonly expenseId: string;
  /** The member who edits the expense: its payer or the group's owner. */
  readonly editorId: string;
  /** The version of the expense the edit was made from, the one its author read. */
  readonly version: number;
}

/**
 * Replaces the expense, whole, from the version the edit was made from, and answers it as it now
 * stands (at the next version). The fields are checked under the rules of recording an expense; the
 * payer stays the one who paid, and the shares are computed again. Refused with `404` when the editor
 * is not a member of the expense's group, with `403` when the editor is neither its payer nor the
 * group's owner, with `409` when the expense has changed since the version given. A refused edit keeps
 * nothing: the edit is one transaction, so two edits of one version cannot both be kept.
 */
export function editExpense(db: DatabaseSync, input: EditExpenseInput): Expense {
  const { expenseId, editorId, version, amount, date, splitBetween } = input;
  return inTransaction(db, () => {
    const expense = expenseChangeableBy(db, editorId, expenseId);
    if (expense.version !== version) {
      throw new Refusal(
        409,
        'ExpenseChanged',
        `The expense has changed since version ${version}: it is at version ${expense.version}. Read it again.`,
      );
    }
    const description = checkExpenseFields(db, expense.groupId, expense.paidBy, input);
    const updated = db
      .prepare(
        'UPDATE expenses SET description = ?, amount = ?, spent_on = ?, version = version + 1 WHERE id = ? AND version = ?',
      )
      .run(description, amount, date, expenseId, version);
    if (updated.changes !== 1) {
      throw new Refusal(409, 'ExpenseChanged', 'The expense has changed since it was read. Read it again.');
    }
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    writeShares(db, expenseId, amount, splitBetween, expense.paidBy);
    return findExpenseOfMember(db, editorId, expenseId) as Expense;
  });
}

/**
 * Deletes the expense: it is no longer read, and counts in no balance. Refused like an edit: `404`
 * when the deleter is not a member of its group, `403` when they are neither its payer nor the
 * group's owner.
 */
export function deleteExpense(db: DatabaseSync, input: { expenseId: string; deleterId: string }): void {
  const { expenseId, deleterId } = input;
  inTransaction(db, () => {
    expenseChangeableBy(db, deleterId, expenseId);
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
  });
}
