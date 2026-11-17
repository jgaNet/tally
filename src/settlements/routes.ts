import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { requireMembership } from '../groups/groups';
import { recordCashSettlement, requireSettlement } from './settlements';
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

const settlementSchema = {
  type: 'object',
  required: ['id', 'groupId', 'from', 'to', 'amount', 'method', 'status', 'at'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer' },
    method: { type: 'string', enum: ['cash'] },
    status: { type: 'string', enum: ['paid'] },
    at: { type: 'string' },
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

  app.post<{ Params: { id: string }; Body: { from: string; amount: number } }>(
    '/groups/:id/settlements/cash',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['from', 'amount'],
          properties: { from: { type: 'string' }, amount: { type: 'number' } },
        },
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      // The caller is the payee: the member who was paid in cash records it.
      const id = recordCashSettlement(db, request.params.id, account.id, {
        from: request.body.from,
        amount: request.body.amount,
      });
      return reply.code(201).send({ id });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/settlements/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: settlementSchema },
      },
    },
    async request => {
      const account = requireAccount(db, request);
      return requireSettlement(db, request.params.id, account.id);
    },
  );
}
