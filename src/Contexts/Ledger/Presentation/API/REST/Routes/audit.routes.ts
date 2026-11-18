import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyAuditController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyAuditController';
import { GetGroupAuditResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/audit.routes.schema';

export const auditRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyAuditController({ module });
  const tags = ['audit'];

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/audit',
    { schema: { tags, response: GetGroupAuditResSchema } },
    controller.getGroupAudit.bind(controller),
  );

  done();
};
