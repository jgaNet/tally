import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { requireCaller } from '../http';
import { Refusal } from '../refusal';
import { findExpenseOfMember, recordExpense } from '../expenses';

interface RecordExpenseBody {
  description: string;
  amount: number;
  date: string;
  splitBetween: string[];
}

/** Only the shape is checked here (a missing or wrongly typed field is `400`); values are checked by the rules. */
const RECORD_EXPENSE_BODY = {
  type: 'object',
  required: ['description', 'amount', 'date', 'splitBetween'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'number' },
    date: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
  },
};

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const EXPENSE = {
  type: 'object',
  required: ['id', 'groupId', 'description', 'amount', 'date', 'paidBy', 'shares'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    paidBy: { type: 'string' },
    shares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'amount'],
        properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
      },
    },
  },
};

export function registerExpenseRoutes(server: FastifyInstance, db: DatabaseSync): void {
  // The payer is the caller; a caller who is not a member of the group sees no group to record in.
  server.post<{ Params: { id: string }; Body: RecordExpenseBody }>(
    '/groups/:id/expenses',
    { schema: { body: RECORD_EXPENSE_BODY, response: { 201: ID } } },
    async (request, reply) => {
      const caller = requireCaller(db, request);
      const { description, amount, date, splitBetween } = request.body;
      const id = recordExpense(db, {
        groupId: request.params.id,
        payerId: caller.id,
        description,
        amount,
        date,
        splitBetween,
      });
      return reply.code(201).send({ id });
    },
  );

  // Only a member of the expense's group reads it; to anyone else it does not exist.
  server.get<{ Params: { id: string } }>('/expenses/:id', { schema: { response: { 200: EXPENSE } } }, async request => {
    const caller = requireCaller(db, request);
    const expense = findExpenseOfMember(db, caller.id, request.params.id);
    if (!expense) throw new Refusal(404, 'ExpenseNotFound', 'No expense has this id.');
    return expense;
  });
}
