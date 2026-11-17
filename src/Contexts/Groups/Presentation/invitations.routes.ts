import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { acceptInvitation, getInvitation } from '@Contexts/Groups/Application/Invitations';

/** The invitations' routes, under `/v1/invitations` (the API's root, each route its full path: docs/adr/0003): each answers its use case at once. */
export const invitationRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string } }>('/invitations/:id', { schema: { tags: ['invitations'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getInvitation), { id: req.params.id }),
  );

  fastify.post<{ Params: { id: string } }>(
    '/invitations/:id/accept',
    { schema: { tags: ['invitations'] } },
    (req, reply) => answerAtOnce(req, reply, module.useCase(acceptInvitation), { id: req.params.id }),
  );

  done();
};
