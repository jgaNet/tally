import { ConcurrencyConflictException } from '@Architecture/Domain';
import { IPayoutAccounts } from '@Contexts/Settlements/Application/IPayoutAccounts';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

import { SettlementsDatabase } from './SettlementsDatabase';

type PayoutAccountRow = { id: string; owner_id: string; account_id: string; version: number };

/**
 * The payout accounts in PostgreSQL (request 16): one row per person. The account's version is checked and stored in one transaction that
 * takes the database's writers' lock, so of two writers from one version the second is refused and nothing of its change is kept
 * (CONC-OPTIMISTIC).
 */
export class SqlitePayoutAccounts implements IPayoutAccounts {
  constructor(private readonly database: SettlementsDatabase) {}

  async ofOwner(ownerId: string): Promise<PayoutAccount | undefined> {
    const row = await this.database.row<PayoutAccountRow>(
      'SELECT id, owner_id, account_id, version FROM payout_accounts WHERE owner_id = $1',
      [ownerId],
    );
    if (!row) return undefined;
    return PayoutAccount.fromSnapshot({
      id: row.id,
      ownerId: row.owner_id,
      accountId: row.account_id,
      version: row.version,
    });
  }

  async save(account: PayoutAccount): Promise<void> {
    await this.database.transaction(async () => {
      const stored = await this.database.row<{ version: number }>(
        'SELECT version FROM payout_accounts WHERE owner_id = $1',
        [account.ownerId],
      );
      // An account never stored is at version 0; any other is at the version it was stored at.
      if ((stored?.version ?? 0) !== account.version) {
        throw new ConcurrencyConflictException('Settlements', 'The payout account changed since it was read');
      }
      if (stored) {
        await this.database.execute('UPDATE payout_accounts SET account_id = $1, version = $2 WHERE owner_id = $3', [
          account.accountId,
          account.version + 1,
          account.ownerId,
        ]);
      } else {
        await this.database.execute(
          'INSERT INTO payout_accounts (id, owner_id, account_id, version) VALUES ($1, $2, $3, $4)',
          [account.payoutAccountId, account.ownerId, account.accountId, account.version + 1],
        );
      }
    });
  }
}
