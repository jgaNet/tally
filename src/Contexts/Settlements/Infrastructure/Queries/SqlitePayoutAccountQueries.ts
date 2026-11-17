import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import {
  IPayoutAccountQueries,
  PayoutAccountView,
} from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountQueries';
import { createPayoutAccountTables } from '@Contexts/Settlements/Infrastructure/Repositories/SqlitePayoutAccountRepository';

/** The payout account of a member, read from the table the repository keeps. */
export class SqlitePayoutAccountQueries implements IPayoutAccountQueries {
  constructor(private database: SqliteDatabase) {
    createPayoutAccountTables(database);
  }

  async findByOwner(owner: string): Promise<PayoutAccountView | null> {
    const row = this.database.connection
      .prepare('SELECT account_id FROM payout_accounts WHERE owner = ?')
      .get(owner) as { account_id: string } | undefined;
    return row ? { accountId: row.account_id } : null;
  }
}
