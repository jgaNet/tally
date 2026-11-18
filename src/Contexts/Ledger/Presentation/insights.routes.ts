import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getMyInsights } from '@Contexts/Ledger/Application/Insights';

/**
 * The spending insights' route (request 37, the API's fragment 37): the signed-in person reads what they spent, by month, currency and
 * category, across the groups they are a member of now. It answers its use case at once; a caller with no session gets `401` before it runs.
 */
export const insightRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/accounts/me/insights', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMyInsights), undefined),
  );

  done();
};
