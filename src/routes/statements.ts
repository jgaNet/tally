import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { requireCaller } from '../http';
import { statementOfMember } from '../statements';

const STATEMENT_ENTRY = {
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

const STATEMENT = {
  type: 'object',
  required: ['memberId', 'balance', 'entries'],
  properties: {
    memberId: { type: 'string' },
    balance: { type: 'integer' },
    entries: { type: 'array', items: STATEMENT_ENTRY },
  },
};

export function registerStatementRoutes(server: FastifyInstance, db: DatabaseSync): void {
  // Only a member of the group reads a statement of its members, their own included; to anyone else the
  // group does not exist, and a statement of someone who is not a member does not exist either.
  server.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement',
    { schema: { response: { 200: STATEMENT } } },
    async request => {
      const caller = requireCaller(db, request);
      return statementOfMember(db, caller.id, request.params.id, request.params.memberId);
    },
  );
}
