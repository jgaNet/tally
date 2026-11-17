import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * What a notice tells its recipient. An `expense` notice: an expense of a group, and their share of it. A
 * `reminder`: what they still owe in a group, as a positive amount, with no expense. `at` is when it was made.
 */
export type Notice =
  | {
      readonly id: string;
      readonly kind: 'expense';
      readonly groupId: string;
      readonly expenseId: string;
      readonly amount: number;
      readonly at: string;
    }
  | {
      readonly id: string;
      readonly kind: 'reminder';
      readonly groupId: string;
      readonly amount: number;
      readonly at: string;
    };

interface NoticeRow {
  id: string;
  kind: 'expense' | 'reminder';
  group_id: string;
  expense_id: string | null;
  amount: number;
  created_at: string;
}

/**
 * Makes the notices of an expense just recorded: one to each member of its split but its payer, of
 * their share, all made at `at`. Written by the caller's transaction, so they exist exactly when the
 * expense does. The table keeps one per expense and recipient, so a repeated write is refused.
 */
export function noticeExpense(
  db: DatabaseSync,
  input: {
    expenseId: string;
    groupId: string;
    payerId: string;
    shares: readonly { readonly memberId: string; readonly amount: number }[];
    at: string;
  },
): void {
  const { expenseId, groupId, payerId, shares, at } = input;
  const insert = db.prepare(
    `INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, amount, created_at)
     VALUES (?, ?, 'expense', ?, ?, ?, ?)`,
  );
  for (const share of shares) {
    // The payer recorded the expense: they get no notice of it.
    if (share.memberId === payerId) continue;
    insert.run(randomUUID(), share.memberId, groupId, expenseId, share.amount, at);
  }
}

/**
 * The notices of `accountId`, the most recent first. Only the notices addressed to the account are read,
 * and they stay after the account leaves a group. Reading never changes them.
 */
export function noticesOf(db: DatabaseSync, accountId: string): Notice[] {
  const rows = db
    .prepare(
      `SELECT id, kind, group_id, expense_id, amount, created_at FROM notices
       WHERE recipient_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    .all(accountId) as unknown as NoticeRow[];
  return rows.map((row): Notice => {
    if (row.kind === 'reminder') {
      return { id: row.id, kind: 'reminder', groupId: row.group_id, amount: row.amount, at: row.created_at };
    }
    return {
      id: row.id,
      kind: 'expense',
      groupId: row.group_id,
      expenseId: row.expense_id as string,
      amount: row.amount,
      at: row.created_at,
    };
  });
}

/** Makes a reminder to `recipientId` of the `amount` they still owe in `groupId`, made at `at`. */
export function noticeReminder(
  db: DatabaseSync,
  input: { recipientId: string; groupId: string; amount: number; at: string },
): void {
  db.prepare(
    `INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, amount, created_at)
     VALUES (?, ?, 'reminder', ?, NULL, ?, ?)`,
  ).run(randomUUID(), input.recipientId, input.groupId, input.amount, input.at);
}
