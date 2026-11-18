import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyRecurringExpenseController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyRecurringExpenseController';
import {
  GetGroupRecurringResSchema,
  GetRecurringResSchema,
  SetUpRecurringBody,
  SetUpRecurringReqBodySchema,
  SetUpRecurringResSchema,
  StopRecurringResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/recurring.routes.schema';

export const recurringRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyRecurringExpenseController({ module });
  const tags = ['recurring'];

  fastify.post<{ Params: { id: string }; Body: SetUpRecurringBody }>(
    '/groups/:id/recurring',
    { schema: { tags, body: SetUpRecurringReqBodySchema, response: SetUpRecurringResSchema } },
    controller.setUpRecurringExpense.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/recurring/:id',
    { schema: { tags, response: GetRecurringResSchema } },
    controller.getRecurringExpense.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/recurring',
    { schema: { tags, response: GetGroupRecurringResSchema } },
    controller.getGroupRecurringExpenses.bind(controller),
  );

  fastify.delete<{ Params: { id: string } }>(
    '/recurring/:id',
    { schema: { tags, response: StopRecurringResSchema } },
    controller.stopRecurringExpense.bind(controller),
  );

  done();
};
