import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { PayoutAccountView } from '@Contexts/Settlements/Domain/PayoutAccount/DTOs';
import { IPayoutAccountQueries } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountQueries';
import { preparePayoutAccountSchema } from '@Contexts/Settlements/Infrastructure/PostgresPayoutAccounts';

/** The read side of the payout accounts, over the same table as their store (request 16). */
export class PostgresPayoutAccountQueries implements IPayoutAccountQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(preparePayoutAccountSchema);
  }

  async findPayoutAccount(accountId: string): Promise<PayoutAccountView | undefined> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<{ provider_account_id: string }>(
        'SELECT provider_account_id FROM payout_accounts WHERE account_id = ?',
        [accountId],
      );
      return row ? { accountId: String(row.provider_account_id) } : undefined;
    });
  }
}
