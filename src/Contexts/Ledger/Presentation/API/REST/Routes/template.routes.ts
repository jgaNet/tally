import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyTemplateController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyTemplateController';
import {
  GetTemplatesResSchema,
  LaterCommandResSchema,
  TemplateBodySchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/template.routes.schema';

export const templateRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyTemplateController({ module: ledgerModule });

  // Whole paths, registered at the API's root beside the groups' and the expenses'. Answered 202 and read at the operation.
  fastify.post(
    '/groups/:id/templates',
    { schema: { tags: ['templates'], body: TemplateBodySchema, response: LaterCommandResSchema } },
    controller.saveTemplate.bind(controller),
  );

  fastify.get(
    '/groups/:id/templates',
    { schema: { tags: ['templates'], response: GetTemplatesResSchema } },
    controller.getGroupTemplates.bind(controller),
  );

  fastify.put(
    '/templates/:id',
    { schema: { tags: ['templates'], body: TemplateBodySchema, response: LaterCommandResSchema } },
    controller.replaceTemplate.bind(controller),
  );

  fastify.delete(
    '/templates/:id',
    { schema: { tags: ['templates'], response: LaterCommandResSchema } },
    controller.removeTemplate.bind(controller),
  );

  done();
};
