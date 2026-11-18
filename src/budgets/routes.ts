import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { requireMembership } from '../groups/groups';
import { budgetsOf, removeBudget, setBudget } from './budgets';
import { CATEGORIES } from './categories';

const groupParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const budgetParams = {
  type: 'object',
  required: ['id', 'category'],
  properties: { id: { type: 'string' }, category: { type: 'string' } },
};

const budgetSchema = {
  type: 'object',
  required: ['category', 'amount', 'spent'],
  properties: {
    category: { type: 'string', enum: [...CATEGORIES] },
    amount: { type: 'integer' },
    spent: { type: 'integer' },
  },
};

export function registerBudgetRoutes(app: FastifyInstance, db: Database): void {
  app.put<{ Params: { id: string; category: string }; Body: { amount: number } }>(
    '/groups/:id/budgets/:category',
    {
      schema: {
        params: budgetParams,
        body: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } },
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      setBudget(db, request.params.id, account.id, request.params.category, request.body.amount);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; category: string } }>(
    '/groups/:id/budgets/:category',
    { schema: { params: budgetParams } },
    async (request, reply) => {
      const account = requireAccount(db, request);
      removeBudget(db, request.params.id, account.id, request.params.category);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/groups/:id/budgets',
    { schema: { params: groupParams, response: { 200: { type: 'array', items: budgetSchema } } } },
    async request => {
      const account = requireAccount(db, request);
      requireMembership(db, request.params.id, account.id);
      return budgetsOf(db, request.params.id);
    },
  );
}
