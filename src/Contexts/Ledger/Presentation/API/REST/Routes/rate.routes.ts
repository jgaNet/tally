import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyRateController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyRateController';
import { GetOfferedRateResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/rate.routes.schema';

export const rateRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyRateController({ module: ledgerModule });

  // The whole path, registered at the API's root beside the groups' other routes (request 22).
  fastify.get(
    '/groups/:id/rates/:currency',
    { schema: { tags: ['rates'], response: GetOfferedRateResSchema } },
    controller.getOfferedRate.bind(controller),
  );

  done();
};
