import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyBalanceController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyBalanceController';
import { GetBalancesResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/balance.routes.schema';

export const balanceRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyBalanceController({ module: ledgerModule });

  // The whole path, registered at the API's root beside the groups' and the expenses'.
  fastify.get(
    '/groups/:id/balances',
    { schema: { tags: ['balances'], response: GetBalancesResSchema } },
    controller.getBalances.bind(controller),
  );

  done();
};
