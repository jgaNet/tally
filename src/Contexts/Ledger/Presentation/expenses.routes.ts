import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import {
  deleteExpense,
  EditExpenseInput,
  editExpense,
  getExpense,
  getGroupBalances,
  getGroupExpenses,
  getMemberStatement,
  getOfferedRate,
  recordExpense,
  RecordExpenseInput,
} from '@Contexts/Ledger/Application/Expenses';
import { GivenAmount } from '@Contexts/Ledger/Domain/Expense/Expense.decision';

import { hasSplitShape, isObject, splitOf } from './splitBody';

const SHAPE_REFUSAL =
  'The body must have description (a string), date (a string), category (a string, when given), exactly one of amount (a whole number) or original ({ currency, amount (a whole number), rate (a string, when given) }), and exactly one split: splitBetween (a list of strings), splitExactly (a list of { memberId, amount }) or splitByShares (a list of { memberId, shares })';
const EDIT_SHAPE_REFUSAL = `${SHAPE_REFUSAL}, and version (a whole number)`;

/**
 * The amount a body gives, by shape (request 21, request 22): exactly one of `amount`, a whole number in the group's currency, or `original`,
 * an object of a currency (a string), an amount (a whole number) and a rate (a string, which may be left out: the rate offered is taken).
 * Whether the values are allowed is the domain's.
 */
const hasAmountShape = (body: Record<string, unknown>): boolean => {
  const hasAmount = body.amount !== undefined;
  const hasOriginal = body.original !== undefined;
  if (hasAmount === hasOriginal) return false;
  if (hasAmount) return Number.isInteger(body.amount);
  const original = body.original;
  return (
    isObject(original) &&
    typeof original.currency === 'string' &&
    Number.isInteger(original.amount) &&
    (original.rate === undefined || typeof original.rate === 'string')
  );
};

/** The amount a body gives, as the domain takes it. Only called on a body `hasAmountShape` has accepted. */
const amountOf = (body: Record<string, unknown>): GivenAmount => {
  if (body.original !== undefined) {
    const { currency, amount, rate } = body.original as { currency: string; amount: number; rate?: string };
    return rate === undefined ? { original: { currency, amount } } : { original: { currency, amount, rate } };
  }
  return { amount: body.amount as number };
};

/** The fields every expense carries in a body: what a recording and an edit both say. */
const hasExpenseFields = (body: unknown): body is Record<string, unknown> => {
  if (!isObject(body)) return false;
  const { description, date } = body;
  const { category } = body;
  return (
    typeof description === 'string' &&
    typeof date === 'string' &&
    (category === undefined || typeof category === 'string') &&
    hasAmountShape(body) &&
    hasSplitShape(body)
  );
};

/**
 * The shape of the body, checked on the raw request before anything else: a field missing or of the wrong type is a
 * refusal of its shape, at once, with 400 (API-BODY-SHAPE), and so is a body with none of the three splits or more than
 * one. Whether the values are allowed is the domain's to say.
 */
const hasShape = (body: unknown): boolean => hasExpenseFields(body);

/** An edit's body is an expense's, and the whole number of the version the edit was made from. */
const hasEditShape = (body: unknown): boolean =>
  hasExpenseFields(body) && Number.isInteger((body as Record<string, unknown>).version);

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
      const body = req.body as Record<string, unknown>;
      return answerAtOnce(
        req,
        reply,
        module.useCase(recordExpense),
        {
          groupId: id,
          description: body.description as string,
          date: body.date as string,
          split: splitOf(body),
          category: body.category as string | undefined,
          ...amountOf(body),
        } as RecordExpenseInput,
        { created: true },
      );
    },
  );

  fastify.get('/expenses/:id', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getExpense), { id: (req.params as { id: string }).id }),
  );

  fastify.put(
    '/expenses/:id',
    {
      schema: { tags: ['expenses'] },
      preValidation: async (request, reply) => {
        if (!hasEditShape(request.body)) return reply.code(400).send({ message: EDIT_SHAPE_REFUSAL });
        return undefined;
      },
    },
    (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      return answerAtOnce(req, reply, module.useCase(editExpense), {
        id,
        description: body.description as string,
        date: body.date as string,
        split: splitOf(body),
        version: body.version as number,
        category: body.category as string | undefined,
        ...amountOf(body),
      } as EditExpenseInput);
    },
  );

  fastify.delete('/expenses/:id', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(deleteExpense), { id: (req.params as { id: string }).id }),
  );

  fastify.get('/groups/:id/expenses', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupExpenses), { id: (req.params as { id: string }).id }),
  );

  fastify.get('/groups/:id/members/:memberId/statement', { schema: { tags: ['statement'] } }, (req, reply) => {
    const { id, memberId } = req.params as { id: string; memberId: string };
    return answerAtOnce(req, reply, module.useCase(getMemberStatement), { id, memberId });
  });

  fastify.get('/groups/:id/balances', { schema: { tags: ['balances'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupBalances), { id: (req.params as { id: string }).id }),
  );

  fastify.get(
    '/groups/:id/rates/:currency',
    {
      schema: { tags: ['rates'] },
      preValidation: async (request, reply) => {
        const { date } = request.query as { date?: unknown };
        if (date !== undefined && typeof date !== 'string') {
          return reply.code(400).send({ message: 'The date, when given, must be a string written YYYY-MM-DD' });
        }
        return undefined;
      },
    },
    (req, reply) => {
      const { id, currency } = req.params as { id: string; currency: string };
      const { date } = req.query as { date?: string };
      return answerAtOnce(req, reply, module.useCase(getOfferedRate), { id, currency, date });
    },
  );

  done();
};
