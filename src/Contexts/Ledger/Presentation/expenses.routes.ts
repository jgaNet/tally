import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  deleteExpense,
  editExpense,
  getExpense,
  getGroupBalances,
  recordExpense,
} from '@Contexts/Ledger/Application/Expenses';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The split a body gives, one of three (request 4, request 7): an equal split between members, the exact amount of each, or
 * the shares of each. The body says exactly one of them (`oneOf`: none or more than one is the wrong shape, `400`).
 */
const splitBody = {
  properties: {
    splitBetween: { type: 'array', items: { type: 'string' } },
    splitExactly: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'amount'],
        properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
      },
    },
    splitByShares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'shares'],
        properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
      },
    },
  },
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
};

/** The bodies say their shape only (API-BODY-SHAPE): whether an amount, a date or a split is allowed is the domain's to refuse. */
const recordExpenseBody = {
  type: 'object',
  required: ['description', 'amount', 'date'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    ...splitBody.properties,
  },
  oneOf: splitBody.oneOf,
};

/** An edit says the whole expense and the version it was read at (request 6): the shape only, as the record's body. */
const editExpenseBody = {
  type: 'object',
  required: ['description', 'amount', 'date', 'version'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    version: { type: 'integer' },
    ...splitBody.properties,
  },
  oneOf: splitBody.oneOf,
};

/** The body's split, as the use cases take it: the transport has checked that exactly one of the three is given. */
function splitOf(body: SplitBody): SplitInput {
  if (body.splitBetween) return { kind: 'equal', between: body.splitBetween };
  if (body.splitExactly) {
    return { kind: 'exact', amounts: body.splitExactly.map(({ memberId, amount }) => ({ memberId, amount })) };
  }
  return { kind: 'shares', shares: (body.splitByShares ?? []).map(({ memberId, shares }) => ({ memberId, shares })) };
}

/** The split fields of a body, as the transport checks them. */
interface SplitBody {
  splitBetween?: string[];
  splitExactly?: Array<{ memberId: string; amount: number }>;
  splitByShares?: Array<{ memberId: string; shares: number }>;
}

/** The expenses' routes, at the API's root, each with its full path (docs/adr/0003): each answers its use case at once. */
export const expenseRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{
    Params: { id: string };
    Body: SplitBody & { description: string; amount: number; date: string };
  }>('/groups/:id/expenses', { schema: { body: recordExpenseBody, tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(
      req,
      reply,
      module.useCase(recordExpense),
      {
        groupId: req.params.id,
        description: req.body.description,
        amount: req.body.amount,
        date: req.body.date,
        split: splitOf(req.body),
      },
      { created: true },
    ),
  );

  fastify.get<{ Params: { id: string } }>('/expenses/:id', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getExpense), { id: req.params.id }),
  );

  fastify.put<{
    Params: { id: string };
    Body: SplitBody & { description: string; amount: number; date: string; version: number };
  }>('/expenses/:id', { schema: { body: editExpenseBody, tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(editExpense), {
      id: req.params.id,
      description: req.body.description,
      amount: req.body.amount,
      date: req.body.date,
      version: req.body.version,
      split: splitOf(req.body),
    }),
  );

  fastify.delete<{ Params: { id: string } }>('/expenses/:id', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(deleteExpense), { id: req.params.id }),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/balances', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupBalances), { groupId: req.params.id }),
  );

  done();
};
