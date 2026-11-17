import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { acceptInvitation, createInvitation, getInvitation } from '@Contexts/Groups/Application/Invitations';

/**
 * The invitations' routes (feature 3, the API's fragment 4): a member creates an invitation to their group, whose id is the
 * link; a signed-in person reads it, and accepts it to join. Each answers its use case at once. The paths are whole,
 * mounted at the root beside the groups' (ADR 5: a context has one mount).
 */
export const invitationRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Params: { id: string } }>('/groups/:id/invitations', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(createInvitation), req.params.id, { created: true }),
  );

  fastify.get<{ Params: { id: string } }>('/invitations/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getInvitation), req.params.id),
  );

  fastify.post<{ Params: { id: string } }>('/invitations/:id/accept', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(acceptInvitation), req.params.id),
  );

  done();
};
