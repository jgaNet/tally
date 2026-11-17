import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IPayoutAccountStore } from '@Contexts/Settlements/Application/IPayoutAccountStore';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

/**
 * The payout accounts' table (request 16, ADR 11): one row per person, its owner's account id unique, the provider's id of the account
 * the person is paid on, and the version the account is at (`save` bumps it only while it is still at the version it was read at).
 */
export const payoutAccountsTablesSchema = [
  `CREATE TABLE IF NOT EXISTS payout_accounts (
     id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL UNIQUE,
     provider_account_id TEXT NOT NULL,
     version INTEGER NOT NULL
   )`,
];

interface PayoutAccountRow {
  id: string;
  owner_id: string;
  provider_account_id: string;
  version: number;
}

/**
 * The payout accounts in SQLite. `save` stores a new account (version 0) with its first row, and a changed one at its version + 1, each
 * only while the account is still at the version it was read at; otherwise it refuses with a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export class SqlitePayoutAccountStore implements IPayoutAccountStore {
  constructor(private readonly database: SqliteDatabase) {}

  async payoutAccountOf(ownerId: string): Promise<PayoutAccount | undefined> {
    const row = this.database.read(db =>
      db.prepare('SELECT * FROM payout_accounts WHERE owner_id = ?').get(ownerId),
    ) as PayoutAccountRow | undefined;
    return row
      ? PayoutAccount.fromSnapshot({
          id: row.id,
          version: row.version,
          ownerId: row.owner_id,
          providerAccountId: row.provider_account_id,
        })
      : undefined;
  }

  async save(account: PayoutAccount): Promise<void> {
    const writer = this.database.writer;
    const id = account._id.value;
    const { changes } =
      account.version === 0
        ? writer
            .prepare(
              'INSERT OR IGNORE INTO payout_accounts (id, owner_id, provider_account_id, version) VALUES (?, ?, ?, 1)',
            )
            .run(id, account.ownerId, account.providerAccountId)
        : writer
            .prepare('UPDATE payout_accounts SET provider_account_id = ?, version = ? WHERE id = ? AND version = ?')
            .run(account.providerAccountId, account.version + 1, id, account.version);
    if (changes === 0) {
      throw new ConcurrencyConflictException(
        'Settlements',
        'The payout account changed since it was read: read it again',
      );
    }
  }
}
