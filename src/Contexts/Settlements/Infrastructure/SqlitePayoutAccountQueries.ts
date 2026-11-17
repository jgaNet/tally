import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IPayoutAccountQueries } from '@Contexts/Settlements/Application/Ports/IPayoutAccountQueries';
import { PayoutAccountReadModel } from '@Contexts/Settlements/Application/ReadModel/PayoutAccountReadModel';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/** What a person reads of their payout account, from the SQLite file, outside any transaction. */
export class SqlitePayoutAccountQueries implements IPayoutAccountQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  findByOwner(owner: string): Promise<PayoutAccountReadModel | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT account_id FROM payout_accounts WHERE owner_id = ?').get(owner) as
        { account_id: string } | undefined;
      return row ? { accountId: row.account_id } : null;
    });
  }
}
