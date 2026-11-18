import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyBudgetController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyBudgetController';
import {
  GetGroupBudgetsResSchema,
  RemoveBudgetResSchema,
  SetBudgetBodySchema,
  SetBudgetResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/budget.routes.schema';

export const budgetRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyBudgetController({ module: ledgerModule });

  fastify.put(
    '/groups/:id/budgets/:category',
    { schema: { tags: ['budgets'], body: SetBudgetBodySchema, response: SetBudgetResSchema } },
    controller.setBudget.bind(controller),
  );
  fastify.delete(
    '/groups/:id/budgets/:category',
    { schema: { tags: ['budgets'], response: RemoveBudgetResSchema } },
    controller.removeBudget.bind(controller),
  );
  fastify.get(
    '/groups/:id/budgets',
    { schema: { tags: ['budgets'], response: GetGroupBudgetsResSchema } },
    controller.getGroupBudgets.bind(controller),
  );

  done();
};
