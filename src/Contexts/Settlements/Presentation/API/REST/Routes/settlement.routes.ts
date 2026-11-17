import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifySettlementController } from '@Contexts/Settlements/Presentation/API/REST/Controllers/FastifySettlementController';
import { GetSuggestedSettlementsResSchema } from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

export const settlementRoutes = function (
  fastify: FastifyInstance,
  { settlementsModule }: { settlementsModule: Module },
  done: () => void,
) {
  const controller = new FastifySettlementController({ module: settlementsModule });

  // The whole path, registered at the API's root beside the groups', the expenses' and the balances'.
  fastify.get(
    '/groups/:id/settlements/suggested',
    { schema: { tags: ['settlements'], response: GetSuggestedSettlementsResSchema } },
    controller.getSuggested.bind(controller),
  );

  done();
};
