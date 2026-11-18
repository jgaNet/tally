import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getOfferedRate } from '@Contexts/Ledger/Application/Rates';

/**
 * The rates' route (request 22, the API's fragment 22): a member of a group reads the rate offered from a currency to the group's on a
 * day, the day being today when `date` is left out. It answers at once through the query: `200 { currency, date, rate }`, or the
 * `404` the query names when no rate is offered (and the same `404` to anyone who is not a member of the group). The path is whole,
 * mounted at the root beside the groups' (ADR 5: a context has one mount).
 */
export const ratesRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string; currency: string }; Querystring: { date?: string } }>(
    '/groups/:id/rates/:currency',
    {
      schema: {
        querystring: { type: 'object', properties: { date: { type: 'string' } } },
      },
    },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(getOfferedRate), {
        groupId: req.params.id,
        currency: req.params.currency,
        ...(req.query.date !== undefined && { date: req.query.date }),
      }),
  );

  done();
};
