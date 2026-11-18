import type { Querier } from './database';
import { requireKnownAccount, type ProviderConfig } from './provider';
import { Refusal } from './refusal';

/**
 * A member's payout account is the provider's id of the account the provider pays the member on: what a payment to
 * the member is made to. A member has one at most.
 */
interface PayoutAccountRow {
  provider_account_id: string;
}

/**
 * Sets `accountId`, the provider's id of an account, as the payout account of `ownerId`, replacing the one they had.
 * The provider is asked first, outside any transaction, whether it knows the account (see
 * {@link requireKnownAccount}); an account it does not know, or any answer that is not one, refuses the request
 * and keeps nothing. An empty id is refused with `422` before anyone is asked.
 */
export async function setPayoutAccount(
  db: Querier,
  provider: ProviderConfig,
  input: { ownerId: string; accountId: string },
): Promise<void> {
  const { ownerId, accountId } = input;
  if (accountId.length === 0) {
    throw new Refusal(422, 'AccountIdIsInvalid', 'The payout account must have an id.');
  }
  await requireKnownAccount(provider, accountId);
  await db
    .prepare(
      `INSERT INTO payout_accounts (account_id, provider_account_id, set_at) VALUES (?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET provider_account_id = excluded.provider_account_id, set_at = excluded.set_at`,
    )
    .run(ownerId, accountId, new Date().toISOString());
}

/**
 * The provider's id of the payout account of `ownerId`, or `undefined` when they have none. Reading never changes it.
 */
export async function payoutAccountOf(db: Querier, ownerId: string): Promise<string | undefined> {
  const row = await db
    .prepare('SELECT provider_account_id FROM payout_accounts WHERE account_id = ?')
    .get<PayoutAccountRow>(ownerId);
  return row?.provider_account_id;
}
