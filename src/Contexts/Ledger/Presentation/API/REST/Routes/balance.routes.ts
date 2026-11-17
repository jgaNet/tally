import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyBalanceController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyBalanceController';
import { GetGroupBalancesResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/balance.routes.schema';

export const balanceRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyBalanceController({ module });
  const tags = ['balances'];

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/balances',
    { schema: { tags, response: GetGroupBalancesResSchema } },
    controller.getGroupBalances.bind(controller),
  );

  done();
};
