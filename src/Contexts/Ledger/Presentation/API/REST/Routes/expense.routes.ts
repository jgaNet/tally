import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyExpenseController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyExpenseController';
import {
  EditExpenseBodySchema,
  GetExpenseResSchema,
  GetGroupExpensesResSchema,
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

  // Answered 202 and read at the operation: an edit from the version its author read, or a deletion (request 6).
  fastify.put(
    '/expenses/:id',
    { schema: { tags: ['expenses'], body: EditExpenseBodySchema, response: LaterCommandResSchema } },
    controller.editExpense.bind(controller),
  );

  fastify.delete(
    '/expenses/:id',
    { schema: { tags: ['expenses'], response: LaterCommandResSchema } },
    controller.deleteExpense.bind(controller),
  );

  // The group's expenses, the latest date first (request 8). A whole path, like the group's other expense routes.
  fastify.get(
    '/groups/:id/expenses',
    { schema: { tags: ['expenses'], response: GetGroupExpensesResSchema } },
    controller.getGroupExpenses.bind(controller),
  );

  fastify.get(
    '/expenses/:id',
    { schema: { tags: ['expenses'], response: GetExpenseResSchema } },
    controller.getExpense.bind(controller),
  );

  done();
};
