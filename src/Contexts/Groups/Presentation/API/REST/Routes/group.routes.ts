import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyGroupController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyGroupController';
import {
  CreateGroupBodySchema,
  CreateGroupResSchema,
  GetGroupMembersResSchema,
  GetGroupResSchema,
  GetInvitationResSchema,
  GetMyGroupsResSchema,
  LaterCommandResSchema,
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

  // An invitation is the link a member shares: its id is what the link carries (request 3).
  fastify.post(
    '/groups/:id/invitations',
    { schema: { tags: ['invitations'], response: LaterCommandResSchema } },
    controller.createInvitation.bind(controller),
  );

  fastify.get(
    '/groups/:id/members',
    { schema: { tags: ['groups'], response: GetGroupMembersResSchema } },
    controller.getGroupMembers.bind(controller),
  );

  fastify.get(
    '/invitations/:id',
    { schema: { tags: ['invitations'], response: GetInvitationResSchema } },
    controller.getInvitation.bind(controller),
  );

  fastify.post(
    '/invitations/:id/accept',
    { schema: { tags: ['invitations'], response: LaterCommandResSchema } },
    controller.acceptInvitation.bind(controller),
  );

  done();
};
