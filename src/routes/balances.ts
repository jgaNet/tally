import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { balancesOfGroup } from '../balances';
import { findGroupOfMember } from '../groups';
import { requireCaller } from '../http';
import { Refusal } from '../refusal';

const BALANCE = {
  type: 'object',
  required: ['memberId', 'balance'],
  properties: { memberId: { type: 'string' }, balance: { type: 'integer' } },
};

export function registerBalanceRoutes(server: FastifyInstance, db: DatabaseSync): void {
  // Only a member of the group reads its balances; to anyone else the group does not exist.
  server.get<{ Params: { id: string } }>(
    '/groups/:id/balances',
    { schema: { response: { 200: { type: 'array', items: BALANCE } } } },
    async request => {
      const caller = requireCaller(db, request);
      if (!findGroupOfMember(db, caller.id, request.params.id)) {
        throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
      }
      return balancesOfGroup(db, request.params.id);
    },
  );
}
