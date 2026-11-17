import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { noticesOf } from '../notices';
import { requireCaller } from '../http';

const NOTICE = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'expenseId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { enum: ['expense'] },
    groupId: { type: 'string' },
    expenseId: { type: 'string' },
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
