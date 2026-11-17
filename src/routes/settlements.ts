import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { requireCaller } from '../http';
import { suggestedSettlement } from '../settlements';

const TRANSFER = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'integer' } },
};

export function registerSettlementRoutes(server: FastifyInstance, db: DatabaseSync): void {
  // Only a member of the group reads its suggested settlement; to anyone else the group does not exist.
  server.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    { schema: { response: { 200: { type: 'array', items: TRANSFER } } } },
    async request => {
      const caller = requireCaller(db, request);
      return suggestedSettlement(db, caller.id, request.params.id);
    },
  );
}
