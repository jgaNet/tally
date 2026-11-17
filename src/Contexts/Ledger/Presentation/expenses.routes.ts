import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getExpense, recordExpense } from '@Contexts/Ledger/Application/Expenses';

/** The body of a recording: its shape only; the payer is the caller, and the group is the URL's. */
interface RecordExpenseBody {
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly splitBetween: string[];
}

/**
 * The expenses' routes (feature 4, the API's fragment 5): a member records an expense they paid, split between the members
 * they name; a member of its group reads it. Each answers its use case at once. The paths are whole, mounted at the root
 * beside the groups' (ADR 5: a context has one mount). The body's schema says its shape only: a missing field or one of the
 * wrong type is `400` before any use case runs; whether the description fits, the amount is in range, the date is a real day
 * and the split is the group's members is the domain's to say (`422`).
 */
export const expenseRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Params: { id: string }; Body: RecordExpenseBody }>(
    '/groups/:id/expenses',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'amount', 'date', 'splitBetween'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'integer' },
            date: { type: 'string' },
            splitBetween: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(recordExpense),
        { groupId: req.params.id, ...req.body },
        { created: true },
      ),
  );

  fastify.get<{ Params: { id: string } }>('/expenses/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getExpense), req.params.id),
  );

  done();
};
