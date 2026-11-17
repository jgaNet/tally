import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { createExpense, deleteExpense, requireExpense, updateExpense } from './expenses';
import type { SplitInput } from './validation';

const shareSchema = {
  type: 'object',
  required: ['memberId', 'amount'],
  properties: {
    memberId: { type: 'string' },
    amount: { type: 'integer' },
  },
};

/**
 * The three ways to split, as a body gives them: exactly one of them, else the body is of the wrong
 * shape. Each member is listed with the amount of their share, or with their shares.
 */
const splitProperties = {
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
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
};

interface SplitBody {
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
}

/** The split a body gives; the schema has already let through exactly one of the three. */
function splitOf(body: SplitBody): SplitInput {
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
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'version', 'splitKind', 'shares'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    paidBy: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    splitKind: { enum: ['equal', 'exact', 'shares'] },
    shares: { type: 'array', items: shareSchema },
  },
};

/** The fields of an expense as an edit gives them, with one split, and the version the edit was made from. */
const editBodySchema = {
  type: 'object',
  required: ['description', 'amount', 'date', 'version'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'number' },
    date: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    ...splitProperties,
  },
  ...exactlyOneSplit,
};

export function registerExpenseRoutes(app: FastifyInstance, db: Database): void {
  app.post<{
    Params: { id: string };
    Body: { description: string; amount: number; date: string } & SplitBody;
  }>(
    '/groups/:id/expenses',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['description', 'amount', 'date'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'number' },
            date: { type: 'string' },
            ...splitProperties,
          },
          ...exactlyOneSplit,
        },
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      const { description, amount, date } = request.body;
      const id = createExpense(db, request.params.id, account.id, {
        description,
        amount,
        date,
        split: splitOf(request.body),
      });
      return reply.code(201).send({ id });
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
    Body: { description: string; amount: number; date: string; version: number } & SplitBody;
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
      const { version, description, amount, date } = request.body;
      const input = { description, amount, date, split: splitOf(request.body) };
      updateExpense(db, request.params.id, account.id, input, version);
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
