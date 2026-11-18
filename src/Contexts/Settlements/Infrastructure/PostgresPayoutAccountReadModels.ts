import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IPayoutAccountQueries } from '@Contexts/Settlements/Application/Ports/IPayoutAccountQueries';
import { PayoutAccountReadModel } from '@Contexts/Settlements/Application/ReadModel/PayoutAccountReadModel';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

/**
 * The payout accounts' read model, in the application's file. Like the settlements' read models, it is read outside any transaction,
 * so it waits for the one in progress.
 */
export class PostgresPayoutAccountReadModels implements IPayoutAccountQueries {
  constructor(private database: PostgresDatabase) {
    createSettlementsTables(database);
  }

  async findByOwner(ownerId: string): Promise<PayoutAccountReadModel | null> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<{ account_id: string }>(
        'SELECT account_id FROM payout_accounts WHERE owner = ?',
        ownerId,
      );
      return row ? { accountId: row.account_id } : null;
    });
  }
}
