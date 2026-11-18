import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyTemplateController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyTemplateController';
import {
  GetGroupTemplatesResSchema,
  RemoveTemplateResSchema,
  ReplaceTemplateBodySchema,
  ReplaceTemplateResSchema,
  SaveTemplateBodySchema,
  SaveTemplateResSchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/template.routes.schema';

export const templateRoutes = function (
  fastify: FastifyInstance,
  { ledgerModule }: { ledgerModule: Module },
  done: () => void,
) {
  const controller = new FastifyTemplateController({ module: ledgerModule });

  fastify.post(
    '/groups/:id/templates',
    { schema: { tags: ['templates'], body: SaveTemplateBodySchema, response: SaveTemplateResSchema } },
    controller.saveTemplate.bind(controller),
  );
  fastify.get(
    '/groups/:id/templates',
    { schema: { tags: ['templates'], response: GetGroupTemplatesResSchema } },
    controller.getGroupTemplates.bind(controller),
  );
  fastify.put(
    '/templates/:id',
    { schema: { tags: ['templates'], body: ReplaceTemplateBodySchema, response: ReplaceTemplateResSchema } },
    controller.replaceTemplate.bind(controller),
  );
  fastify.delete(
    '/templates/:id',
    { schema: { tags: ['templates'], response: RemoveTemplateResSchema } },
    controller.removeTemplate.bind(controller),
  );

  done();
};
