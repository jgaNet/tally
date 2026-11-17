import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { findGroupOf } from './groups';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

export interface Balance {
  memberId: string;
  balance: number;
}

interface BalanceRow {
  member_id: string;
  balance: number;
}

/**
 * The balance of every member of the group now, in the order they joined, the earliest first. A member's
 * balance is what they paid for the group's expenses, minus their shares in them: positive when the
 * group owes them, negative when they owe the group, 0 when they are even. Every expense's shares add up
 * to its amount, so the balances of a group always add up to 0.
 *
 * It is one statement, so every balance is of the same snapshot of the database: an expense recorded
 * meanwhile is counted in all of them or in none. A read changes nothing.
 */
export function listBalances(db: DatabaseSync, groupId: string): Balance[] {
  const rows = db
    .prepare(
      `SELECT m.account_id AS member_id,
         COALESCE((SELECT SUM(e.amount) FROM expenses e
                   WHERE e.group_id = m.group_id AND e.paid_by = m.account_id), 0)
         - COALESCE((SELECT SUM(s.amount) FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
                     WHERE e.group_id = m.group_id AND s.account_id = m.account_id), 0) AS balance
       FROM group_members m
       WHERE m.group_id = ? AND m.left_at IS NULL
       ORDER BY m.joined_order`,
    )
    .all(groupId) as unknown as BalanceRow[];
  return rows.map(row => ({ memberId: row.member_id, balance: row.balance }));
}

const balanceSchema = {
  type: 'object',
  required: ['memberId', 'balance'],
  properties: { memberId: { type: 'string' }, balance: { type: 'integer' } },
};

/** The balances are read by the members of the group. For anyone else the group does not exist. */
export function registerBalanceRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/balances',
    { schema: { response: { 200: { type: 'array', items: balanceSchema } } } },
    request => {
      const accountId = requireCaller(db, request);
      if (!findGroupOf(db, accountId, request.params.id)) throw new Refusal(404, 'NotFound', 'There is no such group.');
      return listBalances(db, request.params.id);
    },
  );
}
