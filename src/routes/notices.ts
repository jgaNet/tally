import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { noticesOf } from '../notices';
import { requireCaller } from '../http';
import { CATEGORIES } from '../categories';

const NOTICE = {
  type: 'object',
  // A reminder has no expense: `expenseId` is answered by an expense's notice only. A budget's notice names its
  // category, month and budget, and what the month spends (`amount`).
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
    at: { type: 'string' },
  },
};

export function registerNoticeRoutes(server: FastifyInstance, db: DatabaseSync): void {
  // Only the caller's own notices are read: nobody else reads them, and they stay after leaving a group.
  server.get('/notices', { schema: { response: { 200: { type: 'array', items: NOTICE } } } }, async request => {
    const caller = requireCaller(db, request);
    return noticesOf(db, caller.id);
  });
}
