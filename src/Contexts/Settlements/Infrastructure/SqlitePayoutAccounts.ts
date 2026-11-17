import { ConcurrencyConflictException } from '@Architecture/Domain';
import { IPayoutAccounts } from '@Contexts/Settlements/Application/IPayoutAccounts';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

import { SettlementsDatabase } from './SettlementsDatabase';

type PayoutAccountRow = { id: string; owner_id: string; account_id: string; version: number };

/**
 * The payout accounts in SQLite (request 16): one row per person. The account's version is checked and stored in one transaction that
 * holds the database's write lock, so of two writers from one version the second is refused and nothing of its change is kept
 * (CONC-OPTIMISTIC).
 */
export class SqlitePayoutAccounts implements IPayoutAccounts {
  constructor(private readonly database: SettlementsDatabase) {}

  async ofOwner(ownerId: string): Promise<PayoutAccount | undefined> {
    const row = this.database.connection
      .prepare('SELECT id, owner_id, account_id, version FROM payout_accounts WHERE owner_id = ?')
      .get(ownerId) as PayoutAccountRow | undefined;
    if (!row) return undefined;
    return PayoutAccount.fromSnapshot({
      id: row.id,
      ownerId: row.owner_id,
      accountId: row.account_id,
      version: row.version,
    });
  }

  async save(account: PayoutAccount): Promise<void> {
    const connection = this.database.connection;
    await this.database.file.transaction(() => {
      const stored = connection
        .prepare('SELECT version FROM payout_accounts WHERE owner_id = ?')
        .get(account.ownerId) as { version: number } | undefined;
      // An account never stored is at version 0; any other is at the version it was stored at.
      if ((stored?.version ?? 0) !== account.version) {
        throw new ConcurrencyConflictException('Settlements', 'The payout account changed since it was read');
      }
      if (stored) {
        connection
          .prepare('UPDATE payout_accounts SET account_id = ?, version = ? WHERE owner_id = ?')
          .run(account.accountId, account.version + 1, account.ownerId);
      } else {
        connection
          .prepare('INSERT INTO payout_accounts (id, owner_id, account_id, version) VALUES (?, ?, ?, ?)')
          .run(account.payoutAccountId, account.ownerId, account.accountId, account.version + 1);
      }
    });
  }
}
