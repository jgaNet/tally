import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyInvitationController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyInvitationController';
import {
  AcceptInvitationResSchema,
  GetInvitationResSchema,
} from '@Contexts/Groups/Presentation/API/REST/Routes/invitation.routes.schema';

export const invitationRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyInvitationController({ module });
  const tags = ['invitations'];

  fastify.get<{ Params: { id: string } }>(
    '/invitations/:id',
    { schema: { tags, response: GetInvitationResSchema } },
    controller.getInvitation.bind(controller),
  );

  fastify.post<{ Params: { id: string } }>(
    '/invitations/:id/accept',
    { schema: { tags, response: AcceptInvitationResSchema } },
    controller.acceptInvitation.bind(controller),
  );

  done();
};
