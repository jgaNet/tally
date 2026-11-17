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

/** The bodies say their shape only (API-BODY-SHAPE): whether an amount, a date or a split is allowed is the domain's to refuse. */
const recordExpenseBody = {
  type: 'object',
  required: ['description', 'amount', 'date', 'splitBetween'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
  },
};

/** An edit says the whole expense and the version it was read at (request 6): the shape only, as the record's body. */
const editExpenseBody = {
  type: 'object',
  required: ['description', 'amount', 'date', 'splitBetween', 'version'],
  properties: {
    description: { type: 'string' },
    amount: { type: 'integer' },
    date: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
    version: { type: 'integer' },
  },
};

/** The expenses' routes, at the API's root, each with its full path (docs/adr/0003): each answers its use case at once. */
export const expenseRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{
    Params: { id: string };
    Body: { description: string; amount: number; date: string; splitBetween: string[] };
  }>('/groups/:id/expenses', { schema: { body: recordExpenseBody, tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(recordExpense), { groupId: req.params.id, ...req.body }, { created: true }),
  );

  fastify.get<{ Params: { id: string } }>('/expenses/:id', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getExpense), { id: req.params.id }),
  );

  fastify.put<{
    Params: { id: string };
    Body: { description: string; amount: number; date: string; splitBetween: string[]; version: number };
  }>('/expenses/:id', { schema: { body: editExpenseBody, tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(editExpense), { id: req.params.id, ...req.body }),
  );

  fastify.delete<{ Params: { id: string } }>('/expenses/:id', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(deleteExpense), { id: req.params.id }),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/balances', { schema: { tags: ['expenses'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupBalances), { groupId: req.params.id }),
  );

  done();
};
