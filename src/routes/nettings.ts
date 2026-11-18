import type { FastifyInstance } from 'fastify';
import type { Database } from '../database';
import { requireCaller } from '../http';
import { netBetween, nettingOfMember } from '../nettings';

interface NetBody {
  with: string;
  currency: string;
}

/** Only the shape is checked here (a missing or wrongly typed field is `400`); the values are checked by the rules. */
const NET_BODY = {
  type: 'object',
  required: ['with', 'currency'],
  properties: { with: { type: 'string' }, currency: { type: 'string' } },
};

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const NETTING = {
  type: 'object',
  required: ['id', 'by', 'with', 'currency', 'amount', 'settlements'],
  properties: {
    id: { type: 'string' },
    by: { type: 'string' },
    with: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    amount: { type: 'integer', minimum: 1 },
    settlements: { type: 'array', minItems: 2, items: { type: 'string' } },
  },
};

export function registerNettingRoutes(server: FastifyInstance, db: Database): void {
  // The caller nets with `with`; a caller who is not signed in is refused, and a netting names nobody else.
  server.post<{ Body: NetBody }>(
    '/nettings',
    { schema: { body: NET_BODY, response: { 201: ID } } },
    async (request, reply) => {
      const caller = await requireCaller(db, request);
      const id = await netBetween(db, { by: caller.id, with: request.body.with, currency: request.body.currency });
      return reply.code(201).send({ id });
    },
  );

  // Only the two members the netting is between read it; to anyone else it does not exist.
  server.get<{ Params: { id: string } }>('/nettings/:id', { schema: { response: { 200: NETTING } } }, async request => {
    const caller = await requireCaller(db, request);
    return await nettingOfMember(db, caller.id, request.params.id);
  });
}
