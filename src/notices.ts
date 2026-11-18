import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { CATEGORIES, type Category } from './categories';
import { requireCaller } from './sessions';

/**
 * A notice: of an expense, to a member it concerns other than its payer, with their share of it; a reminder, with
 * no expense, of what the member still owes; or a budget notice, of a month that passed a category's budget, with the
 * category, the month (`YYYY-MM`), the budget and what the month spends. Amounts are in hundredths.
 */
export interface Notice {
  id: string;
  kind: 'expense' | 'reminder' | 'budget';
  groupId: string;
  expenseId?: string;
  category?: Category;
  month?: string;
  budget?: number;
  amount: number;
  at: string;
}

interface NoticeRow {
  id: string;
  kind: 'expense' | 'reminder' | 'budget';
  group_id: string;
  expense_id: string | null;
  category: string | null;
  month: string | null;
  budget: number | null;
  amount: number;
  created_at: string;
}

/**
 * Writes one notice for each member of the split but the payer, each with their share. It is called inside the
 * write transaction that records the expense, so a notice exists exactly when its expense does. The payer gets
 * none: they recorded it.
 */
export function writeExpenseNotices(
  db: DatabaseSync,
  expense: { id: string; groupId: string; paidBy: string; at: string },
  shares: readonly { memberId: string; amount: number }[],
): void {
  const insert = db.prepare(
    `INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at)
     VALUES (?, ?, 'expense', ?, ?, ?, ?)`,
  );
  for (const share of shares) {
    if (share.memberId === expense.paidBy) continue;
    insert.run(randomUUID(), share.memberId, expense.groupId, expense.id, share.amount, expense.at);
  }
}

/**
 * The notices of the account, the most recent first. Only the account reads its own; they stay with it after it
 * leaves the group. `rowid` orders the notices made at the same moment, in the order they were written.
 */
export function listNoticesOf(db: DatabaseSync, accountId: string): Notice[] {
  const rows = db
    .prepare(
      `SELECT id, kind, group_id, expense_id, category, month, budget, amount, created_at FROM notices
       WHERE account_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    .all(accountId) as unknown as NoticeRow[];
  return rows.map(row => {
    const notice: Notice = {
      id: row.id,
      kind: row.kind,
      groupId: row.group_id,
      amount: row.amount,
      at: row.created_at,
    };
    if (row.expense_id !== null) notice.expenseId = row.expense_id;
    if (row.kind === 'budget') {
      notice.category = row.category as Category;
      notice.month = row.month as string;
      notice.budget = row.budget as number;
    }
    return notice;
  });
}

const noticeSchema = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { enum: ['expense', 'reminder', 'budget'] },
    groupId: { type: 'string' },
    expenseId: { type: 'string' },
    category: { enum: [...CATEGORIES] },
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    budget: { type: 'integer', minimum: 1 },
    amount: { type: 'integer' },
    at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
  },
};

export function registerNoticeRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.get('/notices', { schema: { response: { 200: { type: 'array', items: noticeSchema } } } }, request => {
    const accountId = requireCaller(db, request);
    return listNoticesOf(db, accountId);
  });
}
