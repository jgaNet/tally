import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';

/**
 * The suggested settlements' route (request 11, the API's fragment 11): a member of a group reads the transfers that would bring
 * every balance to 0, in the order made. It answers its use case at once; a caller who is not a member gets the group's `404`.
 */
export const settlementRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string } }>('/groups/:id/settlements/suggested', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSuggestedSettlements), req.params.id),
  );

  done();
};
