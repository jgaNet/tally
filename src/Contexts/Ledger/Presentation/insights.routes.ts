import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getMyInsights } from '@Contexts/Ledger/Application/Insights';

/** The route of the spending insights (request 37): the caller's own, at once; a caller who is not signed in is refused with 401 by the transport. */
export const insightRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/accounts/me/insights', { schema: { tags: ['insights'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMyInsights), undefined),
  );

  done();
};
