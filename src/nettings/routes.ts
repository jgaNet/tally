import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { Refusal } from '../refusal';
import { findNetting, netAcross } from './nettings';

const nettingSchema = {
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

export function registerNettingRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Body: { with: string; currency: string } }>(
    '/nettings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['with', 'currency'],
          properties: { with: { type: 'string' }, currency: { type: 'string' } },
        },
        response: {
          201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      const id = await netAcross(db, account.id, request.body.with, request.body.currency);
      return reply.code(201).send({ id });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/nettings/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: nettingSchema },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      // Only the two members it is between read it; anyone else is told it does not exist.
      const netting = await findNetting(db, request.params.id, account.id);
      if (netting === undefined) {
        throw new Refusal(404, 'NotFound', 'There is no such netting.');
      }
      return netting;
    },
  );
}
