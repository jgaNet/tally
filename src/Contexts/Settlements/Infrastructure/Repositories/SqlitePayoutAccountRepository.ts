import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IPayoutAccountRepository } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountRepository';
import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

/** The table of payout accounts: one row per member, at the version it was last saved at (the check of CONC-OPTIMISTIC). */
export function createPayoutAccountTables(database: SqliteDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS payout_accounts (
      owner TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      version INTEGER NOT NULL
    );
  `);
}

/**
 * The payout accounts over the application's SQLite file, inside the transaction of the command. A first account is inserted at
 * version 1, where a second writer's insert of the same member does nothing; a later one moves the version on only where the
 * stored version is the one the account was read at. Either refusal is a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export class SqlitePayoutAccountRepository implements IPayoutAccountRepository {
  constructor(private database: SqliteDatabase) {
    createPayoutAccountTables(database);
  }

  async findByOwner(owner: string): Promise<PayoutAccount | null> {
    const row = this.database.connection
      .prepare('SELECT id, owner, account_id, version FROM payout_accounts WHERE owner = ?')
      .get(owner) as { id: string; owner: string; account_id: string; version: number } | undefined;
    if (!row) return null;
    return PayoutAccount.fromSnapshot({
      _id: row.id,
      owner: row.owner,
      accountId: row.account_id,
      version: row.version,
    });
  }

  async save(account: PayoutAccount): Promise<IResult> {
    const snapshot = account.toSnapshot();
    if (snapshot.accountId === null)
      throw new Error(`A payout account of ${snapshot.owner} is saved without an account`);
    const connection = this.database.connection;

    if (snapshot.version === 0) {
      const inserted = connection
        .prepare(
          'INSERT INTO payout_accounts (owner, id, account_id, version) VALUES (?, ?, ?, 1) ON CONFLICT (owner) DO NOTHING',
        )
        .run(snapshot.owner, snapshot._id, snapshot.accountId);
      if (inserted.changes === 0) return conflict(snapshot.owner);
    } else {
      const moved = connection
        .prepare('UPDATE payout_accounts SET account_id = ?, version = version + 1 WHERE owner = ? AND version = ?')
        .run(snapshot.accountId, snapshot.owner, snapshot.version);
      if (moved.changes === 0) return conflict(snapshot.owner);
    }
    return Result.ok();
  }
}

function conflict(owner: string): IResult {
  return Result.fail(
    new ConcurrencyConflictException('Settlements', 'The payout account changed since it was read', { owner }),
  );
}
