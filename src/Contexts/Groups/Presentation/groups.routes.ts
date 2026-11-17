import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import { createGroup, getGroup, getGroupMembers, getMyGroups, leaveGroup } from '@Contexts/Groups/Application/Groups';
import { acceptInvitation, createInvitation, getInvitation } from '@Contexts/Groups/Application/Invitations';

import { shapeOf } from './bodyShape';

type CreateGroupInput = { name: string; currency: string };

const createGroupBody = {
  type: 'object',
  required: ['name', 'currency'],
  properties: { name: { type: 'string' }, currency: { type: 'string' } },
};

/** The groups' routes, under `/v1` (every route is under the API's prefix). */
export const groupRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post(
    '/groups',
    {
      schema: { tags: ['groups'], body: createGroupBody },
      preValidation: shapeOf(['name', 'currency']),
    },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(createGroup), req.body as CreateGroupInput, { created: true }),
  );

  fastify.get('/groups/mine', { schema: { tags: ['groups'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMyGroups), undefined),
  );

  fastify.get('/groups/:id', { schema: { tags: ['groups'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroup), { id: (req.params as { id: string }).id }),
  );

  fastify.get('/groups/:id/members', { schema: { tags: ['groups'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupMembers), { id: (req.params as { id: string }).id }),
  );

  fastify.post('/groups/:id/leave', { schema: { tags: ['groups'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(leaveGroup), { id: (req.params as { id: string }).id }),
  );

  fastify.post('/groups/:id/invitations', { schema: { tags: ['invitations'] } }, (req, reply) =>
    answerAtOnce(
      req,
      reply,
      module.useCase(createInvitation),
      { id: (req.params as { id: string }).id },
      { created: true },
    ),
  );

  fastify.get('/invitations/:id', { schema: { tags: ['invitations'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getInvitation), { id: (req.params as { id: string }).id }),
  );

  fastify.post('/invitations/:id/accept', { schema: { tags: ['invitations'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(acceptInvitation), { id: (req.params as { id: string }).id }),
  );

  done();
};
