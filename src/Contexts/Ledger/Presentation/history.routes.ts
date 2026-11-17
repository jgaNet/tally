import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getGroupExpenses, getMemberStatement } from '@Contexts/Ledger/Application/History';

/**
 * The history's routes (request 8, the API's fragment 9): a member of a group lists its expenses, the latest first, and reads any
 * member's statement, the earliest first. Each answers its use case at once; a caller who is not a member of the group gets the
 * group's `404`, and a statement of someone who was never a member of it gets `404` too.
 */
export const historyRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string } }>('/groups/:id/expenses', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupExpenses), req.params.id),
  );

  fastify.get<{ Params: { id: string; memberId: string } }>('/groups/:id/members/:memberId/statement', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMemberStatement), {
      groupId: req.params.id,
      memberId: req.params.memberId,
    }),
  );

  done();
};
