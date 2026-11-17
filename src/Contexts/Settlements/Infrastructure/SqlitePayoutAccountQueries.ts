import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { PayoutAccountView } from '@Contexts/Settlements/Domain/PayoutAccount/DTOs';
import { IPayoutAccountQueries } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountQueries';
import { preparePayoutAccountSchema } from '@Contexts/Settlements/Infrastructure/SqlitePayoutAccounts';

/** The read side of the payout accounts, over the same table as their store (request 16). */
export class SqlitePayoutAccountQueries implements IPayoutAccountQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(preparePayoutAccountSchema);
  }

  async findPayoutAccount(accountId: string): Promise<PayoutAccountView | undefined> {
    return this.database.exclusive(() => {
      const row = this.database.connection
        .prepare('SELECT provider_account_id FROM payout_accounts WHERE account_id = ?')
        .get(accountId) as { provider_account_id: string } | undefined;
      return row ? { accountId: String(row.provider_account_id) } : undefined;
    });
  }
}
