import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import { getGroupBudgets, removeBudget, setBudget } from '@Contexts/Ledger/Application/Budgets';

import { isObject } from './splitBody';

const SHAPE_REFUSAL = 'The body must have amount (a whole number)';

/** The budgets' routes, under `/v1` (request 24). Whether the category and the amount are allowed is the domain's to say. */
export const budgetRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.put(
    '/groups/:id/budgets/:category',
    {
      schema: { tags: ['budgets'] },
      preValidation: async (request, reply) => {
        const body = request.body;
        if (!isObject(body) || !Number.isInteger(body.amount)) return reply.code(400).send({ message: SHAPE_REFUSAL });
        return undefined;
      },
    },
    (req, reply) => {
      const { id, category } = req.params as { id: string; category: string };
      const { amount } = req.body as { amount: number };
      return answerAtOnce(req, reply, module.useCase(setBudget), { groupId: id, category, amount });
    },
  );

  fastify.delete('/groups/:id/budgets/:category', { schema: { tags: ['budgets'] } }, (req, reply) => {
    const { id, category } = req.params as { id: string; category: string };
    return answerAtOnce(req, reply, module.useCase(removeBudget), { groupId: id, category });
  });

  fastify.get('/groups/:id/budgets', { schema: { tags: ['budgets'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupBudgets), { id: (req.params as { id: string }).id }),
  );

  done();
};
