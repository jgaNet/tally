import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  archiveGroup,
  createGroup,
  getGroup,
  getGroupMembers,
  getMyGroups,
  leaveGroup,
  mergeGroups,
} from '@Contexts/Groups/Application/Groups';
import { createInvitation } from '@Contexts/Groups/Application/Invitations';

/** The bodies say their shape only (API-BODY-SHAPE): whether a currency or a name is allowed is the domain's to refuse. */
const createGroupBody = {
  type: 'object',
  required: ['name', 'currency'],
  properties: { name: { type: 'string' }, currency: { type: 'string' } },
};

/** The merge's body names the group merged, as a string (API-BODY-SHAPE). */
const mergeGroupBody = {
  type: 'object',
  required: ['from'],
  properties: { from: { type: 'string' } },
};

/** The groups' routes, under `/v1/groups` (the API's root, each route its full path: docs/adr/0003): each answers its use case at once, and nothing else. */
export const groupRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Body: { name: string; currency: string } }>(
    '/groups',
    { schema: { body: createGroupBody, tags: ['groups'] } },
    (req, reply) => answerAtOnce(req, reply, module.useCase(createGroup), req.body, { created: true }),
  );

  fastify.get('/groups/mine', { schema: { tags: ['groups'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMyGroups), undefined),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id', { schema: { tags: ['groups'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroup), { id: req.params.id }),
  );

  fastify.post<{ Params: { id: string } }>('/groups/:id/invitations', { schema: { tags: ['groups'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(createInvitation), { groupId: req.params.id }, { created: true }),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/members', { schema: { tags: ['groups'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupMembers), { id: req.params.id }),
  );

  fastify.post<{ Params: { id: string } }>('/groups/:id/leave', { schema: { tags: ['groups'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(leaveGroup), { groupId: req.params.id }),
  );

  fastify.post<{ Params: { id: string } }>('/groups/:id/archive', { schema: { tags: ['groups'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(archiveGroup), { groupId: req.params.id }),
  );

  // The group merged is named in the body (request 31): its shape only, and the domain says whether it may be merged.
  fastify.post<{ Params: { id: string }; Body: { from: string } }>(
    '/groups/:id/merge',
    { schema: { body: mergeGroupBody, tags: ['groups'] } },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(mergeGroups), { groupId: req.params.id, from: req.body.from }),
  );

  done();
};
