import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getGroupBudgets, removeBudget, setBudget } from '@Contexts/Ledger/Application/Budgets';

/** The body of a budget's amount (request 24): its shape only; whether it is 1 to 100 000 000 is the domain's to say. */
type SetBudgetBody = { readonly amount: number };

/**
 * The budgets' routes (request 24, the API's fragment 24): the owner of a group sets a monthly budget for a category or removes it; a
 * member reads the group's budgets, each with what the current month spends in it. Each answers its use case at once. The paths are whole,
 * mounted at the root beside the expenses' (ADR 5). The body is `{ amount }`: a missing amount or one of the wrong type is `400`; a category
 * that is not one of the eight, an amount out of range, a member who is not the owner and a group that is not there are the domain's (`422`,
 * `403` and `404`).
 */
export const budgetRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.put<{ Params: { id: string; category: string }; Body: SetBudgetBody }>(
    '/groups/:id/budgets/:category',
    {
      schema: {
        body: {
          type: 'object',
          required: ['amount'],
          properties: { amount: { type: 'integer' } },
        },
      },
    },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(setBudget), {
        groupId: req.params.id,
        category: req.params.category,
        amount: req.body.amount,
      }),
  );

  fastify.delete<{ Params: { id: string; category: string } }>('/groups/:id/budgets/:category', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(removeBudget), {
      groupId: req.params.id,
      category: req.params.category,
    }),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/budgets', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupBudgets), req.params.id),
  );

  done();
};
