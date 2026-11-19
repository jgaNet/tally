import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { Refusal } from '../refusal';
import { decideContest } from '../settlements/contests';
import { contestedSettlements } from '../settlements/settlements';
import { settlementSchema } from '../settlements/routes';
import { administratorLog } from './log';
import { isAdministrator } from './administrators';

const adminLogEntrySchema = {
  type: 'object',
  required: ['id', 'at', 'by', 'action', 'subjectId'],
  properties: {
    id: { type: 'string' },
    at: { type: 'string' },
    by: { type: 'string' },
    action: { type: 'string', enum: ['decided-paid', 'decided-annulled'] },
    subjectId: { type: 'string' },
  },
};

/**
 * The administrators' routes. What only an administrator reads does not exist for anyone else: it is `404` to a
 * signed-in account that is not one. What only an administrator may do is refused to anyone else with `403`. A
 * request that is not signed in is `401`, as on every route.
 */
export function registerAdminRoutes(app: FastifyInstance, db: Database, administrators: ReadonlySet<string>): void {
  app.get(
    '/admin/contests',
    {
      schema: {
        response: { 200: { type: 'array', items: settlementSchema } },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      if (!isAdministrator(administrators, account)) {
        throw new Refusal(404, 'NotFound', 'There is no such route.');
      }
      return await contestedSettlements(db);
    },
  );

  app.post<{ Params: { id: string }; Body: { paid: boolean } }>(
    '/admin/settlements/:id/decision',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['paid'],
          properties: { paid: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      if (!isAdministrator(administrators, account)) {
        throw new Refusal(403, 'NotAdministrator', 'Only an administrator may decide a contested settlement.');
      }
      await decideContest(db, request.params.id, account.id, request.body.paid);
      return reply.code(204).send();
    },
  );

  app.get(
    '/admin/log',
    {
      schema: {
        response: { 200: { type: 'array', items: adminLogEntrySchema } },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      if (!isAdministrator(administrators, account)) {
        throw new Refusal(404, 'NotFound', 'There is no such route.');
      }
      return await administratorLog(db);
    },
  );
}
