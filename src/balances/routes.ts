import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { requireMembership } from '../groups/groups';
import { balancesOf } from './balances';

const balanceSchema = {
  type: 'object',
  required: ['memberId', 'balance'],
  properties: {
    memberId: { type: 'string' },
    balance: { type: 'integer' },
  },
};

export function registerBalanceRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/balances',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'array', items: balanceSchema } },
      },
    },
    async request => {
      const account = requireAccount(db, request);
      // Only the members of a group see its balances; anyone else is told it does not exist.
      requireMembership(db, request.params.id, account.id);
      return balancesOf(db, request.params.id);
    },
  );
}
