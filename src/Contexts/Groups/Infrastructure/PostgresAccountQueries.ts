import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { prepareAccountsSchema } from '@Contexts/Groups/Infrastructure/PostgresAccountRepository';
import { AccountView, IAccountQueries } from '@Contexts/Groups/Domain/Account/Ports/IAccountQueries';

/** The read side of the accounts over PostgreSQL: one read, taken alone, outside any transaction. */
export class PostgresAccountQueries implements IAccountQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareAccountsSchema);
  }

  async findAccount(id: string): Promise<AccountView | undefined> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<{ id: string; email: string; name: string }>(
        'SELECT id, email, name FROM accounts WHERE id = ?',
        [id],
      );
      return row ? { id: String(row.id), email: String(row.email), name: String(row.name) } : undefined;
    });
  }
}
