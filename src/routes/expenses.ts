import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { requireCaller } from '../http';
import { CURRENCIES } from '../groups';
import { Refusal } from '../refusal';
import {
  deleteExpense,
  editExpense,
  expensesOfGroup,
  findExpenseOfMember,
  recordExpense,
  type ExpenseAmount,
  type SplitInput,
} from '../expenses';

/** The split a body names: exactly one of its three fields (the shape is checked by the schema). */
interface SplitBody {
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
}

/** An expense paid in another currency: its currency, the amount in it, and the rate it is worth in the group's. */
interface OriginalBody {
  currency: string;
  amount: number;
  rate: string;
}

interface RecordExpenseBody extends SplitBody {
  description: string;
  /** The amount in the group's currency, or `original` (what was paid in another currency): exactly one of them. */
  amount?: number;
  original?: OriginalBody;
  date: string;
}

interface EditExpenseBody extends RecordExpenseBody {
  version: number;
}

const SPLIT_BETWEEN = { type: 'array', items: { type: 'string' } };
const SPLIT_EXACTLY = {
  type: 'array',
  items: {
    type: 'object',
    required: ['memberId', 'amount'],
    properties: { memberId: { type: 'string' }, amount: { type: 'number' } },
  },
};
const SPLIT_BY_SHARES = {
  type: 'array',
  items: {
    type: 'object',
    required: ['memberId', 'shares'],
    properties: { memberId: { type: 'string' }, shares: { type: 'number' } },
  },
};
const ORIGINAL = {
  type: 'object',
  required: ['currency', 'amount', 'rate'],
  properties: { currency: { type: 'string' }, amount: { type: 'number' }, rate: { type: 'string' } },
};

/**
 * Only the shape is checked here (a missing or wrongly typed field is `400`, and so is a body that names
 * none of the three splits or more than one, or neither of `amount` and `original` or both); values are checked by
 * the rules.
 */
const RECORD_EXPENSE_BODY = {
  type: 'object',
  required: ['description', 'date'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'number' },
    original: ORIGINAL,
    date: { type: 'string' },
    splitBetween: SPLIT_BETWEEN,
    splitExactly: SPLIT_EXACTLY,
    splitByShares: SPLIT_BY_SHARES,
  },
  allOf: [
    { oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }] },
    { oneOf: [{ required: ['amount'] }, { required: ['original'] }] },
  ],
};

/** An edit names the version it was made from: a whole number from 1. */
const EDIT_EXPENSE_BODY = {
  ...RECORD_EXPENSE_BODY,
  required: [...RECORD_EXPENSE_BODY.required, 'version'],
  properties: {
    ...RECORD_EXPENSE_BODY.properties,
    version: { type: 'integer', minimum: 1 },
  },
};

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const EXPENSE = {
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
    shares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'amount'],
        properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
      },
    },
    // Present only for an expense paid in another currency: its amount is then that currency's, at the rate.
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

/** The split the body names; the schema has checked that it names exactly one. */
function splitOf(body: SplitBody): SplitInput {
  if (body.splitBetween) return { kind: 'equal', memberIds: body.splitBetween };
  if (body.splitExactly) {
    return {
      kind: 'exact',
      parts: body.splitExactly.map(part => ({ memberId: part.memberId, amount: part.amount })),
    };
  }
  return {
    kind: 'shares',
    parts: (body.splitByShares ?? []).map(part => ({ memberId: part.memberId, shares: part.shares })),
  };
}

/** The amount the body gives: `original` when it names one, else `amount`; the schema has checked that it names one. */
function amountOf(body: RecordExpenseBody): ExpenseAmount {
  if (body.original) {
    const { currency, amount, rate } = body.original;
    return { kind: 'original', currency, amount, rate };
  }
  return { kind: 'group', amount: body.amount as number };
}

export function registerExpenseRoutes(server: FastifyInstance, db: DatabaseSync): void {
  // The payer is the caller; a caller who is not a member of the group sees no group to record in.
  server.post<{ Params: { id: string }; Body: RecordExpenseBody }>(
    '/groups/:id/expenses',
    { schema: { body: RECORD_EXPENSE_BODY, response: { 201: ID } } },
    async (request, reply) => {
      const caller = requireCaller(db, request);
      const { description, date } = request.body;
      const id = recordExpense(db, {
        groupId: request.params.id,
        payerId: caller.id,
        description,
        amount: amountOf(request.body),
        date,
        split: splitOf(request.body),
      });
      return reply.code(201).send({ id });
    },
  );

  // Only a member of the group reads its expenses, the latest date first; to anyone else the group does not exist.
  server.get<{ Params: { id: string } }>(
    '/groups/:id/expenses',
    { schema: { response: { 200: { type: 'array', items: EXPENSE } } } },
    async request => {
      const caller = requireCaller(db, request);
      return expensesOfGroup(db, caller.id, request.params.id);
    },
  );

  // Only a member of the expense's group reads it; to anyone else it does not exist.
  server.get<{ Params: { id: string } }>('/expenses/:id', { schema: { response: { 200: EXPENSE } } }, async request => {
    const caller = requireCaller(db, request);
    const expense = findExpenseOfMember(db, caller.id, request.params.id);
    if (!expense) throw new Refusal(404, 'ExpenseNotFound', 'No expense has this id.');
    return expense;
  });

  // Only the expense's payer or its group's owner edits it, from the version its author read; the edit
  // answers the expense as it now stands.
  server.put<{ Params: { id: string }; Body: EditExpenseBody }>(
    '/expenses/:id',
    { schema: { body: EDIT_EXPENSE_BODY, response: { 200: EXPENSE } } },
    async request => {
      const caller = requireCaller(db, request);
      const { description, date, version } = request.body;
      return editExpense(db, {
        expenseId: request.params.id,
        editorId: caller.id,
        description,
        amount: amountOf(request.body),
        date,
        split: splitOf(request.body),
        version,
      });
    },
  );

  // Only the expense's payer or its group's owner deletes it.
  server.delete<{ Params: { id: string } }>('/expenses/:id', async (request, reply) => {
    const caller = requireCaller(db, request);
    deleteExpense(db, { expenseId: request.params.id, deleterId: caller.id });
    return reply.code(204).send();
  });
}
