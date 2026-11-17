import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifySettlementController } from '@Contexts/Settlements/Presentation/API/REST/Controllers/FastifySettlementController';
import {
  GetSettlementResSchema,
  GetSuggestedSettlementsResSchema,
  RecordCashSettlementBodySchema,
  RecordCashSettlementResSchema,
} from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

export const settlementRoutes = function (
  fastify: FastifyInstance,
  { settlementsModule }: { settlementsModule: Module },
  done: () => void,
) {
  const controller = new FastifySettlementController({ module: settlementsModule });

  fastify.get(
    '/groups/:id/settlements/suggested',
    { schema: { tags: ['settlements'], response: GetSuggestedSettlementsResSchema } },
    controller.getSuggestedSettlements.bind(controller),
  );
  fastify.post(
    '/groups/:id/settlements/cash',
    {
      schema: {
        tags: ['settlements'],
        body: RecordCashSettlementBodySchema,
        response: RecordCashSettlementResSchema,
      },
    },
    controller.recordCashSettlement.bind(controller),
  );
  fastify.get(
    '/settlements/:id',
    { schema: { tags: ['settlements'], response: GetSettlementResSchema } },
    controller.getSettlement.bind(controller),
  );

  done();
};
