import type { FastifyInstance } from 'fastify';
import type { Database } from '../database';
import { feePolicyOf, setFeePolicy } from '../fee-policy';
import { FEE_BEARERS } from '../fees';
import { requireCaller } from '../http';

/** Only the shape is checked here (a missing or wrongly typed field is `400`); the value is checked by the rules. */
const SET_FEE_POLICY_BODY = {
  type: 'object',
  required: ['borneBy'],
  properties: { borneBy: { type: 'string' } },
};

const FEE_POLICY = {
  type: 'object',
  required: ['borneBy'],
  properties: { borneBy: { enum: [...FEE_BEARERS] } },
};

export function registerFeePolicyRoutes(server: FastifyInstance, db: Database): void {
  // Only a current member of the group reads who bears its provider fee; to anyone else the group does not exist.
  server.get<{ Params: { id: string } }>(
    '/groups/:id/fee-policy',
    { schema: { response: { 200: FEE_POLICY } } },
    async request => {
      const caller = await requireCaller(db, request);
      return await feePolicyOf(db, caller.id, request.params.id);
    },
  );

  // Only the owner of the group decides who bears its provider fee.
  server.put<{ Params: { id: string }; Body: { borneBy: string } }>(
    '/groups/:id/fee-policy',
    { schema: { body: SET_FEE_POLICY_BODY } },
    async (request, reply) => {
      const caller = await requireCaller(db, request);
      await setFeePolicy(db, { groupId: request.params.id, callerId: caller.id, borneBy: request.body.borneBy });
      return reply.code(204).send();
    },
  );
}
