import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getGroupAudit } from '@Contexts/Ledger/Application/Audit';

/**
 * The audit's route (request 28, the API's fragment 28): a member of a group reads every change of money in it, the oldest first. A caller
 * who is not a member gets the group's `404`.
 */
export const auditRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string } }>('/groups/:id/audit', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupAudit), req.params.id),
  );

  done();
};
