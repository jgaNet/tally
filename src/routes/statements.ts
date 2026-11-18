import type { FastifyInstance } from 'fastify';
import type { Database } from '../database';
import { requireCaller } from '../http';
import { statementAsCsv, statementOfMember } from '../statements';

const STATEMENT_ENTRY = {
  type: 'object',
  required: ['kind', 'date', 'description', 'paid', 'share', 'balance'],
  properties: {
    kind: { enum: ['expense', 'settlement'] },
    expenseId: { type: 'string' },
    settlementId: { type: 'string' },
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

export function registerStatementRoutes(server: FastifyInstance, db: Database): void {
  // Only a member of the group reads a statement of its members, their own included; to anyone else the
  // group does not exist, and a statement of someone who is not a member does not exist either.
  server.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement',
    { schema: { response: { 200: STATEMENT } } },
    async request => {
      const caller = await requireCaller(db, request);
      return await statementOfMember(db, caller.id, request.params.id, request.params.memberId);
    },
  );

  // The same statement, as CSV in UTF-8, read by the same members and refused the same way.
  server.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement.csv',
    async (request, reply) => {
      const caller = await requireCaller(db, request);
      const statement = await statementOfMember(db, caller.id, request.params.id, request.params.memberId);
      return reply.header('content-type', 'text/csv; charset=utf-8').send(statementAsCsv(statement));
    },
  );
}
