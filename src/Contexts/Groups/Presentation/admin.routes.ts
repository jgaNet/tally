import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getAdministratorsLog } from '@Contexts/Groups/Application/AdministratorLog';
import { reinstateAccount, suspendAccount } from '@Contexts/Groups/Application/AccountSuspensions';

/**
 * The administrators' log, under `/v1/admin/log` (request 33, the API's fragment 33): answered at once, the oldest first. Only an administrator
 * reads it; anyone else gets the `404` the log does not exist for them with, and no caller at all gets the `401`. An account is suspended and
 * reinstated under `/v1/admin/accounts/{id}/suspension` (request 34), at once, by an administrator only.
 */
export const adminRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/admin/log', (req, reply) => answerAtOnce(req, reply, module.useCase(getAdministratorsLog), undefined));
  fastify.put<{ Params: { id: string } }>('/admin/accounts/:id/suspension', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(suspendAccount), req.params.id),
  );
  fastify.delete<{ Params: { id: string } }>('/admin/accounts/:id/suspension', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(reinstateAccount), req.params.id),
  );

  done();
};
