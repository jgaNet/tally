import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import { getExpense, getGroupBalances, recordExpense, RecordExpenseInput } from '@Contexts/Ledger/Application/Expenses';

const SHAPE_REFUSAL =
  'The body must have description (a string), amount (a whole number), date (a string) and splitBetween (a list of strings)';

/**
 * The shape of the body, checked on the raw request before anything else: a field missing or of the wrong type is a
 * refusal of its shape, at once, with 400 (API-BODY-SHAPE). Whether the values are allowed is the domain's to say.
 */
const hasShape = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null) return false;
  const { description, amount, date, splitBetween } = body as Record<string, unknown>;
  return (
    typeof description === 'string' &&
    Number.isInteger(amount) &&
    typeof date === 'string' &&
    Array.isArray(splitBetween) &&
    splitBetween.every(member => typeof member === 'string')
  );
};

/** The expenses' routes, under `/v1` (every route is under the API's prefix, the group's included). */
export const expenseRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post(
    '/groups/:id/expenses',
    {
      schema: { tags: ['expenses'] },
      preValidation: async (request, reply) => {
        if (!hasShape(request.body)) return reply.code(400).send({ message: SHAPE_REFUSAL });
        return undefined;
      },
    },
    (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Omit<RecordExpenseInput, 'groupId'>;
      return answerAtOnce(
        req,
        reply,
        module.useCase(recordExpense),
        {
          groupId: id,
          description: body.description,
          amount: body.amount,
          date: body.date,
          splitBetween: body.splitBetween,
        },
        { created: true },
      );
    },
  );

  fastify.get('/expenses/:id', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getExpense), { id: (req.params as { id: string }).id }),
  );

  fastify.get('/groups/:id/balances', { schema: { tags: ['balances'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupBalances), { id: (req.params as { id: string }).id }),
  );

  done();
};
