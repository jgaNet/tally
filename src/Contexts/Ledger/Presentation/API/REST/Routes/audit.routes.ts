import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyAuditController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyAuditController';
import { GetGroupAuditResSchema } from '@Contexts/Ledger/Presentation/API/REST/Routes/audit.routes.schema';

export const auditRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyAuditController({ module: ledgerModule });

  // The whole path, registered at the API's root beside the groups' and the expenses'.
  fastify.get(
    '/groups/:id/audit',
    { schema: { tags: ['audit'], response: GetGroupAuditResSchema } },
    controller.getAudit.bind(controller),
  );

  done();
};
