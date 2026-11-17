import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getSettlement, recordCashSettlement } from '@Contexts/Settlements/Application/Settlements';
import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';

/** The body of a cash settlement: its shape only; whether the amount is at least 1 and allowed is the domain's (request 12). */
type RecordCashBody = { readonly from: string; readonly amount: number };

/**
 * The settlements' routes: the suggested settlements (request 11, the API's fragment 11), and a cash settlement recorded by its payee
 * and read back by a member of its group (request 12, fragment 12). Each answers its use case at once. A body whose shape is wrong
 * (a missing `from` or `amount`, or an amount that is not a whole number) is `400` before the use case runs. A caller who is not a
 * member of the group gets the group's `404`, and a settlement of a group they are not in does not exist for them.
 */
export const settlementRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string } }>('/groups/:id/settlements/suggested', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSuggestedSettlements), req.params.id),
  );

  fastify.post<{ Params: { id: string }; Body: RecordCashBody }>(
    '/groups/:id/settlements/cash',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from', 'amount'],
          properties: { from: { type: 'string' }, amount: { type: 'integer' } },
        },
      },
    },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(recordCashSettlement),
        { groupId: req.params.id, from: req.body.from, amount: req.body.amount },
        { created: true },
      ),
  );

  fastify.get<{ Params: { id: string } }>('/settlements/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSettlement), req.params.id),
  );

  done();
};
