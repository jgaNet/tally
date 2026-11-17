import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { assertProviderConfigured, isKnownProviderAccount, type ProviderConfig } from './provider';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/**
 * The provider's id of the account the member is paid on, or `undefined` when the member has none. A read: it
 * changes nothing.
 */
export function payoutAccountOf(db: DatabaseSync, accountId: string): string | undefined {
  const row = db.prepare('SELECT provider_account_id FROM payout_accounts WHERE account_id = ?').get(accountId) as
    { provider_account_id: string } | undefined;
  return row?.provider_account_id;
}

/**
 * Sets the account's payout account to the provider's account `providerAccountId`, replacing the one it had. The
 * provider is asked first, outside any transaction: an account it does not know is refused, and so is any answer
 * other than one that knows it, or none in time. A refused account changes nothing, so the one set before stays.
 */
export async function setPayoutAccount(
  db: DatabaseSync,
  provider: ProviderConfig,
  accountId: string,
  providerAccountId: string,
): Promise<void> {
  assertProviderConfigured(provider);
  if (!(await isKnownProviderAccount(provider, providerAccountId))) {
    throw new Refusal(422, 'UnknownPayoutAccount', 'The payment provider does not know this account.');
  }
  db.prepare(
    `INSERT INTO payout_accounts (account_id, provider_account_id, set_at) VALUES (?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET provider_account_id = excluded.provider_account_id, set_at = excluded.set_at`,
  ).run(accountId, providerAccountId, new Date().toISOString());
}

const payoutAccountSchema = {
  type: 'object',
  required: ['accountId'],
  properties: { accountId: { type: 'string' } },
};

/** A member reads their own payout account; nobody else does, as nobody else can sign in as them. */
export function registerPayoutAccountRoutes(app: FastifyInstance, db: DatabaseSync, provider: ProviderConfig): void {
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
      const accountId = requireCaller(db, request);
      await setPayoutAccount(db, provider, accountId, request.body.accountId);
      return reply.code(204).send();
    },
  );

  app.get('/accounts/me/payout-account', { schema: { response: { 200: payoutAccountSchema } } }, request => {
    const accountId = requireCaller(db, request);
    const providerAccountId = payoutAccountOf(db, accountId);
    if (providerAccountId === undefined) throw new Refusal(404, 'NotFound', 'There is no payout account.');
    return { accountId: providerAccountId };
  });
}
