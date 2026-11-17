import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyGroupController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyGroupController';
import {
  CreateGroupBodySchema,
  CreateGroupResSchema,
  CreateInvitationResSchema,
  GetGroupMembersResSchema,
  GetGroupResSchema,
  GetMyGroupsResSchema,
  LeaveGroupResSchema,
} from '@Contexts/Groups/Presentation/API/REST/Routes/group.routes.schema';

export const groupRoutes = function (
  fastify: FastifyInstance,
  { groupsModule }: { groupsModule: Module },
  done: () => void,
) {
  const controller = new FastifyGroupController({ module: groupsModule });

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
  fastify.post(
    '/groups/:id/invitations',
    { schema: { tags: ['invitations'], response: CreateInvitationResSchema } },
    controller.createInvitation.bind(controller),
  );
  fastify.get(
    '/groups/:id/members',
    { schema: { tags: ['groups'], response: GetGroupMembersResSchema } },
    controller.getMembers.bind(controller),
  );
  fastify.post(
    '/groups/:id/leave',
    { schema: { tags: ['groups'], response: LeaveGroupResSchema } },
    controller.leaveGroup.bind(controller),
  );

  done();
};
