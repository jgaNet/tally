import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import { CATEGORIES } from '../budgets/categories';
import type { Database } from '../database';
import { noticesOf } from './notices';
import { NOTICE_KINDS, noticeKindOf, preferencesOf, setNoticePreference } from './preferences';

// An expense's notice names its expense; a reminder names none, so it has no `expenseId`; a budget notice names
// its category, month and budget, and its amount is what the month spends.
const noticeSchema = {
  type: 'object',
  required: ['id', 'kind', 'groupId', 'amount', 'at'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['expense', 'reminder', 'budget'] },
    groupId: { type: 'string' },
    expenseId: { type: 'string' },
    category: { type: 'string', enum: [...CATEGORIES] },
    month: { type: 'string' },
    budget: { type: 'integer' },
    amount: { type: 'integer' },
    at: { type: 'string' },
  },
};

const preferenceSchema = {
  type: 'object',
  required: ['kind', 'enabled'],
  properties: {
    kind: { type: 'string', enum: [...NOTICE_KINDS] },
    enabled: { type: 'boolean' },
  },
};

export function registerNoticeRoutes(app: FastifyInstance, db: Database): void {
  app.get(
    '/notices',
    {
      schema: {
        response: { 200: { type: 'array', items: noticeSchema } },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      return await noticesOf(db, account.id);
    },
  );

  app.get(
    '/accounts/me/notice-preferences',
    {
      schema: {
        response: { 200: { type: 'array', items: preferenceSchema } },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      return await preferencesOf(db, account.id);
    },
  );

  app.put<{ Params: { kind: string }; Body: { enabled: boolean } }>(
    '/accounts/me/notice-preferences/:kind',
    {
      schema: {
        params: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
        body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      await setNoticePreference(db, account.id, noticeKindOf(request.params.kind), request.body.enabled);
      return reply.code(204).send();
    },
  );
}
