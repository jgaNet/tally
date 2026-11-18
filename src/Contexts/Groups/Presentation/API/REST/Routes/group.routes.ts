import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyGroupController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyGroupController';
import {
  CreateGroupReqBodySchema,
  CreateGroupResSchema,
  CreateInvitationResSchema,
  GetGroupMembersResSchema,
  GetGroupResSchema,
  GetMyGroupsResSchema,
  ArchiveGroupResSchema,
  LeaveGroupResSchema,
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

  fastify.post<{ Params: { id: string } }>(
    '/groups/:id/invitations',
    { schema: { tags, response: CreateInvitationResSchema } },
    controller.createInvitation.bind(controller),
  );

  fastify.post<{ Params: { id: string } }>(
    '/groups/:id/leave',
    { schema: { tags, response: LeaveGroupResSchema } },
    controller.leaveGroup.bind(controller),
  );

  fastify.post<{ Params: { id: string } }>(
    '/groups/:id/archive',
    { schema: { tags, response: ArchiveGroupResSchema } },
    controller.archiveGroup.bind(controller),
  );

  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/members',
    { schema: { tags, response: GetGroupMembersResSchema } },
    controller.getGroupMembers.bind(controller),
  );

  done();
};
