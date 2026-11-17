import { randomUUID } from 'node:crypto';
import { type Database, inTransaction } from '../database';
import { requireMembership } from '../groups/groups';
import { Refusal } from '../refusal';
import { type ExpenseInput, validateExpense } from './validation';

export interface Share {
  memberId: string;
  /** In hundredths of the group's currency. */
  amount: number;
}

export interface Expense {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  /** The account id of the member who recorded it. */
  paidBy: string;
  /** 1 when recorded, and one more at each edit. */
  version: number;
  /** In the order of the split. */
  shares: Share[];
}

/**
 * Divides `amount` equally between `splitBetween`, in that order. Each share is the amount divided
 * by the number of members, rounded down; the remainder goes whole to the payer's share, so the
 * shares add up to the amount exactly.
 */
export function equalShares(amount: number, splitBetween: readonly string[], payerId: string): Share[] {
  const base = Math.floor(amount / splitBetween.length);
  const remainder = amount - base * splitBetween.length;
  return splitBetween.map(memberId => ({
    memberId,
    amount: memberId === payerId ? base + remainder : base,
  }));
}

/**
 * Records an expense of `groupId` that `payerId` paid, split equally. `payerId` must be a member of
 * the group, or the group is refused as not there. The expense and its shares are written together,
 * or not at all.
 */
export function createExpense(db: Database, groupId: string, payerId: string, input: ExpenseInput): string {
  return inTransaction(db, () => {
    requireMembership(db, groupId, payerId);
    const expense = validateExpense(input, memberIdsOf(db, groupId), payerId);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO expenses (id, group_id, description, amount, date, paid_by, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, groupId, expense.description, expense.amount, expense.date, payerId, new Date().toISOString());
    writeShares(db, id, equalShares(expense.amount, expense.splitBetween, payerId));
    return id;
  });
}

/** The account ids of the members of `groupId`. */
function memberIdsOf(db: Database, groupId: string): Set<string> {
  const rows = db.prepare('SELECT account_id FROM memberships WHERE group_id = ?').all(groupId) as unknown as {
    account_id: string;
  }[];
  return new Set(rows.map(row => row.account_id));
}

/** Writes the shares of an expense, in the order given: their positions are the order of the split. */
function writeShares(db: Database, expenseId: string, shares: Share[]): void {
  const insertShare = db.prepare(
    'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
  );
  shares.forEach((share, position) => {
    insertShare.run(expenseId, position, share.memberId, share.amount);
  });
}

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
  version: number;
}

interface ShareRow {
  member_id: string;
  amount: number;
}

/**
 * The expense with this id, for a member of its group. For anyone else it is `undefined`, the same
 * as an expense that does not exist. Reading it changes nothing.
 */
export function findExpense(db: Database, expenseId: string, accountId: string): Expense | undefined {
  const row = db
    .prepare(
      `SELECT expenses.id, expenses.group_id, expenses.description, expenses.amount, expenses.date,
              expenses.paid_by, expenses.version
         FROM expenses JOIN memberships ON memberships.group_id = expenses.group_id
        WHERE expenses.id = ? AND memberships.account_id = ?`,
    )
    .get(expenseId, accountId) as ExpenseRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  const shares = db
    .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
    .all(expenseId) as unknown as ShareRow[];
  return {
    id: row.id,
    groupId: row.group_id,
    description: row.description,
    amount: row.amount,
    date: row.date,
    paidBy: row.paid_by,
    version: row.version,
    shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
  };
}

/** The expense, for a member of its group. Anyone else is refused with `404`, as if it did not exist. */
export function requireExpense(db: Database, expenseId: string, accountId: string): Expense {
  const expense = findExpense(db, expenseId, accountId);
  if (!expense) {
    throw new Refusal(404, 'NotFound', 'There is no such expense.');
  }
  return expense;
}

/**
 * The expense, for an edit or a delete by `accountId`, who must be its payer or the owner of its
 * group. Another member is refused with `403`; anyone outside the group is refused with `404`, as
 * if the expense did not exist. Runs inside `inTransaction`, so the check and the write cannot be split.
 */
function requireEditor(db: Database, expenseId: string, accountId: string): Expense {
  const expense = requireExpense(db, expenseId, accountId);
  if (expense.paidBy !== accountId) {
    const group = requireMembership(db, expense.groupId, accountId);
    if (group.ownerId !== accountId) {
      throw new Refusal(403, 'NotPermitted', 'Only the member who paid for this expense, or the owner, may change it.');
    }
  }
  return expense;
}

/**
 * Replaces the expense `expenseId` with `input`, made from `version`: the version the author read.
 * The payer stays the one who paid, and the shares are computed again from the new split. When the
 * expense has changed since `version`, the edit is refused with `409` and nothing of it is kept.
 * Two edits from the same version: the first is kept, the second is refused.
 */
export function updateExpense(
  db: Database,
  expenseId: string,
  accountId: string,
  input: ExpenseInput,
  version: number,
): void {
  inTransaction(db, () => {
    const current = requireEditor(db, expenseId, accountId);
    if (current.version !== version) {
      throw staleVersion();
    }
    const expense = validateExpense(input, memberIdsOf(db, current.groupId), current.paidBy);
    // The version is checked again in the write itself: it is the same check, made atomically.
    const written = db
      .prepare(
        'UPDATE expenses SET description = ?, amount = ?, date = ?, version = version + 1 WHERE id = ? AND version = ?',
      )
      .run(expense.description, expense.amount, expense.date, expenseId, version);
    if (written.changes !== 1) {
      throw staleVersion();
    }
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    writeShares(db, expenseId, equalShares(expense.amount, expense.splitBetween, current.paidBy));
  });
}

/**
 * Deletes the expense `expenseId`, by its payer or the owner of its group. It no longer exists: it
 * is not read, and it counts in no balance.
 */
export function deleteExpense(db: Database, expenseId: string, accountId: string): void {
  inTransaction(db, () => {
    requireEditor(db, expenseId, accountId);
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
  });
}

const staleVersion = (): Refusal =>
  new Refusal(409, 'StaleVersion', 'The expense has changed since the version you read: read it again and decide.');
