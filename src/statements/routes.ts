import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { requireMembership } from '../groups/groups';
import { statementOf } from './statements';

const entrySchema = {
  type: 'object',
  required: ['expenseId', 'date', 'description', 'paid', 'share', 'balance'],
  properties: {
    expenseId: { type: 'string' },
    date: { type: 'string' },
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

export function registerStatementRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'memberId'],
          properties: { id: { type: 'string' }, memberId: { type: 'string' } },
        },
        response: { 200: statementSchema },
      },
    },
    async request => {
      const account = requireAccount(db, request);
      // Only the members of a group read its statements, their own included; anyone else is told it does not exist.
      requireMembership(db, request.params.id, account.id);
      return statementOf(db, request.params.id, request.params.memberId);
    },
  );
}
