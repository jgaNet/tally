import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyBudgetController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyBudgetController';
import {
  BudgetParamsSchema,
  GetGroupBudgetsResSchema,
  RemoveBudgetResSchema,
  SetBudgetBody,
  SetBudgetReqBodySchema,
  SetBudgetResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/budget.routes.schema';

export const budgetRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyBudgetController({ module });
  const tags = ['budgets'];

  fastify.put<{ Params: { id: string; category: string }; Body: SetBudgetBody }>(
    '/groups/:id/budgets/:category',
    { schema: { tags, params: BudgetParamsSchema, body: SetBudgetReqBodySchema, response: SetBudgetResSchema } },
    controller.setBudget.bind(controller),
  );

  fastify.delete<{ Params: { id: string; category: string } }>(
    '/groups/:id/budgets/:category',
    { schema: { tags, params: BudgetParamsSchema, response: RemoveBudgetResSchema } },
    controller.removeBudget.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/budgets',
    { schema: { tags, response: GetGroupBudgetsResSchema } },
    controller.getGroupBudgets.bind(controller),
  );

  done();
};
