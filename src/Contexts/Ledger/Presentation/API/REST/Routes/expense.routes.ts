import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyExpenseController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyExpenseController';
import {
  DeleteExpenseResSchema,
  EditExpenseBodySchema,
  EditExpenseResSchema,
  GetExpenseResSchema,
  GetGroupExpensesResSchema,
  RecordExpenseBodySchema,
  RecordExpenseResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

export const expenseRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyExpenseController({ module: ledgerModule });

  fastify.post(
    '/groups/:id/expenses',
    {
      schema: { tags: ['expenses'], body: RecordExpenseBodySchema, response: RecordExpenseResSchema },
    },
    controller.recordExpense.bind(controller),
  );
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
  fastify.put(
    '/expenses/:id',
    { schema: { tags: ['expenses'], body: EditExpenseBodySchema, response: EditExpenseResSchema } },
    controller.editExpense.bind(controller),
  );
  fastify.delete(
    '/expenses/:id',
    { schema: { tags: ['expenses'], response: DeleteExpenseResSchema } },
    controller.deleteExpense.bind(controller),
  );

  done();
};
