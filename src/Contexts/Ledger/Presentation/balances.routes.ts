import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getGroupBalances } from '@Contexts/Ledger/Application/Balances';

/**
 * The balances' route (request 5, the API's fragment 6): a member of a group reads every member's balance, in the order they
 * joined. It answers its use case at once; a caller who is not a member gets the group's `404`.
 */
export const balanceRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string } }>('/groups/:id/balances', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupBalances), req.params.id),
  );

  done();
};
