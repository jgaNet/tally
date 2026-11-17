import { randomUUID } from 'node:crypto';
import { type Database, inTransaction } from '../database';
import { leftMembersAmong, requireMembership } from '../groups/groups';
import { recordExpenseNotices } from '../notices/notices';
import { Refusal } from '../refusal';
import { type ExpenseInput, type SplitInput, type SplitKind, validateExpense } from './validation';

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
  /** How it was split: equally, by exact amounts, or by shares. */
  splitKind: SplitKind;
  /** In the order of the split. */
  shares: Share[];
}

/**
 * Divides `amount` equally between `splitBetween`, in that order. Each share is the amount divided
 * by the number of members, rounded down; the remainder goes whole to the first member's share, so
 * the shares add up to the amount exactly, whoever paid.
 */
export function equalShares(amount: number, splitBetween: readonly string[]): Share[] {
  const base = Math.floor(amount / splitBetween.length);
  const remainder = amount - base * splitBetween.length;
  return splitBetween.map((memberId, position) => ({
    memberId,
    amount: position === 0 ? base + remainder : base,
  }));
}

/**
 * Each member's share of `amount` as their `splitByShares` say: the amount times their shares, divided
 * by the total of the shares, rounded down. The remainder goes whole to the first member's share, so
 * the shares add up to the amount exactly, whoever paid. Computed in integers of any size, so no
 * product overflows.
 */
export function sharesByCount(amount: number, splitByShares: readonly { memberId: string; shares: number }[]): Share[] {
  const total = splitByShares.reduce((sum, split) => sum + BigInt(split.shares), 0n);
  const parts = splitByShares.map(split => (BigInt(amount) * BigInt(split.shares)) / total);
  const remainder = BigInt(amount) - parts.reduce((sum, part) => sum + part, 0n);
  return splitByShares.map((split, position) => ({
    memberId: split.memberId,
    amount: Number(position === 0 ? parts[position] + remainder : parts[position]),
  }));
}

/** The shares of an expense of `amount` split as `split` says, in the order of the split. */
export function sharesOf(split: SplitInput, amount: number): Share[] {
  switch (split.kind) {
    case 'equal':
      return equalShares(amount, split.splitBetween);
    case 'exact':
      return split.splitExactly.map(share => ({ memberId: share.memberId, amount: share.amount }));
    case 'shares':
      return sharesByCount(amount, split.splitByShares);
  }
}

/**
 * Records an expense of `groupId` that `payerId` paid, split as its input says. `payerId` must be a member of
 * the group, or the group is refused as not there. The expense and its shares are written together,
 * or not at all.
 */
export function createExpense(db: Database, groupId: string, payerId: string, input: ExpenseInput): string {
  return inTransaction(db, () => {
    requireMembership(db, groupId, payerId);
    const expense = validateExpense(input, memberIdsOf(db, groupId), payerId);
    const id = randomUUID();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO expenses (id, group_id, description, amount, date, paid_by, version, split_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, groupId, expense.description, expense.amount, expense.date, payerId, expense.split.kind, at);
    const shares = sharesOf(expense.split, expense.amount);
    writeShares(db, id, shares);
    recordExpenseNotices(db, { id, groupId, paidBy: payerId, shares }, at);
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
  split_kind: SplitKind;
}

interface ShareRow {
  member_id: string;
  amount: number;
}

const EXPENSE_COLUMNS = `expenses.id, expenses.group_id, expenses.description, expenses.amount, expenses.date,
              expenses.paid_by, expenses.version, expenses.split_kind`;

/** The expense from its row and its shares, which are read in the order of the split. */
function toExpense(row: ExpenseRow, shares: ShareRow[]): Expense {
  return {
    id: row.id,
    groupId: row.group_id,
    description: row.description,
    amount: row.amount,
    date: row.date,
    paidBy: row.paid_by,
    version: row.version,
    splitKind: row.split_kind,
    shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
  };
}

/**
 * The expense with this id, for a member of its group. For anyone else it is `undefined`, the same
 * as an expense that does not exist. Reading it changes nothing.
 */
export function findExpense(db: Database, expenseId: string, accountId: string): Expense | undefined {
  const row = db
    .prepare(
      `SELECT ${EXPENSE_COLUMNS}
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
  return toExpense(row, shares);
}

/**
 * Every expense of `groupId`, as `findExpense` reads each: the latest date first, then the most
 * recently recorded first. An edit does not change when an expense was recorded. Reading changes nothing.
 */
export function expensesOfGroup(db: Database, groupId: string): Expense[] {
  const rows = db
    .prepare(
      `SELECT ${EXPENSE_COLUMNS}
         FROM expenses
        WHERE expenses.group_id = ?
        ORDER BY expenses.date DESC, expenses.created_at DESC, expenses.rowid DESC`,
    )
    .all(groupId) as unknown as ExpenseRow[];
  const shareRows = db
    .prepare(
      `SELECT expense_shares.expense_id, expense_shares.member_id, expense_shares.amount
         FROM expense_shares JOIN expenses ON expenses.id = expense_shares.expense_id
        WHERE expenses.group_id = ?
        ORDER BY expense_shares.expense_id, expense_shares.position`,
    )
    .all(groupId) as unknown as (ShareRow & { expense_id: string })[];
  const sharesByExpense = new Map<string, ShareRow[]>();
  for (const share of shareRows) {
    const list = sharesByExpense.get(share.expense_id) ?? [];
    list.push(share);
    sharesByExpense.set(share.expense_id, list);
  }
  return rows.map(row => toExpense(row, sharesByExpense.get(row.id) ?? []));
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
 * if the expense did not exist. An expense that names a member who has left is refused with `409`:
 * it is kept as it was, so that member's balance stays 0. Runs inside `inTransaction`, so the check
 * and the write cannot be split.
 */
function requireEditor(db: Database, expenseId: string, accountId: string): Expense {
  const expense = requireExpense(db, expenseId, accountId);
  if (expense.paidBy !== accountId) {
    const group = requireMembership(db, expense.groupId, accountId);
    if (group.ownerId !== accountId) {
      throw new Refusal(403, 'NotPermitted', 'Only the member who paid for this expense, or the owner, may change it.');
    }
  }
  const named = [expense.paidBy, ...expense.shares.map(share => share.memberId)];
  if (leftMembersAmong(db, expense.groupId, named).length > 0) {
    throw new Refusal(
      409,
      'MemberHasLeft',
      'A member who has left the group is in this expense, so it cannot be changed.',
    );
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
        `UPDATE expenses SET description = ?, amount = ?, date = ?, split_kind = ?, version = version + 1
          WHERE id = ? AND version = ?`,
      )
      .run(expense.description, expense.amount, expense.date, expense.split.kind, expenseId, version);
    if (written.changes !== 1) {
      throw staleVersion();
    }
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
    writeShares(db, expenseId, sharesOf(expense.split, expense.amount));
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
