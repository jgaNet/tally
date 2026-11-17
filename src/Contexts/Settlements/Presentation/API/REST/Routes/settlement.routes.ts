import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifySettlementController } from '@Contexts/Settlements/Presentation/API/REST/Controllers/FastifySettlementController';
import {
  GetSettlementResSchema,
  GetSuggestedSettlementsResSchema,
  LaterCommandResSchema,
  RecordCashSettlementBodySchema,
} from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

export const settlementRoutes = function (
  fastify: FastifyInstance,
  { settlementsModule }: { settlementsModule: Module },
  done: () => void,
) {
  const controller = new FastifySettlementController({ module: settlementsModule });

  // The whole paths, registered at the API's root beside the groups', the expenses' and the balances'.
  fastify.get(
    '/groups/:id/settlements/suggested',
    { schema: { tags: ['settlements'], response: GetSuggestedSettlementsResSchema } },
    controller.getSuggested.bind(controller),
  );

  // Answered 202 and read at the operation: a payment in cash the caller received (request 12).
  fastify.post(
    '/groups/:id/settlements/cash',
    { schema: { tags: ['settlements'], body: RecordCashSettlementBodySchema, response: LaterCommandResSchema } },
    controller.recordCash.bind(controller),
  );

  fastify.get(
    '/settlements/:id',
    { schema: { tags: ['settlements'], response: GetSettlementResSchema } },
    controller.getSettlement.bind(controller),
  );

  done();
};
