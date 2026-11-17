import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { createGroup, getGroup, getMyGroups } from '@Contexts/Groups/Application/Groups';

/** The bodies say their shape only (API-BODY-SHAPE): whether a currency or a name is allowed is the domain's to refuse. */
const createGroupBody = {
  type: 'object',
  required: ['name', 'currency'],
  properties: { name: { type: 'string' }, currency: { type: 'string' } },
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

  done();
};
