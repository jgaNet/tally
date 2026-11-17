import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyBalanceController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyBalanceController';
import { GetGroupBalancesResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/balance.routes.schema';

export const balanceRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyBalanceController({ module: ledgerModule });

  fastify.get(
    '/groups/:id/balances',
    { schema: { tags: ['balances'], response: GetGroupBalancesResSchema } },
    controller.getGroupBalances.bind(controller),
  );

  done();
};
