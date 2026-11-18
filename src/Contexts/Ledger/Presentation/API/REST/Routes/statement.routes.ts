import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyStatementController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyStatementController';
import {
  GetMemberStatementCsvResSchema,
  GetMemberStatementResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/statement.routes.schema';

export const statementRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyStatementController({ module: ledgerModule });

  fastify.get(
    '/groups/:id/members/:memberId/statement',
    { schema: { tags: ['statements'], response: GetMemberStatementResSchema } },
    controller.getMemberStatement.bind(controller),
  );
  fastify.get(
    '/groups/:id/members/:memberId/statement.csv',
    { schema: { tags: ['statements'], response: GetMemberStatementCsvResSchema } },
    controller.getMemberStatementCsv.bind(controller),
  );

  done();
};
