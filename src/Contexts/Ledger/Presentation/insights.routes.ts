import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import { getMyInsights } from '@Contexts/Ledger/Application/Insights';

/** The insights' route, under `/v1` (request 37): a signed-in person reads what they spent across their groups. */
export const insightRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/accounts/me/insights', { schema: { tags: ['insights'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMyInsights), undefined),
  );

  done();
};
