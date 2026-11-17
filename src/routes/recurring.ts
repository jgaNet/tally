import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { SplitInput } from '../expenses';
import { requireCaller } from '../http';
import { recurringOfGroup, findRecurringOfMember, setUpRecurring, stopRecurring, type Recurring } from '../recurring';
import { Refusal } from '../refusal';
import { CATEGORIES } from '../categories';

interface SetUpBody {
  description: string;
  amount: number;
  startsOn: string;
  /** The category of the expenses it records; `other` when left out. */
  category?: string;
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
}

const SET_UP_BODY = {
  type: 'object',
  required: ['description', 'amount', 'startsOn'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'number' },
    startsOn: { type: 'string' },
    category: { type: 'string' },
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
        properties: { memberId: { type: 'string' }, shares: { type: 'number' } },
      },
    },
  },
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
};

const RECURRING = {
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
    category: { enum: [...CATEGORIES] },
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
};

function splitOf(body: SetUpBody): SplitInput {
  if (body.splitBetween) return { kind: 'equal', memberIds: body.splitBetween };
  if (body.splitExactly) return { kind: 'exact', parts: body.splitExactly };
  return { kind: 'shares', parts: body.splitByShares ?? [] };
}

/** A recurring expense as it reads: its fields and the split as it was given. */
function projection(recurring: Recurring) {
  const { split, ...fields } = recurring;
  if (split.kind === 'equal') return { ...fields, splitBetween: split.memberIds };
  if (split.kind === 'exact') return { ...fields, splitExactly: split.parts };
  return { ...fields, splitByShares: split.parts };
}

export function registerRecurringRoutes(server: FastifyInstance, db: DatabaseSync, clock: () => Date): void {
  server.post<{ Params: { id: string }; Body: SetUpBody }>(
    '/groups/:id/recurring',
    {
      schema: {
        body: SET_UP_BODY,
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const caller = requireCaller(db, request);
      const { description, amount, startsOn, category } = request.body;
      const id = setUpRecurring(db, {
        groupId: request.params.id,
        payerId: caller.id,
        description,
        amount,
        startsOn,
        category,
        split: splitOf(request.body),
        today: clock().toISOString().slice(0, 10),
      });
      return reply.code(201).send({ id });
    },
  );

  server.get<{ Params: { id: string } }>(
    '/recurring/:id',
    { schema: { response: { 200: RECURRING } } },
    async request => {
      const caller = requireCaller(db, request);
      const recurring = findRecurringOfMember(db, caller.id, request.params.id);
      if (!recurring) throw new Refusal(404, 'RecurringNotFound', 'No recurring expense has this id.');
      return projection(recurring);
    },
  );

  server.get<{ Params: { id: string } }>(
    '/groups/:id/recurring',
    { schema: { response: { 200: { type: 'array', items: RECURRING } } } },
    async request => {
      const caller = requireCaller(db, request);
      return recurringOfGroup(db, caller.id, request.params.id).map(projection);
    },
  );

  server.delete<{ Params: { id: string } }>('/recurring/:id', async (request, reply) => {
    const caller = requireCaller(db, request);
    stopRecurring(db, { recurringId: request.params.id, accountId: caller.id });
    return reply.code(204).send();
  });
}
