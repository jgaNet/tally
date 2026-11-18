import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyInsightController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyInsightController';
import { GetMyInsightsResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/insight.routes.schema';

export const insightRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyInsightController({ module });
  const tags = ['insights'];

  fastify.get(
    '/accounts/me/insights',
    { schema: { tags, response: GetMyInsightsResSchema } },
    controller.getMyInsights.bind(controller),
  );

  done();
};
