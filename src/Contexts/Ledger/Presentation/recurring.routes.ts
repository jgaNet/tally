import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  getGroupRecurringExpenses,
  getRecurringExpense,
  setUpRecurringExpense,
  stopRecurringExpense,
} from '@Contexts/Ledger/Application/RecurringExpenses';
import { SplitBody, splitBody, splitOf } from '@Contexts/Ledger/Presentation/expenses.routes';

/**
 * A recurring expense's body (request 23): what it pays, how much, from which day, and the split it is given, one of the three. The
 * body's shape only (API-BODY-SHAPE): whether an amount, a day or a split is allowed is the domain's to refuse.
 */
const setUpBody = {
  type: 'object',
  required: ['description', 'amount', 'startsOn'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    startsOn: { type: 'string' },
    category: { type: 'string' },
    ...splitBody.properties,
  },
  allOf: [{ oneOf: splitBody.oneOf }],
};

/** The routes of recurring expenses, at the API's root, each with its full path (docs/adr/0003): each answers its use case at once. */
export const recurringRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{
    Params: { id: string };
    Body: SplitBody & { description: string; amount: number; startsOn: string; category?: string };
  }>('/groups/:id/recurring', { schema: { body: setUpBody, tags: ['recurring'] } }, (req, reply) =>
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
        category: req.body.category,
      },
      { created: true },
    ),
  );

  fastify.get<{ Params: { id: string } }>('/recurring/:id', { schema: { tags: ['recurring'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getRecurringExpense), { id: req.params.id }),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/recurring', { schema: { tags: ['recurring'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupRecurringExpenses), { groupId: req.params.id }),
  );

  fastify.delete<{ Params: { id: string } }>('/recurring/:id', { schema: { tags: ['recurring'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(stopRecurringExpense), { id: req.params.id }),
  );

  done();
};
