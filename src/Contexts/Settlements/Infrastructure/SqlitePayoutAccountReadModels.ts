import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IPayoutAccountQueries } from '@Contexts/Settlements/Application/Ports/IPayoutAccountQueries';
import { PayoutAccountReadModel } from '@Contexts/Settlements/Application/ReadModel/PayoutAccountReadModel';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

/**
 * The payout accounts' read model, in the application's file. Like the settlements' read models, it is read outside any transaction,
 * so it waits for the one in progress.
 */
export class SqlitePayoutAccountReadModels implements IPayoutAccountQueries {
  constructor(private database: SqliteDatabase) {
    createSettlementsTables(database);
  }

  async findByOwner(ownerId: string): Promise<PayoutAccountReadModel | null> {
    return this.database.exclusive(() => {
      const row = this.database.get<{ account_id: string }>(
        'SELECT account_id FROM payout_accounts WHERE owner = ?',
        ownerId,
      );
      return row ? { accountId: row.account_id } : null;
    });
  }
}
