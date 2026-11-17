import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyStatementController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyStatementController';
import { GetMemberStatementResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/statement.routes.schema';

export const statementRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyStatementController({ module });
  const tags = ['statements'];

  fastify.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement',
    { schema: { tags, response: GetMemberStatementResSchema } },
    controller.getMemberStatement.bind(controller),
  );

  done();
};
