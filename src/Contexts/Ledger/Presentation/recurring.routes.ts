import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  getGroupRecurringExpenses,
  getRecurringExpense,
  setUpRecurringExpense,
  stopRecurringExpense,
} from '@Contexts/Ledger/Application/RecurringExpenses';
import { exactlyOneSplit, splitOf, splitProperties, SplitBody } from '@Contexts/Ledger/Presentation/expenses.routes';

/** The body of a set up (request 23): its description, amount and start, and exactly one of the three splits. Its shape only. */
type SetUpRecurringBody = {
  readonly description: string;
  readonly amount: number;
  readonly startsOn: string;
} & SplitBody;

/**
 * The recurring expenses' routes (request 23, ADR 18): a member sets up an expense they pay every month, split as the body says; a member
 * of its group reads it, or the group's, the earliest set up first; its payer or the group's owner stops it. Each answers its use case at
 * once. The paths are whole, mounted at the root beside the expenses' (ADR 5: a context has one mount). The body's schema says its shape
 * only: a missing field, one of the wrong type, or not exactly one of the three splits is `400` before any use case runs; whether the
 * description fits, the amount is in range, the start is a real day of the month from 1 to 28 within 365 days of today, and the split is the
 * group's members, is the domain's to say (`422`).
 */
export const recurringRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Params: { id: string }; Body: SetUpRecurringBody }>(
    '/groups/:id/recurring',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'amount', 'startsOn'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'integer' },
            startsOn: { type: 'string' },
            ...splitProperties,
          },
          allOf: [exactlyOneSplit],
        },
      },
    },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(setUpRecurringExpense),
        {
          groupId: req.params.id,
          description: req.body.description,
          amount: req.body.amount,
          startsOn: req.body.startsOn,
          split: splitOf(req.body),
        },
        { created: true },
      ),
  );

  fastify.get<{ Params: { id: string } }>('/recurring/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getRecurringExpense), req.params.id),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/recurring', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupRecurringExpenses), req.params.id),
  );

  fastify.delete<{ Params: { id: string } }>('/recurring/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(stopRecurringExpense), req.params.id),
  );

  done();
};
