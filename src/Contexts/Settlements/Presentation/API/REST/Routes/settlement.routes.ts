import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifySettlementController } from '@Contexts/Settlements/Presentation/API/REST/Controllers/FastifySettlementController';
import { GetSuggestedSettlementsResSchema } from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

export const settlementRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifySettlementController({ module });
  const tags = ['settlements'];

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    { schema: { tags, response: GetSuggestedSettlementsResSchema } },
    controller.getSuggestedSettlements.bind(controller),
  );

  done();
};
