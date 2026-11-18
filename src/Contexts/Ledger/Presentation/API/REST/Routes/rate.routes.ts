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

  fastify.get(
    '/groups/:id/rates/:currency',
    { schema: { tags: ['rates'], response: GetOfferedRateResSchema } },
    controller.getOfferedRate.bind(controller),
  );

  done();
};
