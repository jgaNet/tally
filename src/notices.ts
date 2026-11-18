import { randomUUID } from 'node:crypto';
import type { Querier } from './database';
import type { Category } from './categories';
import { turnedOffAmong } from './notice-preferences';

/**
 * What a notice tells its recipient. An `expense` notice: an expense of a group, and their share of it. A
 * `reminder`: what they still owe in a group, as a positive amount, with no expense. A `budget` notice: a category of
 * a group whose month spends `amount`, over its `budget`, in `month` (`YYYY-MM`). `at` is when it was made.
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
    }
  | {
      readonly id: string;
      readonly kind: 'budget';
      readonly groupId: string;
      readonly category: Category;
      readonly month: string;
      readonly budget: number;
      readonly amount: number;
      readonly at: string;
    };

interface NoticeRow {
  id: string;
  kind: 'expense' | 'reminder' | 'budget';
  group_id: string;
  expense_id: string | null;
  category: Category | null;
  month: string | null;
  budget: number | null;
  amount: number;
  created_at: string;
}

/**
 * Makes the notices of an expense just recorded: one to each member of its split but its payer, of
 * their share, all made at `at`. Written by the caller's transaction, so they exist exactly when the
 * expense does. The table keeps one per expense and recipient, so a repeated write is refused.
 */
export async function noticeExpense(
  db: Querier,
  input: {
    expenseId: string;
    groupId: string;
    payerId: string;
    shares: readonly { readonly memberId: string; readonly amount: number }[];
    at: string;
  },
): Promise<void> {
  const { expenseId, groupId, payerId, shares, at } = input;
  const insert = db.prepare(
    `INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, amount, created_at)
     VALUES (?, ?, 'expense', ?, ?, ?, ?)`,
  );
  // A member who turned expense notices off is not told of their share, from the moment they turned them off.
  const off = await turnedOffAmong(
    db,
    shares.map(share => share.memberId),
    'expense',
  );
  for (const share of shares) {
    // The payer recorded the expense: they get no notice of it.
    if (share.memberId === payerId || off.has(share.memberId)) continue;
    await insert.run(randomUUID(), share.memberId, groupId, expenseId, share.amount, at);
  }
}

/**
 * The notices of `accountId`, the most recent first. Only the notices addressed to the account are read,
 * and they stay after the account leaves a group. Reading never changes them.
 */
export async function noticesOf(db: Querier, accountId: string): Promise<Notice[]> {
  const rows = await db
    .prepare(
      `SELECT id, kind, group_id, expense_id, category, month, budget, amount, created_at FROM notices
       WHERE recipient_id = ? ORDER BY created_at DESC, seq DESC`,
    )
    .all<NoticeRow>(accountId);
  return rows.map((row): Notice => {
    if (row.kind === 'reminder') {
      return { id: row.id, kind: 'reminder', groupId: row.group_id, amount: row.amount, at: row.created_at };
    }
    if (row.kind === 'budget') {
      return {
        id: row.id,
        kind: 'budget',
        groupId: row.group_id,
        category: row.category as Category,
        month: row.month as string,
        budget: row.budget as number,
        amount: row.amount,
        at: row.created_at,
      };
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

/** Makes a budget's notice to `recipientId`: `amount` is what the `month` of `category` spends, over `budget`. */
export async function noticeBudget(
  db: Querier,
  input: {
    recipientId: string;
    groupId: string;
    category: Category;
    month: string;
    budget: number;
    amount: number;
    at: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, category, month, budget, amount, created_at)
       VALUES (?, ?, 'budget', ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.recipientId,
      input.groupId,
      input.category,
      input.month,
      input.budget,
      input.amount,
      input.at,
    );
}

/** Makes a reminder to `recipientId` of the `amount` they still owe in `groupId`, made at `at`. */
export async function noticeReminder(
  db: Querier,
  input: { recipientId: string; groupId: string; amount: number; at: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, amount, created_at)
       VALUES (?, ?, 'reminder', ?, NULL, ?, ?)`,
    )
    .run(randomUUID(), input.recipientId, input.groupId, input.amount, input.at);
}
