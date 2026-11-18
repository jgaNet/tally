import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import {
  IPayoutAccountQueries,
  PayoutAccountView,
} from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountQueries';
import { createPayoutAccountTables } from '@Contexts/Settlements/Infrastructure/Repositories/PostgresPayoutAccountRepository';

/** The payout account of a member, read from the table the repository keeps. */
export class PostgresPayoutAccountQueries implements IPayoutAccountQueries {
  constructor(private database: PostgresDatabase) {
    createPayoutAccountTables(database);
  }

  async findByOwner(owner: string): Promise<PayoutAccountView | null> {
    const row = await this.database.get<{ account_id: string }>(
      'SELECT account_id FROM payout_accounts WHERE owner = ?',
      [owner],
    );
    return row ? { accountId: row.account_id } : null;
  }
}
