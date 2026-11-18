import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import type { SplitInput } from '../expenses/validation';
import { CATEGORIES } from '../budgets/categories';
import { requireMembership } from '../groups/groups';
import { type Recurring, createRecurring, recurringOfGroup, requireRecurring, stopRecurring } from './recurring';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const splitBetween = { type: 'array', items: { type: 'string' } };
const splitExactly = {
  type: 'array',
  items: {
    type: 'object',
    required: ['memberId', 'amount'],
    properties: { memberId: { type: 'string' }, amount: { type: 'number' } },
  },
};
const splitByShares = {
  type: 'array',
  items: {
    type: 'object',
    required: ['memberId', 'shares'],
    properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
  },
};

const recurringSchema = {
  type: 'object',
  required: ['id', 'groupId', 'paidBy', 'description', 'amount', 'startsOn', 'next', 'category'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    paidBy: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    startsOn: { type: 'string' },
    next: { type: 'string' },
    category: { type: 'string', enum: [...CATEGORIES] },
    splitBetween: { type: 'array', items: { type: 'string' } },
    splitExactly: {
      type: 'array',
      items: {
        type: 'object',
        properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
      },
    },
    splitByShares: {
      type: 'array',
      items: {
        type: 'object',
        properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
      },
    },
  },
};

/** A recurring expense as the API reads it: its fields, and the split as it was given. */
function read(recurring: Recurring) {
  const { split, ...fields } = recurring;
  switch (split.kind) {
    case 'equal':
      return { ...fields, splitBetween: split.splitBetween };
    case 'exact':
      return { ...fields, splitExactly: split.splitExactly };
    case 'shares':
      return { ...fields, splitByShares: split.splitByShares };
  }
}

interface Body {
  description: string;
  amount: number;
  startsOn: string;
  category?: string;
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
}

function splitOf(body: Body): SplitInput {
  if (body.splitByShares !== undefined) {
    return { kind: 'shares', splitByShares: body.splitByShares };
  }
  if (body.splitExactly !== undefined) {
    return { kind: 'exact', splitExactly: body.splitExactly };
  }
  return { kind: 'equal', splitBetween: body.splitBetween ?? [] };
}

export function registerRecurringRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Params: { id: string }; Body: Body }>(
    '/groups/:id/recurring',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['description', 'amount', 'startsOn'],
          properties: {
            description: { type: 'string' },
            amount: { type: 'number' },
            startsOn: { type: 'string' },
            category: { type: 'string' },
            splitBetween,
            splitExactly,
            splitByShares,
          },
          oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
        },
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      const { description, amount, startsOn, category } = request.body;
      const id = createRecurring(db, request.params.id, account.id, {
        description,
        amount,
        startsOn,
        split: splitOf(request.body),
        category,
      });
      return reply.code(201).send({ id });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/recurring/:id',
    { schema: { params: idParams, response: { 200: recurringSchema } } },
    async request => read(requireRecurring(db, request.params.id, requireAccount(db, request).id)),
  );

  app.get<{ Params: { id: string } }>(
    '/groups/:id/recurring',
    { schema: { params: idParams, response: { 200: { type: 'array', items: recurringSchema } } } },
    async request => {
      const account = requireAccount(db, request);
      requireMembership(db, request.params.id, account.id);
      return recurringOfGroup(db, request.params.id).map(read);
    },
  );

  app.delete<{ Params: { id: string } }>('/recurring/:id', { schema: { params: idParams } }, async (request, reply) => {
    stopRecurring(db, request.params.id, requireAccount(db, request).id);
    return reply.code(204).send();
  });
}
