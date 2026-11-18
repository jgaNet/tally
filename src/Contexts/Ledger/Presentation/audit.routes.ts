import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getGroupAudit } from '@Contexts/Ledger/Application/Audit';

/** The route of a group's audit (request 28, docs/adr/0027): a query, answered at once with the entries, the oldest first. */
export const auditRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string } }>('/groups/:id/audit', { schema: { tags: ['audit'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupAudit), { groupId: req.params.id }),
  );

  done();
};
