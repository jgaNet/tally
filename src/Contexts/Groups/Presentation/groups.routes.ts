import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  CreateGroupInput,
  archiveGroup,
  createGroup,
  getGroup,
  getGroupMembers,
  getMyGroups,
  leaveGroup,
  mergeGroups,
} from '@Contexts/Groups/Application/Groups';

/**
 * The groups' routes, under `/v1/groups` (ADR 5 and the API's fragment 3): each answers its use case at once. Their paths
 * are whole, mounted at the root beside the accounts' (ADR 5: a context has one mount). The body's
 * schema says its shape only, so a missing field or one of the wrong type is `400` before any use case runs; whether the
 * currency is one of the six, or the name fits, is the domain's to say (`422`).
 */
export const groupRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Body: CreateGroupInput }>(
    '/groups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'currency'],
          properties: {
            name: { type: 'string' },
            currency: { type: 'string' },
          },
        },
      },
    },
    (req, reply) => answerAtOnce(req, reply, module.useCase(createGroup), req.body, { created: true }),
  );

  fastify.get('/groups/mine', (req, reply) => answerAtOnce(req, reply, module.useCase(getMyGroups), undefined));

  fastify.get<{ Params: { id: string } }>('/groups/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroup), req.params.id),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/members', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupMembers), req.params.id),
  );

  fastify.post<{ Params: { id: string } }>('/groups/:id/leave', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(leaveGroup), req.params.id),
  );

  fastify.post<{ Params: { id: string }; Body: { from: string } }>(
    '/groups/:id/merge',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from'],
          properties: { from: { type: 'string' } },
        },
      },
    },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(mergeGroups), { groupId: req.params.id, from: req.body.from }),
  );

  fastify.post<{ Params: { id: string } }>('/groups/:id/archive', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(archiveGroup), req.params.id),
  );

  done();
};
