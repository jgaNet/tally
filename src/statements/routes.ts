import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { requireMembership } from '../groups/groups';
import { statementAsCsv } from './csv';
import { statementOf } from './statements';

// An expense's entry names its `expenseId`, a settlement's its `settlementId`: the schema lists both,
// since which one an entry has depends on its `kind`.
const entrySchema = {
  type: 'object',
  required: ['kind', 'date', 'description', 'paid', 'share', 'balance'],
  properties: {
    kind: { type: 'string', enum: ['expense', 'settlement'] },
    expenseId: { type: 'string' },
    settlementId: { type: 'string' },
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
  const params = {
    type: 'object',
    required: ['id', 'memberId'],
    properties: { id: { type: 'string' }, memberId: { type: 'string' } },
  };

  app.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement',
    {
      schema: {
        params,
        response: { 200: statementSchema },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      // Only the members of a group read its statements, their own included; anyone else is told it does not exist.
      await requireMembership(db, request.params.id, account.id);
      return await statementOf(db, request.params.id, request.params.memberId);
    },
  );

  app.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement.csv',
    { schema: { params } },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      // The same reader and refusals as the statement itself.
      await requireMembership(db, request.params.id, account.id);
      const csv = statementAsCsv(await statementOf(db, request.params.id, request.params.memberId));
      reply.type('text/csv; charset=utf-8');
      return csv;
    },
  );
}
