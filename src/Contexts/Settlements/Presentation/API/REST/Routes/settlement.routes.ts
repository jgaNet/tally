import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifySettlementController } from '@Contexts/Settlements/Presentation/API/REST/Controllers/FastifySettlementController';
import {
  GetSettlementResSchema,
  GetSuggestedSettlementsResSchema,
  RecordCashSettlementBody,
  RecordCashSettlementReqBodySchema,
  RecordCashSettlementResSchema,
} from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

export const settlementRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifySettlementController({ module });
  const tags = ['settlements'];

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    { schema: { tags, response: GetSuggestedSettlementsResSchema } },
    controller.getSuggestedSettlements.bind(controller),
  );

  fastify.post<{ Params: { id: string }; Body: RecordCashSettlementBody }>(
    '/groups/:id/settlements/cash',
    { schema: { tags, body: RecordCashSettlementReqBodySchema, response: RecordCashSettlementResSchema } },
    controller.recordCashSettlement.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/settlements/:id',
    { schema: { tags, response: GetSettlementResSchema } },
    controller.getSettlement.bind(controller),
  );

  done();
};
