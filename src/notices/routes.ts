import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { noticesOf } from './notices';

const noticeSchema = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'expenseId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['expense'] },
    groupId: { type: 'string' },
    expenseId: { type: 'string' },
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
      const account = requireAccount(db, request);
      return noticesOf(db, account.id);
    },
  );
}
