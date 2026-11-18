import type { Database } from '../database';
import { Refusal } from '../refusal';
import type { ProviderConfig } from '../settlements/provider';

/** The provider's id of the account it pays `accountId` on, or `undefined` when none is set. */
export async function payoutAccountOf(db: Database, accountId: string): Promise<string | undefined> {
  const row = await db.row<{ provider_account_id: string }>(
    'SELECT provider_account_id FROM payout_accounts WHERE account_id = ?',
    [accountId],
  );
  return row?.provider_account_id;
}

/**
 * Sets the payout account of `accountId` to `providerAccountId`, the provider's id of an account, once the
 * provider confirms it knows that account. Setting another replaces the one there was.
 *
 * The provider is asked before anything is written. It knows the account when it answers `200 { id }` with
 * that same id; a `404` refuses the account as unknown, and any other answer, or no answer within the
 * provider's timeout, refuses it as not confirmed. A refusal changes nothing.
 */
export async function setPayoutAccount(
  db: Database,
  provider: ProviderConfig,
  accountId: string,
  providerAccountId: string,
): Promise<void> {
  if (provider.url === '') {
    throw new Refusal(409, 'ProviderNotConfigured', 'Payment through the provider is not set up on this server.');
  }
  await confirmProviderAccount(provider, providerAccountId);
  await db.execute(
    `INSERT INTO payout_accounts (account_id, provider_account_id, set_at) VALUES (?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET provider_account_id = excluded.provider_account_id, set_at = excluded.set_at`,
    [accountId, providerAccountId, new Date().toISOString()],
  );
}

const notConfirmed = () =>
  new Refusal(
    409,
    'PayoutAccountNotConfirmed',
    'The payment provider did not confirm the account: nothing was changed. Try again.',
  );

/** `GET {url}/accounts/{id}`: `200 { id }` with the same id confirms the account; `404` says it is unknown. */
async function confirmProviderAccount(provider: ProviderConfig, providerAccountId: string): Promise<void> {
  let answer: { status: number; body: unknown };
  try {
    const response = await fetch(`${provider.url}/accounts/${encodeURIComponent(providerAccountId)}`, {
      // Covers the whole exchange, the answer's body included.
      signal: AbortSignal.timeout(provider.timeoutMs),
    });
    answer = { status: response.status, body: response.status === 200 ? await response.json() : undefined };
  } catch {
    throw notConfirmed();
  }
  if (answer.status === 404) {
    throw new Refusal(422, 'UnknownPayoutAccount', 'The payment provider does not know this account.');
  }
  const body = answer.body as { id?: unknown } | null | undefined;
  if (answer.status !== 200 || typeof body !== 'object' || body === null || body.id !== providerAccountId) {
    throw notConfirmed();
  }
}
