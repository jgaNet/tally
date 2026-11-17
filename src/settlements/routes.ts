import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { requireMembership } from '../groups/groups';
import { suggestedTransfersOf } from './suggested';

const transferSchema = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer' },
  },
};

export function registerSettlementRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'array', items: transferSchema } },
      },
    },
    async request => {
      const account = requireAccount(db, request);
      // Only the members of a group see its suggestions; anyone else is told it does not exist.
      requireMembership(db, request.params.id, account.id);
      return suggestedTransfersOf(db, request.params.id);
    },
  );
}
