import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { createExpense, requireExpense } from './expenses';

const shareSchema = {
  type: 'object',
  required: ['memberId', 'amount'],
  properties: {
    memberId: { type: 'string' },
    amount: { type: 'integer' },
  },
};

const expenseSchema = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'shares'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    paidBy: { type: 'string' },
    shares: { type: 'array', items: shareSchema },
  },
};

export function registerExpenseRoutes(app: FastifyInstance, db: Database): void {
  app.post<{
    Params: { id: string };
    Body: { description: string; amount: number; date: string; splitBetween: string[] };
  }>(
    '/groups/:id/expenses',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['description', 'amount', 'date', 'splitBetween'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'number' },
            date: { type: 'string' },
            splitBetween: { type: 'array', items: { type: 'string' } },
          },
        },
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      const id = createExpense(db, request.params.id, account.id, request.body);
      return reply.code(201).send({ id });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/expenses/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: expenseSchema },
      },
    },
    async request => {
      const account = requireAccount(db, request);
      return requireExpense(db, request.params.id, account.id);
    },
  );
}
