import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyRateController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyRateController';
import { GetOfferedRateResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/rate.routes.schema';

export const rateRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyRateController({ module });
  const tags = ['rates'];

  fastify.get<{ Params: { id: string; currency: string }; Querystring: { date?: string } }>(
    '/groups/:id/rates/:currency',
    { schema: { tags, response: GetOfferedRateResSchema } },
    controller.getOfferedRate.bind(controller),
  );

  done();
};
