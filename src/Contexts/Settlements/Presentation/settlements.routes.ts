import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getSettlement, recordCashSettlement } from '@Contexts/Settlements/Application/Settlements';
import { payThroughProvider } from '@Contexts/Settlements/Application/Payments';
import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';

/**
 * The settlements' routes, at the API's root with their full path (docs/adr/0003): each answers its use case at once. A body says
 * its shape only (API-BODY-SHAPE): whether an amount is allowed is the domain's to refuse, as a `422`.
 */
export const settlementRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    { schema: { tags: ['settlements'] } },
    (req, reply) => answerAtOnce(req, reply, module.useCase(getSuggestedSettlements), { groupId: req.params.id }),
  );

  fastify.post<{ Params: { id: string }; Body: { from: string; amount: number } }>(
    '/groups/:id/settlements/cash',
    {
      schema: {
        tags: ['settlements'],
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

  fastify.post<{ Params: { id: string }; Body: { to: string; amount: number } }>(
    '/groups/:id/settlements/provider',
    {
      schema: {
        tags: ['settlements'],
        body: {
          type: 'object',
          required: ['to', 'amount'],
          properties: { to: { type: 'string' }, amount: { type: 'integer' } },
        },
      },
    },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(payThroughProvider),
        { groupId: req.params.id, to: req.body.to, amount: req.body.amount },
        { created: true },
      ),
  );

  fastify.get<{ Params: { id: string } }>('/settlements/:id', { schema: { tags: ['settlements'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSettlement), { id: req.params.id }),
  );

  done();
};
