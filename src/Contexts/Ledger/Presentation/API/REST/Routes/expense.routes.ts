import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyExpenseController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyExpenseController';
import {
  CreateExpenseBody,
  CreateExpenseReqBodySchema,
  EditExpenseBody,
  CreateExpenseResSchema,
  DeleteExpenseResSchema,
  EditExpenseReqBodySchema,
  EditExpenseResSchema,
  GetExpenseResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/expense.routes.schema';

export const expenseRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyExpenseController({ module });
  const tags = ['expenses'];

  fastify.post<{
    Params: { id: string };
    Body: CreateExpenseBody;
  }>(
    '/groups/:id/expenses',
    { schema: { tags, body: CreateExpenseReqBodySchema, response: CreateExpenseResSchema } },
    controller.recordExpense.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/expenses/:id',
    { schema: { tags, response: GetExpenseResSchema } },
    controller.getExpense.bind(controller),
  );

  fastify.put<{
    Params: { id: string };
    Body: EditExpenseBody;
  }>(
    '/expenses/:id',
    { schema: { tags, body: EditExpenseReqBodySchema, response: EditExpenseResSchema } },
    controller.editExpense.bind(controller),
  );

  fastify.delete<{ Params: { id: string } }>(
    '/expenses/:id',
    { schema: { tags, response: DeleteExpenseResSchema } },
    controller.deleteExpense.bind(controller),
  );

  done();
};
