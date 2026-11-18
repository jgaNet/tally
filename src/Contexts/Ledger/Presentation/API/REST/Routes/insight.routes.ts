import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyInsightController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyInsightController';
import { GetInsightsResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/insight.routes.schema';

export const insightRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyInsightController({ module: ledgerModule });

  // The whole path, registered at the API's root beside the accounts' (request 37): what the signed-in person spent, to them only.
  fastify.get(
    '/accounts/me/insights',
    { schema: { tags: ['accounts'], response: GetInsightsResSchema } },
    controller.getInsights.bind(controller),
  );

  done();
};
