import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import {
  getSettlement,
  getSuggestedSettlements,
  recordCashSettlement,
  RecordCashSettlementInput,
} from '@Contexts/Settlements/Application/Settlements';

const SHAPE_REFUSAL = 'The body must have from (the payer account id, a string) and amount (a whole number)';

/** A cash settlement's body: the payer's account id and the amount, each of the type the domain takes (API-BODY-SHAPE). */
const hasShape = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;
  const { from, amount } = body as Record<string, unknown>;
  return typeof from === 'string' && Number.isInteger(amount);
};

/** The settlements' routes, under `/v1` (every route is under the API's prefix, the group's included). */
export const settlementRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/groups/:id/settlements/suggested', { schema: { tags: ['settlements'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSuggestedSettlements), { id: (req.params as { id: string }).id }),
  );

  fastify.post(
    '/groups/:id/settlements/cash',
    {
      schema: { tags: ['settlements'] },
      preValidation: async (request, reply) => {
        if (!hasShape(request.body)) return reply.code(400).send({ message: SHAPE_REFUSAL });
        return undefined;
      },
    },
    (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { from: string; amount: number };
      return answerAtOnce(
        req,
        reply,
        module.useCase(recordCashSettlement),
        { groupId: id, from: body.from, amount: body.amount } as RecordCashSettlementInput,
        { created: true },
      );
    },
  );

  fastify.get('/settlements/:id', { schema: { tags: ['settlements'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getSettlement), { id: (req.params as { id: string }).id }),
  );

  done();
};
