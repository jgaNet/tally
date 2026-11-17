import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyExpenseController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyExpenseController';
import {
  GetExpenseResSchema,
  LaterCommandResSchema,
  RecordExpenseBodySchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

export const expenseRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyExpenseController({ module: ledgerModule });

  // Whole paths, registered at the API's root beside the groups'.
  fastify.post(
    '/groups/:id/expenses',
    { schema: { tags: ['expenses'], body: RecordExpenseBodySchema, response: LaterCommandResSchema } },
    controller.recordExpense.bind(controller),
  );

  fastify.get(
    '/expenses/:id',
    { schema: { tags: ['expenses'], response: GetExpenseResSchema } },
    controller.getExpense.bind(controller),
  );

  done();
};
