import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { createExpense, deleteExpense, requireExpense, updateExpense } from './expenses';

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
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'version', 'shares'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    paidBy: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    shares: { type: 'array', items: shareSchema },
  },
};

/** The fields of an expense as an edit gives them, and the version the edit was made from. */
const editBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'date', 'splitBetween', 'version'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'number' },
    date: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
    version: { type: 'integer', minimum: 1 },
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

  app.put<{
    Params: { id: string };
    Body: { description: string; amount: number; date: string; splitBetween: string[]; version: number };
  }>(
    '/expenses/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: editBodySchema,
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      const { version, ...input } = request.body;
      updateExpense(db, request.params.id, account.id, input, version);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/expenses/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      deleteExpense(db, request.params.id, account.id);
      return reply.code(204).send();
    },
  );
}
