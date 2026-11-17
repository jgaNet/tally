import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { Refusal } from '../refusal';
import type { ProviderConfig } from '../settlements/provider';
import { payoutAccountOf, setPayoutAccount } from './payout-accounts';

export function registerPayoutAccountRoutes(app: FastifyInstance, db: Database, provider: ProviderConfig): void {
  app.put<{ Body: { accountId: string } }>(
    '/accounts/me/payout-account',
    {
      schema: {
        body: {
          type: 'object',
          required: ['accountId'],
          properties: { accountId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const account = requireAccount(db, request);
      await setPayoutAccount(db, provider, account.id, request.body.accountId);
      return reply.code(204).send();
    },
  );

  // Only the caller's own payout account is read here: no other member's is.
  app.get(
    '/accounts/me/payout-account',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['accountId'],
            properties: { accountId: { type: 'string' } },
          },
        },
      },
    },
    async request => {
      const account = requireAccount(db, request);
      const accountId = payoutAccountOf(db, account.id);
      if (accountId === undefined) {
        throw new Refusal(404, 'NotFound', 'You have no payout account.');
      }
      return { accountId };
    },
  );
}
