import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { budgetsOfGroup, removeBudget, setBudget } from '../budgets';
import { CATEGORIES } from '../categories';
import { requireCaller } from '../http';

/** Only the shape is checked here (a missing or wrongly typed amount is `400`); the amount's range is checked by the rules. */
const SET_BUDGET_BODY = {
  type: 'object',
  required: ['amount'],
  properties: { amount: { type: 'number' } },
};

const BUDGET = {
  type: 'object',
  required: ['category', 'amount', 'spent'],
  properties: {
    category: { enum: [...CATEGORIES] },
    amount: { type: 'integer', minimum: 1 },
    spent: { type: 'integer', minimum: 0 },
  },
};

export function registerBudgetRoutes(server: FastifyInstance, db: DatabaseSync, clock: () => Date): void {
  // Only the owner of the group sets a budget; setting it again replaces the amount.
  server.put<{ Params: { id: string; category: string }; Body: { amount: number } }>(
    '/groups/:id/budgets/:category',
    { schema: { body: SET_BUDGET_BODY } },
    async (request, reply) => {
      const caller = requireCaller(db, request);
      setBudget(db, {
        groupId: request.params.id,
        callerId: caller.id,
        category: request.params.category,
        amount: request.body.amount,
      });
      return reply.code(204).send();
    },
  );

  // Only the owner of the group removes a budget.
  server.delete<{ Params: { id: string; category: string } }>(
    '/groups/:id/budgets/:category',
    async (request, reply) => {
      const caller = requireCaller(db, request);
      removeBudget(db, { groupId: request.params.id, callerId: caller.id, category: request.params.category });
      return reply.code(204).send();
    },
  );

  // Only a member reads the budgets; to anyone else the group does not exist.
  server.get<{ Params: { id: string } }>(
    '/groups/:id/budgets',
    { schema: { response: { 200: { type: 'array', items: BUDGET } } } },
    async request => {
      const caller = requireCaller(db, request);
      return budgetsOfGroup(db, caller.id, request.params.id, clock());
    },
  );
}
