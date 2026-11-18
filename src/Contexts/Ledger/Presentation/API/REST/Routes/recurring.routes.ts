import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyRecurringController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyRecurringController';
import {
  GetGroupRecurringExpensesResSchema,
  GetRecurringExpenseResSchema,
  SetUpRecurringExpenseBodySchema,
  SetUpRecurringExpenseResSchema,
  StopRecurringExpenseResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/recurring.routes.schema';

export const recurringRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyRecurringController({ module: ledgerModule });

  fastify.post(
    '/groups/:id/recurring',
    {
      schema: { tags: ['recurring'], body: SetUpRecurringExpenseBodySchema, response: SetUpRecurringExpenseResSchema },
    },
    controller.setUpRecurringExpense.bind(controller),
  );
  fastify.get(
    '/recurring/:id',
    { schema: { tags: ['recurring'], response: GetRecurringExpenseResSchema } },
    controller.getRecurringExpense.bind(controller),
  );
  fastify.get(
    '/groups/:id/recurring',
    { schema: { tags: ['recurring'], response: GetGroupRecurringExpensesResSchema } },
    controller.getGroupRecurringExpenses.bind(controller),
  );
  fastify.delete(
    '/recurring/:id',
    { schema: { tags: ['recurring'], response: StopRecurringExpenseResSchema } },
    controller.stopRecurringExpense.bind(controller),
  );

  done();
};
