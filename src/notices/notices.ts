import { randomUUID } from 'node:crypto';
import type { Database } from '../database';

export interface Notice {
  id: string;
  kind: 'expense';
  groupId: string;
  expenseId: string;
  /** The member's share of the expense, in hundredths of the group's currency. */
  amount: number;
  /** When the notice was made: the moment the expense was recorded. */
  at: string;
}

interface NoticeRow {
  id: string;
  kind: 'expense';
  group_id: string;
  expense_id: string;
  amount: number;
  created_at: string;
}

/**
 * Writes a notice to each member of an expense's split but its payer, with their share. Called inside
 * the transaction that records the expense, so the notices exist exactly when the expense does: none is
 * written twice, and none is left behind when the expense is refused.
 */
export function recordExpenseNotices(
  db: Database,
  expense: { id: string; groupId: string; paidBy: string; shares: readonly { memberId: string; amount: number }[] },
  at: string,
): void {
  const insert = db.prepare(
    `INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at)
     VALUES (?, ?, 'expense', ?, ?, ?, ?)`,
  );
  for (const share of expense.shares) {
    if (share.memberId === expense.paidBy) {
      continue;
    }
    insert.run(randomUUID(), share.memberId, expense.groupId, expense.id, share.amount, at);
  }
}

/** The signed-in account's own notices, the most recent first. Nobody else's are read. Reading changes nothing. */
export function noticesOf(db: Database, accountId: string): Notice[] {
  const rows = db
    .prepare(
      `SELECT id, kind, group_id, expense_id, amount, created_at
         FROM notices
        WHERE account_id = ?
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(accountId) as unknown as NoticeRow[];
  return rows.map(row => ({
    id: row.id,
    kind: row.kind,
    groupId: row.group_id,
    expenseId: row.expense_id,
    amount: row.amount,
    at: row.created_at,
  }));
}
