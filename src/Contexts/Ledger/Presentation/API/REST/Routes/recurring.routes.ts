import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyRecurringExpenseController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyRecurringExpenseController';
import {
  GetGroupRecurringResSchema,
  GetRecurringResSchema,
  LaterCommandResSchema,
  SetUpRecurringBodySchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/recurring.routes.schema';

export const recurringRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyRecurringExpenseController({ module: ledgerModule });

  // Whole paths, registered at the API's root beside the groups' and the expenses'.
  fastify.post(
    '/groups/:id/recurring',
    { schema: { tags: ['recurring'], body: SetUpRecurringBodySchema, response: LaterCommandResSchema } },
    controller.setUp.bind(controller),
  );

  fastify.get(
    '/recurring/:id',
    { schema: { tags: ['recurring'], response: GetRecurringResSchema } },
    controller.getRecurring.bind(controller),
  );

  fastify.get(
    '/groups/:id/recurring',
    { schema: { tags: ['recurring'], response: GetGroupRecurringResSchema } },
    controller.getGroupRecurring.bind(controller),
  );

  // Answered 202 and read at the operation: its payer or the owner stops it.
  fastify.delete(
    '/recurring/:id',
    { schema: { tags: ['recurring'], response: LaterCommandResSchema } },
    controller.stop.bind(controller),
  );

  done();
};
