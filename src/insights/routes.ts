import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import { CATEGORIES } from '../budgets/categories';
import type { Database } from '../database';
import { insightsOf } from './insights';

const insightSchema = {
  type: 'object',
  required: ['month', 'currency', 'category', 'amount'],
  properties: {
    month: { type: 'string' },
    currency: { type: 'string' },
    category: { type: 'string', enum: [...CATEGORIES] },
    amount: { type: 'integer' },
  },
};

export function registerInsightRoutes(app: FastifyInstance, db: Database): void {
  // Each person reads their own spending, and only their own.
  app.get(
    '/accounts/me/insights',
    {
      schema: {
        response: { 200: { type: 'array', items: insightSchema } },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      return await insightsOf(db, account.id);
    },
  );
}
