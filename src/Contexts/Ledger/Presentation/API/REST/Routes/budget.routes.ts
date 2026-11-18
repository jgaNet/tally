import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyBudgetController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyBudgetController';
import {
  GetBudgetsResSchema,
  LaterCommandResSchema,
  SetBudgetBodySchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/budget.routes.schema';

export const budgetRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyBudgetController({ module: ledgerModule });

  // Whole paths, registered at the API's root beside the groups' and the expenses'. Answered 202 and read at the operation.
  fastify.put(
    '/groups/:id/budgets/:category',
    { schema: { tags: ['budgets'], body: SetBudgetBodySchema, response: LaterCommandResSchema } },
    controller.setBudget.bind(controller),
  );

  fastify.delete(
    '/groups/:id/budgets/:category',
    { schema: { tags: ['budgets'], response: LaterCommandResSchema } },
    controller.removeBudget.bind(controller),
  );

  fastify.get(
    '/groups/:id/budgets',
    { schema: { tags: ['budgets'], response: GetBudgetsResSchema } },
    controller.getBudgets.bind(controller),
  );

  done();
};
