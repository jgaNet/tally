import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyTemplateController } from '@Contexts/Ledger/Presentation/API/REST/Controllers/FastifyTemplateController';
import {
  GetGroupTemplatesResSchema,
  RemoveTemplateResSchema,
  ReplaceTemplateResSchema,
  SaveTemplateResSchema,
  TemplateBody,
  TemplateReqBodySchema,
} from '@Contexts/Ledger/Presentation/API/REST/Routes/template.routes.schema';

export const templateRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyTemplateController({ module });
  const tags = ['templates'];

  fastify.post<{ Params: { id: string }; Body: TemplateBody }>(
    '/groups/:id/templates',
    { schema: { tags, body: TemplateReqBodySchema, response: SaveTemplateResSchema } },
    controller.saveTemplate.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/templates',
    { schema: { tags, response: GetGroupTemplatesResSchema } },
    controller.getGroupTemplates.bind(controller),
  );

  fastify.put<{ Params: { id: string }; Body: TemplateBody }>(
    '/templates/:id',
    { schema: { tags, body: TemplateReqBodySchema, response: ReplaceTemplateResSchema } },
    controller.replaceTemplate.bind(controller),
  );

  fastify.delete<{ Params: { id: string } }>(
    '/templates/:id',
    { schema: { tags, response: RemoveTemplateResSchema } },
    controller.removeTemplate.bind(controller),
  );

  done();
};
