import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyGroupController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyGroupController';
import {
  CreateGroupReqBodySchema,
  CreateGroupResSchema,
  GetGroupResSchema,
  GetMyGroupsResSchema,
} from '@Contexts/Groups/Presentation/API/REST/Routes/group.routes.schema';
import { CreateGroupPayload } from '@Contexts/Groups/Application/Commands';

export const groupRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyGroupController({ module });
  const tags = ['groups'];

  fastify.post<{ Body: CreateGroupPayload }>(
    '/groups',
    { schema: { tags, body: CreateGroupReqBodySchema, response: CreateGroupResSchema } },
    controller.createGroup.bind(controller),
  );

  fastify.get(
    '/groups/mine',
    { schema: { tags, response: GetMyGroupsResSchema } },
    controller.getMyGroups.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id',
    { schema: { tags, response: GetGroupResSchema } },
    controller.getGroup.bind(controller),
  );

  done();
};
