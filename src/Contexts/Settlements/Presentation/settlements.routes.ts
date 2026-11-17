import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';

/** The settlements' routes, at the API's root with their full path (docs/adr/0003): the suggestion answers its use case at once. */
export const settlementRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    { schema: { tags: ['settlements'] } },
    (req, reply) => answerAtOnce(req, reply, module.useCase(getSuggestedSettlements), { groupId: req.params.id }),
  );

  done();
};
