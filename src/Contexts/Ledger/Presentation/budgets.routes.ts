import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getGroupBudgets, removeBudget, setBudget } from '@Contexts/Ledger/Application/Budgets';

/**
 * A budget's body (request 24): the amount of the monthly budget, in the group's currency. The shape only (API-BODY-SHAPE): whether the
 * amount is in range and the category one of the eight is the domain's to refuse.
 */
const setBudgetBody = {
  type: 'object',
  required: ['amount'],
  properties: { amount: { type: 'integer' } },
};

/** The routes of the monthly budgets, at the API's root with their full path (docs/adr/0003): each answers its use case at once. */
export const budgetRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.put<{ Params: { id: string; category: string }; Body: { amount: number } }>(
    '/groups/:id/budgets/:category',
    { schema: { body: setBudgetBody, tags: ['budgets'] } },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(setBudget), {
        groupId: req.params.id,
        category: req.params.category,
        amount: req.body.amount,
      }),
  );

  fastify.delete<{ Params: { id: string; category: string } }>(
    '/groups/:id/budgets/:category',
    { schema: { tags: ['budgets'] } },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(removeBudget), {
        groupId: req.params.id,
        category: req.params.category,
      }),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/budgets', { schema: { tags: ['budgets'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupBudgets), { groupId: req.params.id }),
  );

  done();
};
