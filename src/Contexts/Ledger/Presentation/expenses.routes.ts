import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  deleteExpense,
  editExpense,
  getExpense,
  getGroupBalances,
  getGroupExpenses,
  getMemberStatement,
  getMemberStatementCsv,
  getOfferedRate,
  recordExpense,
} from '@Contexts/Ledger/Application/Expenses';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import { StatementView } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { statementAsCsv } from '@Contexts/Ledger/Presentation/statementCsv';

/**
 * The split a body gives, one of three (request 4, request 7): an equal split between members, the exact amount of each, or
 * the shares of each. The body says exactly one of them (`oneOf`: none or more than one is the wrong shape, `400`).
 */
export const splitBody = {
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

/**
 * The split an expense's body gives (request 25): one of the three, or the `template` it is split by in place of them. The body says
 * exactly one of the four (`oneOf`: none or more than one is the wrong shape, `400`).
 */
const splitOrTemplateBody = {
  properties: { ...splitBody.properties, template: { type: 'string' } },
  oneOf: [...splitBody.oneOf, { required: ['template'] }],
};

/**
 * What was paid in another currency, as a body gives it (request 21): its currency, its amount in its currency's minor unit and its rate as a
 * string. The rate may be left out, and the expense then takes the rate offered on its date (request 22). The shape only: whether
 * the currency is one of Tally's, the amount in range and the rate a decimal are the domain's.
 */
const originalBody = {
  type: 'object',
  required: ['currency', 'amount'],
  properties: { currency: { type: 'string' }, amount: { type: 'integer' }, rate: { type: 'string' } },
};

/**
 * The amount a body gives, one of two (request 21): its `amount` in the group's currency, or its `original` in another one. The body
 * says exactly one of them (`oneOf`: neither or both is the wrong shape, `400`).
 */
const amountBody = {
  properties: { amount: { type: 'integer' }, original: originalBody },
  oneOf: [{ required: ['amount'] }, { required: ['original'] }],
};

/** The bodies say their shape only (API-BODY-SHAPE): whether an amount, a date or a split is allowed is the domain's to refuse. */
const recordExpenseBody = {
  type: 'object',
  required: ['description', 'date'],
  properties: {
    description: { type: 'string' },
    date: { type: 'string' },
    category: { type: 'string' },
    ...amountBody.properties,
    ...splitOrTemplateBody.properties,
  },
  allOf: [{ oneOf: amountBody.oneOf }, { oneOf: splitOrTemplateBody.oneOf }],
};

/** An edit says the whole expense and the version it was read at (request 6): the shape only, as the record's body. */
const editExpenseBody = {
  type: 'object',
  required: ['description', 'date', 'version'],
  properties: {
    description: { type: 'string' },
    date: { type: 'string' },
    category: { type: 'string' },
    version: { type: 'integer' },
    ...amountBody.properties,
    ...splitOrTemplateBody.properties,
  },
  allOf: [{ oneOf: amountBody.oneOf }, { oneOf: splitOrTemplateBody.oneOf }],
};

/** The amount a body gives, as the transport has checked it: `amount`, or `original`, exactly one (request 21). */
interface AmountBody {
  amount?: number;
  original?: { currency: string; amount: number; rate?: string };
}

/** The body's split, as the use cases take it: the transport has checked that exactly one of the three is given. */
export function splitOf(body: SplitBody): SplitInput {
  if (body.splitBetween) return { kind: 'equal', between: body.splitBetween };
  if (body.splitExactly) {
    return { kind: 'exact', amounts: body.splitExactly.map(({ memberId, amount }) => ({ memberId, amount })) };
  }
  return { kind: 'shares', shares: (body.splitByShares ?? []).map(({ memberId, shares }) => ({ memberId, shares })) };
}

/** The split fields of a body, as the transport checks them. */
export interface SplitBody {
  splitBetween?: string[];
  splitExactly?: Array<{ memberId: string; amount: number }>;
  splitByShares?: Array<{ memberId: string; shares: number }>;
}

/** The expenses' routes, at the API's root, each with its full path (docs/adr/0003): each answers its use case at once. */
export const expenseRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{
    Params: { id: string };
    Body: SplitBody & AmountBody & { description: string; date: string; category?: string; template?: string };
  }>('/groups/:id/expenses', { schema: { body: recordExpenseBody, tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(
      req,
      reply,
      module.useCase(recordExpense),
      {
        groupId: req.params.id,
        description: req.body.description,
        amount: req.body.amount,
        original: req.body.original,
        date: req.body.date,
        split: req.body.template === undefined ? splitOf(req.body) : undefined,
        template: req.body.template,
        category: req.body.category,
      },
      { created: true },
    ),
  );

  fastify.get<{ Params: { id: string } }>('/expenses/:id', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getExpense), { id: req.params.id }),
  );

  fastify.put<{
    Params: { id: string };
    Body: SplitBody &
      AmountBody & {
        description: string;
        date: string;
        version: number;
        category?: string;
        template?: string;
      };
  }>('/expenses/:id', { schema: { body: editExpenseBody, tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(editExpense), {
      id: req.params.id,
      description: req.body.description,
      amount: req.body.amount,
      original: req.body.original,
      date: req.body.date,
      version: req.body.version,
      split: req.body.template === undefined ? splitOf(req.body) : undefined,
      template: req.body.template,
      category: req.body.category,
    }),
  );

  fastify.delete<{ Params: { id: string } }>('/expenses/:id', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(deleteExpense), { id: req.params.id }),
  );

  // The rate offered for a currency to the group's, on a day (request 22): `date` is today when it is left out.
  fastify.get<{ Params: { id: string; currency: string }; Querystring: { date?: string } }>(
    '/groups/:id/rates/:currency',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
        },
        tags: ['rates'],
      },
    },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(getOfferedRate), {
        groupId: req.params.id,
        currency: req.params.currency,
        date: req.query.date,
      }),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/balances', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupBalances), { groupId: req.params.id }),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/expenses', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupExpenses), { groupId: req.params.id }),
  );

  fastify.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement',
    { schema: { tags: ['expenses'] } },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(getMemberStatement), {
        groupId: req.params.id,
        memberId: req.params.memberId,
      }),
  );

  // The same statement as CSV (request 29, docs/adr/0028): answered as text/csv when the read succeeds; a refusal is answered as every route's.
  fastify.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement.csv',
    { schema: { tags: ['expenses'] } },
    async (req, reply) => {
      const answer = await answerAtOnce(req, reply, module.useCase(getMemberStatementCsv), {
        groupId: req.params.id,
        memberId: req.params.memberId,
      });
      if (reply.statusCode !== 200) return answer;
      return reply.type('text/csv; charset=utf-8').send(statementAsCsv(answer as StatementView));
    },
  );

  done();
};
