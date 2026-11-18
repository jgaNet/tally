import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { CATEGORIES } from '../budgets/categories';
import { requireMembership } from '../groups/groups';
import { CURRENCIES } from '../groups/validation';
import type { RatesConfig } from '../rates/rates';
import {
  type SplitRequest,
  createExpense,
  deleteExpense,
  expensesOfGroup,
  requireExpense,
  updateExpense,
} from './expenses';
import type { MoneyInput } from './validation';

const shareSchema = {
  type: 'object',
  required: ['memberId', 'amount'],
  properties: {
    memberId: { type: 'string' },
    amount: { type: 'integer' },
  },
};

/**
 * The ways to split, as a body gives them: exactly one of the three splits, or a template of the group, else the body
 * is of the wrong shape. Each member is listed with the amount of their share, or with their shares.
 */
const splitProperties = {
  /** The id of a template of the group, which the expense is split by in place of its own split. */
  template: { type: 'string' },
  splitBetween: { type: 'array', items: { type: 'string' } },
  splitExactly: {
    type: 'array',
    items: {
      type: 'object',
      required: ['memberId', 'amount'],
      properties: { memberId: { type: 'string' }, amount: { type: 'number' } },
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
};

const exactlyOneSplit = {
  oneOf: [
    { required: ['splitBetween'] },
    { required: ['splitExactly'] },
    { required: ['splitByShares'] },
    { required: ['template'] },
  ],
};

/**
 * An expense in another currency: what was paid in it, and at the rate its payer states. The rate may be left
 * out: the expense is then recorded at the rate offered for its currency on its date.
 */
const originalBodySchema = {
  type: 'object',
  required: ['currency', 'amount'],
  properties: {
    currency: { type: 'string' },
    amount: { type: 'number' },
    rate: { type: 'string' },
  },
};

/** The amount, in the group's currency or in another: exactly one of them, else the body is of the wrong shape. */
const exactlyOneAmount = {
  oneOf: [{ required: ['amount'] }, { required: ['original'] }],
};

/** The two rules a body must meet at once: exactly one split, and exactly one amount. */
const exactlyOneSplitAndAmount = { allOf: [exactlyOneSplit, exactlyOneAmount] };

interface SplitBody {
  template?: string;
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
}

interface AmountBody {
  amount?: number;
  original?: { currency: string; amount: number; rate?: string };
}

/** The amount a body gives; the schema has already let through exactly one of the two. */
function moneyOf(body: AmountBody): MoneyInput {
  if (body.original !== undefined) {
    const { currency, amount, rate } = body.original;
    return rate === undefined ? { kind: 'other', currency, amount } : { kind: 'other', currency, amount, rate };
  }
  return { kind: 'group', amount: body.amount ?? 0 };
}

/** The split a body gives; the schema has already let through exactly one of the four ways. */
function splitOf(body: SplitBody): SplitRequest {
  if (body.template !== undefined) {
    return { kind: 'template', templateId: body.template };
  }
  if (body.splitByShares !== undefined) {
    return { kind: 'shares', splitByShares: body.splitByShares };
  }
  if (body.splitExactly !== undefined) {
    return { kind: 'exact', splitExactly: body.splitExactly };
  }
  return { kind: 'equal', splitBetween: body.splitBetween ?? [] };
}

const expenseSchema = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'version', 'splitKind', 'category', 'shares'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    paidBy: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    splitKind: { enum: ['equal', 'exact', 'shares'] },
    category: { enum: [...CATEGORIES] },
    shares: { type: 'array', items: shareSchema },
    original: {
      type: 'object',
      required: ['currency', 'amount', 'rate'],
      properties: {
        currency: { enum: [...CURRENCIES] },
        amount: { type: 'integer' },
        rate: { type: 'string' },
      },
    },
  },
};

/** The fields of an expense as an edit gives them, with one split, and the version the edit was made from. */
const editBodySchema = {
  type: 'object',
  required: ['description', 'date', 'version'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'number' },
    original: originalBodySchema,
    date: { type: 'string' },
    category: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    ...splitProperties,
  },
  ...exactlyOneSplitAndAmount,
};

export function registerExpenseRoutes(app: FastifyInstance, db: Database, rates: RatesConfig): void {
  app.post<{
    Params: { id: string };
    Body: { description: string; date: string; category?: string } & AmountBody & SplitBody;
  }>(
    '/groups/:id/expenses',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['description', 'date'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'number' },
            original: originalBodySchema,
            date: { type: 'string' },
            category: { type: 'string' },
            ...splitProperties,
          },
          ...exactlyOneSplitAndAmount,
        },
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      const { description, date, category } = request.body;
      const id = await createExpense(db, rates, request.params.id, account.id, {
        description,
        money: moneyOf(request.body),
        date,
        split: splitOf(request.body),
        category,
      });
      return reply.code(201).send({ id });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/groups/:id/expenses',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'array', items: expenseSchema } },
      },
    },
    async request => {
      const account = requireAccount(db, request);
      // Only the members of a group see its expenses; anyone else is told it does not exist.
      requireMembership(db, request.params.id, account.id);
      return expensesOfGroup(db, request.params.id);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/expenses/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: expenseSchema },
      },
    },
    async request => {
      const account = requireAccount(db, request);
      return requireExpense(db, request.params.id, account.id);
    },
  );

  app.put<{
    Params: { id: string };
    Body: { description: string; date: string; category?: string; version: number } & AmountBody & SplitBody;
  }>(
    '/expenses/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: editBodySchema,
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      const { version, description, date, category } = request.body;
      const input = { description, money: moneyOf(request.body), date, split: splitOf(request.body), category };
      await updateExpense(db, rates, request.params.id, account.id, input, version);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/expenses/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      deleteExpense(db, request.params.id, account.id);
      return reply.code(204).send();
    },
  );
}
