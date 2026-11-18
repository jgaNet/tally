import type { FastifyInstance } from 'fastify';
import type { Database } from '../database';
import { CATEGORIES } from '../categories';
import { requireCaller } from '../http';
import { spendingInsightsOf } from '../insights';

const INSIGHT = {
  type: 'object',
  required: ['month', 'currency', 'category', 'amount'],
  properties: {
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    category: { enum: [...CATEGORIES] },
    amount: { type: 'integer', minimum: 1 },
  },
};

export function registerInsightRoutes(server: FastifyInstance, db: Database): void {
  // Only the caller's own spending is read: nobody else reads it.
  server.get(
    '/accounts/me/insights',
    { schema: { response: { 200: { type: 'array', items: INSIGHT } } } },
    async request => {
      const caller = await requireCaller(db, request);
      return await spendingInsightsOf(db, caller.id);
    },
  );
}
