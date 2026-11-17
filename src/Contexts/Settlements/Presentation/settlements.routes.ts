import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Settlements';

/** The settlements' routes, under `/v1` (every route is under the API's prefix, the group's included). */
export const settlementRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/groups/:id/settlements/suggested', { schema: { tags: ['settlements'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSuggestedSettlements), { id: (req.params as { id: string }).id }),
  );

  done();
};
