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
    const members = new Set(
      (
        db.prepare('SELECT account_id FROM memberships WHERE group_id = ?').all(groupId) as unknown as {
          account_id: string;
        }[]
      ).map(row => row.account_id),
    );
    const expense = validateExpense(input, members, payerId);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO expenses (id, group_id, description, amount, date, paid_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, groupId, expense.description, expense.amount, expense.date, payerId, new Date().toISOString());
    const insertShare = db.prepare(
      'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
    );
    equalShares(expense.amount, expense.splitBetween, payerId).forEach((share, position) => {
      insertShare.run(id, position, share.memberId, share.amount);
    });
    return id;
  });
}

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
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
      `SELECT expenses.id, expenses.group_id, expenses.description, expenses.amount, expenses.date, expenses.paid_by
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
