import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import { getGroupAudit } from '@Contexts/Ledger/Application/Audit';

/** The audit's route, under `/v1` (request 28): a member of the group reads every change of money in it, the oldest first. */
export const auditRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/groups/:id/audit', { schema: { tags: ['audit'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupAudit), { id: (req.params as { id: string }).id }),
  );

  done();
};
