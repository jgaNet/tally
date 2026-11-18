import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import { CATEGORIES } from '../budgets/categories';
import type { Database } from '../database';
import { noticesOf } from './notices';

// An expense's notice names its expense; a reminder names none, so it has no `expenseId`; a budget notice names
// its category, month and budget, and its amount is what the month spends.
const noticeSchema = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['expense', 'reminder', 'budget'] },
    groupId: { type: 'string' },
    expenseId: { type: 'string' },
    category: { type: 'string', enum: [...CATEGORIES] },
    month: { type: 'string' },
    budget: { type: 'integer' },
    amount: { type: 'integer' },
    at: { type: 'string' },
  },
};

export function registerNoticeRoutes(app: FastifyInstance, db: Database): void {
  app.get(
    '/notices',
    {
      schema: {
        response: { 200: { type: 'array', items: noticeSchema } },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      return await noticesOf(db, account.id);
    },
  );
}
