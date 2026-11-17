import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyGroupController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyGroupController';
import {
  CreateGroupBodySchema,
  CreateGroupResSchema,
  GetGroupResSchema,
  GetMyGroupsResSchema,
} from '@Contexts/Groups/Presentation/API/REST/Routes/group.routes.schema';

export const groupRoutes = function (
  fastify: FastifyInstance,
  { groupsModule }: { groupsModule: Module },
  done: () => void,
) {
  const controller = new FastifyGroupController({ module: groupsModule });

  // Whole paths, registered at the API's root beside the accounts'. The static `/mine` is matched before `/:id`.
  fastify.post(
    '/groups',
    { schema: { tags: ['groups'], body: CreateGroupBodySchema, response: CreateGroupResSchema } },
    controller.createGroup.bind(controller),
  );

  fastify.get(
    '/groups/mine',
    { schema: { tags: ['groups'], response: GetMyGroupsResSchema } },
    controller.getMyGroups.bind(controller),
  );

  fastify.get(
    '/groups/:id',
    { schema: { tags: ['groups'], response: GetGroupResSchema } },
    controller.getGroup.bind(controller),
  );

  done();
};
