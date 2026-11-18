import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { type Expense, type ExpenseRow, expenseOf, expenseSchema } from './expenses';
import { findGroupOf } from './groups';
import { hasBeenMember } from './members';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/** One row per share of an expense, with the expense's own fields repeated on each of its rows. */
interface GroupExpenseRow extends ExpenseRow {
  share_member: string;
  share_amount: number;
}

/** One entry of a statement: what a member paid for an expense, their share of it, and their balance after it. */
export interface StatementEntry {
  expenseId: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  balance: number;
}

export interface Statement {
  memberId: string;
  balance: number;
  entries: StatementEntry[];
}

interface StatementRow {
  expense_id: string;
  date: string;
  description: string;
  paid: number;
  share: number;
}

/**
 * The expenses of the group that are not deleted, the latest date first; on the same date, the most
 * recently recorded first. An edit keeps the moment an expense was recorded, so it keeps its place.
 * Each expense is read as `findExpenseOf` reads it. The rows come from one statement, so the list is of
 * one snapshot of the database.
 */
export function listExpenses(db: DatabaseSync, groupId: string): Expense[] {
  // Every expense has a share: its payer is in its split. Its shares come in the order of their split.
  const rows = db
    .prepare(
      `SELECT e.id, e.group_id, e.description, e.amount, e.date, e.paid_by, e.split_kind, e.version,
         e.original_currency, e.original_amount, e.original_rate,
         s.account_id AS share_member, s.amount AS share_amount
       FROM expenses e JOIN expense_shares s ON s.expense_id = e.id
       WHERE e.group_id = ?
       ORDER BY e.date DESC, e.created_at DESC, e.rowid DESC, s.position`,
    )
    .all(groupId) as unknown as GroupExpenseRow[];
  const expenses: Expense[] = [];
  let current: Expense | undefined;
  for (const row of rows) {
    if (current?.id !== row.id) {
      current = expenseOf(row, []);
      expenses.push(current);
    }
    current.shares.push({ memberId: row.share_member, amount: row.share_amount });
  }
  return expenses;
}

/**
 * The statement of a member of the group: every expense of the group that is not deleted and that the
 * member paid or is in the split of, the earliest date first; on the same date, the earliest recorded
 * first. Each entry's balance is the one before it plus what the member paid minus their share, starting
 * from 0. The statement's balance is the last entry's, or 0 when it has none. One statement reads the
 * entries, so they are of one snapshot of the database. A read changes nothing.
 */
export function statementOf(db: DatabaseSync, groupId: string, memberId: string): Statement {
  const rows = db
    .prepare(
      `SELECT e.id AS expense_id, e.date, e.description,
         CASE WHEN e.paid_by = ? THEN e.amount ELSE 0 END AS paid,
         COALESCE((SELECT s.amount FROM expense_shares s
                   WHERE s.expense_id = e.id AND s.account_id = ?), 0) AS share
       FROM expenses e
       WHERE e.group_id = ?
         AND (e.paid_by = ? OR EXISTS (SELECT 1 FROM expense_shares s
                                       WHERE s.expense_id = e.id AND s.account_id = ?))
       ORDER BY e.date ASC, e.created_at ASC, e.rowid ASC`,
    )
    .all(memberId, memberId, groupId, memberId, memberId) as unknown as StatementRow[];
  let balance = 0;
  const entries = rows.map(row => {
    balance += row.paid - row.share;
    return {
      expenseId: row.expense_id,
      date: row.date,
      description: row.description,
      paid: row.paid,
      share: row.share,
      balance,
    };
  });
  return { memberId, balance: entries.at(-1)?.balance ?? 0, entries };
}

const entrySchema = {
  type: 'object',
  required: ['expenseId', 'date', 'description', 'paid', 'share', 'balance'],
  properties: {
    expenseId: { type: 'string' },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    description: { type: 'string' },
    paid: { type: 'integer' },
    share: { type: 'integer' },
    balance: { type: 'integer' },
  },
};

const statementSchema = {
  type: 'object',
  required: ['memberId', 'balance', 'entries'],
  properties: {
    memberId: { type: 'string' },
    balance: { type: 'integer' },
    entries: { type: 'array', items: entrySchema },
  },
};

/**
 * The expenses of a group and the statements of its members are read by the members of the group. For
 * anyone else the group does not exist; a member who has never been in the group does not exist either.
 * A member who has left the group keeps their statement, which the members of the group can still read.
 */
export function registerHistoryRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/expenses',
    { schema: { response: { 200: { type: 'array', items: expenseSchema } } } },
    request => {
      const accountId = requireCaller(db, request);
      if (!findGroupOf(db, accountId, request.params.id)) throw new Refusal(404, 'NotFound', 'There is no such group.');
      return listExpenses(db, request.params.id);
    },
  );

  app.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement',
    { schema: { response: { 200: statementSchema } } },
    request => {
      const accountId = requireCaller(db, request);
      const groupId = request.params.id;
      if (!findGroupOf(db, accountId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
      if (!hasBeenMember(db, groupId, request.params.memberId)) {
        throw new Refusal(404, 'NotFound', 'There is no such member of the group.');
      }
      return statementOf(db, groupId, request.params.memberId);
    },
  );
}
