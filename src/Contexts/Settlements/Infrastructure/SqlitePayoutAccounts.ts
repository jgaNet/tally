import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { IPayoutAccounts } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccounts';

/** The table of the payout accounts: one row per person, holding the provider's id of its account and the version a save checks (request 16). */
export function preparePayoutAccountSchema(connection: DatabaseSync): void {
  connection.exec(
    'CREATE TABLE IF NOT EXISTS payout_accounts (account_id TEXT PRIMARY KEY, provider_account_id TEXT NOT NULL, version INTEGER NOT NULL)',
  );
}

/**
 * The payout accounts' store over SQLite (docs/adr/0016). Its methods run inside a transaction: the use case's. A save of an account read at a
 * version another writer has moved past changes nothing and answers a conflict (CONC-OPTIMISTIC). A person's first account inserts its row:
 * two first accounts at once meet the same check.
 */
export class SqlitePayoutAccounts implements IPayoutAccounts {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(preparePayoutAccountSchema);
  }

  async get(accountId: string): Promise<PayoutAccount> {
    this.database.assertInTransaction();
    const row = this.database.connection
      .prepare('SELECT provider_account_id, version FROM payout_accounts WHERE account_id = ?')
      .get(accountId) as { provider_account_id: string; version: number } | undefined;
    if (!row) return PayoutAccount.fromSnapshot({ accountId, version: 0 });
    return PayoutAccount.fromSnapshot({
      accountId,
      version: Number(row.version),
      providerAccountId: String(row.provider_account_id),
    });
  }

  async save(account: PayoutAccount): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const providerAccountId = account.providerAccountId;
    if (providerAccountId === undefined) return Result.ok(undefined);
    const connection = this.database.connection;
    if (account.version === 0) {
      const { changes } = connection
        .prepare(
          'INSERT INTO payout_accounts (account_id, provider_account_id, version) VALUES (?, ?, ?) ON CONFLICT (account_id) DO NOTHING',
        )
        .run(account.accountId, providerAccountId, 1);
      if (changes === 0) return Result.fail(changedSinceRead());
    } else {
      const { changes } = connection
        .prepare('UPDATE payout_accounts SET provider_account_id = ?, version = ? WHERE account_id = ? AND version = ?')
        .run(providerAccountId, account.version + 1, account.accountId, account.version);
      if (changes === 0) return Result.fail(changedSinceRead());
    }
    return Result.ok(undefined);
  }
}

const changedSinceRead = () =>
  new ConcurrencyConflictException('Settlements', 'The payout account changed since it was read');
