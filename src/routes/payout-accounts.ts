import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { requireCaller } from '../http';
import type { ProviderConfig } from '../provider';
import { payoutAccountOf, setPayoutAccount } from '../payout-accounts';
import { Refusal } from '../refusal';

interface SetPayoutAccountBody {
  accountId: string;
}

/** Only the shape is checked here (a missing or wrongly typed field is `400`); the value is checked by the rules. */
const SET_PAYOUT_ACCOUNT_BODY = {
  type: 'object',
  required: ['accountId'],
  properties: { accountId: { type: 'string' } },
};

const PAYOUT_ACCOUNT = {
  type: 'object',
  required: ['accountId'],
  properties: { accountId: { type: 'string' } },
};

export function registerPayoutAccountRoutes(server: FastifyInstance, db: DatabaseSync, provider: ProviderConfig): void {
  // Only the caller's own payout account is set and read: nobody else reads it.
  server.put<{ Body: SetPayoutAccountBody }>(
    '/accounts/me/payout-account',
    { schema: { body: SET_PAYOUT_ACCOUNT_BODY } },
    async (request, reply) => {
      const caller = requireCaller(db, request);
      await setPayoutAccount(db, provider, { ownerId: caller.id, accountId: request.body.accountId });
      return reply.code(204).send();
    },
  );

  server.get('/accounts/me/payout-account', { schema: { response: { 200: PAYOUT_ACCOUNT } } }, async request => {
    const caller = requireCaller(db, request);
    const accountId = payoutAccountOf(db, caller.id);
    if (accountId === undefined) throw new Refusal(404, 'PayoutAccountNotFound', 'The member has no payout account.');
    return { accountId };
  });
}
