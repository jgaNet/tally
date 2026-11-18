import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getAdministratorsLog, reinstateAccount, suspendAccount } from '@Contexts/Groups/Application/Administration';

/**
 * The administrators' routes, at the API's root with their full path (docs/adr/0003): each answers its use case at once, and nothing else.
 * The log, and the suspension of an account and its reinstatement (request 34), are for an administrator.
 */
export const administrationRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/admin/log', { schema: { tags: ['administration'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getAdministratorsLog), undefined),
  );

  fastify.put<{ Params: { id: string } }>(
    '/admin/accounts/:id/suspension',
    { schema: { tags: ['administration'] } },
    (req, reply) => answerAtOnce(req, reply, module.useCase(suspendAccount), { id: req.params.id }),
  );

  fastify.delete<{ Params: { id: string } }>(
    '/admin/accounts/:id/suspension',
    { schema: { tags: ['administration'] } },
    (req, reply) => answerAtOnce(req, reply, module.useCase(reinstateAccount), { id: req.params.id }),
  );

  done();
};
