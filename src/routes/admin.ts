import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../database';
import type { Account } from '../accounts';
import { isAdministrator } from '../administrators';
import { adminLogOf } from '../admin-log';
import { requireCaller } from '../http';
import { Refusal } from '../refusal';
import { contestedSettlements, decideContest } from '../settlements';
import { SETTLEMENT } from './settlements';

interface DecisionBody {
  paid: boolean;
}

/** Only the shape is checked here (a missing or wrongly typed field is `400`); the decision is the administrator's. */
const DECISION_BODY = {
  type: 'object',
  required: ['paid'],
  properties: { paid: { type: 'boolean' } },
};

const ADMIN_LOG_ENTRY = {
  type: 'object',
  required: ['id', 'at', 'by', 'action', 'subjectId'],
  properties: {
    id: { type: 'string' },
    at: { type: 'string' },
    by: { type: 'string' },
    action: { enum: ['decided-paid', 'decided-annulled'] },
    subjectId: { type: 'string' },
  },
};

/**
 * The caller, who must be an administrator to read what only administrators read. What only an administrator reads does not
 * exist for anyone else: a signed-in caller who is not one is answered `404`, as the route does not exist. Anyone not signed
 * in is answered `401`, as every route that needs a sign-in is.
 */
async function administratorReading(
  db: Database,
  request: FastifyRequest,
  administrators: ReadonlySet<string>,
): Promise<Account> {
  const caller = await requireCaller(db, request);
  if (!isAdministrator(administrators, caller)) {
    throw new Refusal(404, 'NotFound', `Route ${request.method}:${request.url} not found`);
  }
  return caller;
}

/** The caller, who must be an administrator to decide a contest: anyone else is refused with `403`. */
async function administratorDeciding(
  db: Database,
  request: FastifyRequest,
  administrators: ReadonlySet<string>,
): Promise<Account> {
  const caller = await requireCaller(db, request);
  if (!isAdministrator(administrators, caller)) {
    throw new Refusal(403, 'NotAnAdministrator', 'Only an administrator decides a contested settlement.');
  }
  return caller;
}

export function registerAdminRoutes(server: FastifyInstance, db: Database, administrators: ReadonlySet<string>): void {
  // The settlements contested now, the earliest contested first.
  server.get(
    '/admin/contests',
    { schema: { response: { 200: { type: 'array', items: SETTLEMENT } } } },
    async request => {
      await administratorReading(db, request, administrators);
      return await contestedSettlements(db);
    },
  );

  // The administrator decides a contested settlement: paid when the money arrived, otherwise annulled.
  server.post<{ Params: { id: string }; Body: DecisionBody }>(
    '/admin/settlements/:id/decision',
    { schema: { body: DECISION_BODY } },
    async (request, reply) => {
      const caller = await administratorDeciding(db, request, administrators);
      await decideContest(db, { settlementId: request.params.id, administratorId: caller.id, paid: request.body.paid });
      return reply.code(204).send();
    },
  );

  // The administrators' log, the oldest first.
  server.get(
    '/admin/log',
    { schema: { response: { 200: { type: 'array', items: ADMIN_LOG_ENTRY } } } },
    async request => {
      await administratorReading(db, request, administrators);
      return await adminLogOf(db);
    },
  );
}
