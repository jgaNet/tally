import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyStatementController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyStatementController';
import { GetStatementResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/statement.routes.schema';

export const statementRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyStatementController({ module: ledgerModule });

  // The whole path, registered at the API's root beside the groups' balances (request 8).
  fastify.get(
    '/groups/:id/members/:memberId/statement',
    { schema: { tags: ['statements'], response: GetStatementResSchema } },
    controller.getStatement.bind(controller),
  );

  done();
};
