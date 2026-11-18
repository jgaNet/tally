import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import {
  getGroupRecurringExpenses,
  getRecurringExpense,
  setUpRecurringExpense,
  SetUpRecurringExpenseInput,
  stopRecurringExpense,
} from '@Contexts/Ledger/Application/RecurringExpenses';

import { hasSplitShape, isObject, splitOf } from './splitBody';

const SHAPE_REFUSAL =
  'The body must have description (a string), amount (a whole number), startsOn (a string, written YYYY-MM-DD), category (a string, when given), and exactly one split: splitBetween (a list of strings), splitExactly (a list of { memberId, amount }) or splitByShares (a list of { memberId, shares })';

/** A body of a recurring expense is shaped as an expense's is, with `startsOn` in place of a date. Whether its values are allowed is the domain's. */
const hasShape = (body: unknown): body is Record<string, unknown> =>
  isObject(body) &&
  typeof body.description === 'string' &&
  Number.isInteger(body.amount) &&
  typeof body.startsOn === 'string' &&
  (body.category === undefined || typeof body.category === 'string') &&
  hasSplitShape(body);

/** The recurring expenses' routes, under `/v1` (request 23). */
export const recurringRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post(
    '/groups/:id/recurring',
    {
      schema: { tags: ['recurring'] },
      preValidation: async (request, reply) => {
        if (!hasShape(request.body)) return reply.code(400).send({ message: SHAPE_REFUSAL });
        return undefined;
      },
    },
    (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      return answerAtOnce(
        req,
        reply,
        module.useCase(setUpRecurringExpense),
        {
          groupId: id,
          description: body.description as string,
          amount: body.amount as number,
          startsOn: body.startsOn as string,
          split: splitOf(body),
          category: body.category as string | undefined,
        } as SetUpRecurringExpenseInput,
        { created: true },
      );
    },
  );

  fastify.get('/recurring/:id', { schema: { tags: ['recurring'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getRecurringExpense), { id: (req.params as { id: string }).id }),
  );

  fastify.get('/groups/:id/recurring', { schema: { tags: ['recurring'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupRecurringExpenses), { id: (req.params as { id: string }).id }),
  );

  fastify.delete('/recurring/:id', { schema: { tags: ['recurring'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(stopRecurringExpense), { id: (req.params as { id: string }).id }),
  );

  done();
};
