import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyInvitationController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyInvitationController';
import {
  AcceptInvitationResSchema,
  GetInvitationResSchema,
} from '@Contexts/Groups/Presentation/API/REST/Routes/invitation.routes.schema';

export const invitationRoutes = function (
  fastify: FastifyInstance,
  { groupsModule }: { groupsModule: Module },
  done: () => void,
) {
  const controller = new FastifyInvitationController({ module: groupsModule });

  fastify.get(
    '/invitations/:id',
    { schema: { tags: ['invitations'], response: GetInvitationResSchema } },
    controller.getInvitation.bind(controller),
  );
  fastify.post(
    '/invitations/:id/accept',
    { schema: { tags: ['invitations'], response: AcceptInvitationResSchema } },
    controller.acceptInvitation.bind(controller),
  );

  done();
};
