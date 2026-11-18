import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IPayoutAccountQueries } from '@Contexts/Settlements/Application/Ports/IPayoutAccountQueries';
import { PayoutAccountReadModel } from '@Contexts/Settlements/Application/ReadModel/PayoutAccountReadModel';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/** What a person reads of their payout account, from the PostgreSQL database, outside any transaction. */
export class PostgresPayoutAccountQueries implements IPayoutAccountQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async findByOwner(owner: string): Promise<PayoutAccountReadModel | null> {
    const row = await this.database.exclusive(connection =>
      connection.row<{ account_id: string }>('SELECT account_id FROM payout_accounts WHERE owner_id = ?', owner),
    );
    return row ? { accountId: row.account_id } : null;
  }
}
